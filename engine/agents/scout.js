/**
 * scout.js — Prospect Discovery Agent
 *
 * Crawls Google Maps and Yelp for local service businesses matching
 * a client's target niche and states. Writes discovered prospects
 * to Supabase, skipping duplicates via email deduplication.
 *
 * Usage:
 *   CLIENT_ID=<uuid> NICHE=plumbing STATE=TX node agents/scout.js
 *
 * Or import and call runScout() programmatically.
 */

import { chromium } from 'playwright';
import { supabase } from '../lib/supabase.js';
import 'dotenv/config';

const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

// How many prospects to find per source before stopping
const PROSPECTS_PER_SOURCE = 50;

// Delay helpers to avoid rate limiting
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min = 1500, max = 3500) =>
  sleep(min + Math.random() * (max - min));


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the Scout agent for one client.
 * @param {string} clientId  - Supabase client UUID
 * @param {string} niche     - Business type, e.g. "plumbing"
 * @param {string} state     - US state abbreviation, e.g. "TX"
 */
export async function runScout(clientId, niche, state) {
  console.log(`[Scout] Starting — client=${clientId} niche=${niche} state=${state}`);

  // Verify the client exists and is active
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, name, monthly_quota, prospects_sent_this_month, billing_status, is_paused')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) {
    throw new Error(`[Scout] Client not found: ${clientId}`);
  }
  if (client.billing_status !== 'active') {
    throw new Error(`[Scout] Client billing is ${client.billing_status} — aborting.`);
  }
  if (client.is_paused) {
    console.log('[Scout] Client is paused — skipping.');
    return;
  }

  // Calculate how many more prospects we can source this month
  const remaining = client.monthly_quota - client.prospects_sent_this_month;
  if (remaining <= 0) {
    console.log('[Scout] Monthly quota reached — skipping.');
    return;
  }

  const limit = Math.min(remaining, PROSPECTS_PER_SOURCE);
  console.log(`[Scout] Quota remaining: ${remaining}. Targeting ${limit} prospects.`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  let totalSaved = 0;

  try {
    // Run both scrapers and collect results
    const [googleResults, yelpResults] = await Promise.allSettled([
      scrapeGoogleMaps(context, niche, state, limit),
      scrapeYelp(context, niche, state, limit),
    ]);

    const prospects = [
      ...(googleResults.status === 'fulfilled' ? googleResults.value : []),
      ...(yelpResults.status === 'fulfilled' ? yelpResults.value : []),
    ];

    console.log(`[Scout] Scraped ${prospects.length} raw results.`);

    // Save each prospect to Supabase (duplicates are silently skipped)
    for (const prospect of prospects) {
      if (totalSaved >= limit) break;
      const saved = await saveProspect(clientId, prospect, niche);
      if (saved) totalSaved++;
    }

    console.log(`[Scout] Saved ${totalSaved} new prospects for client ${client.name}.`);

    // Log the scouting run as an event
    await logEvent(clientId, null, 'prospect.batch_discovered', {
      niche,
      state,
      total_scraped: prospects.length,
      total_saved: totalSaved,
    });
  } finally {
    await browser.close();
  }

  return { totalSaved };
}


// ─── Google Maps Scraper ──────────────────────────────────────────────────────

/**
 * Searches Google Maps for businesses matching niche + state.
 * Returns an array of raw prospect objects.
 */
async function scrapeGoogleMaps(context, niche, state, limit) {
  const page = await context.newPage();
  const results = [];

  try {
    const query = encodeURIComponent(`${niche} businesses in ${state}`);
    await page.goto(`https://www.google.com/maps/search/${query}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    await randomDelay();

    // Scroll the results panel to load more listings
    const resultsPanel = page.locator('[role="feed"]');
    for (let i = 0; i < 5 && results.length < limit; i++) {
      await resultsPanel.evaluate((el) => (el.scrollTop += 800));
      await randomDelay(1000, 2000);
    }

    // Grab all listing links
    const listingLinks = await page
      .locator('a[href*="/maps/place/"]')
      .evaluateAll((els) => [...new Set(els.map((el) => el.href))]);

    console.log(`[Scout:GoogleMaps] Found ${listingLinks.length} listing links.`);

    for (const link of listingLinks) {
      if (results.length >= limit) break;

      try {
        const detail = await scrapeGoogleMapsListing(context, link);
        if (detail && detail.email) {
          results.push(detail);
        }
        await randomDelay();
      } catch (err) {
        console.warn(`[Scout:GoogleMaps] Failed to scrape ${link}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[Scout:GoogleMaps] Fatal error: ${err.message}`);
  } finally {
    await page.close();
  }

  return results;
}

/**
 * Opens a single Google Maps business listing and extracts contact details.
 */
async function scrapeGoogleMapsListing(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(1000, 2000);

    // Extract visible text fields from the listing
    const name = await page
      .locator('h1.DUwDvf')
      .textContent({ timeout: 5000 })
      .catch(() => null);

    const phone = await page
      .locator('[data-item-id*="phone"] .fontBodyMedium')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    const website = await page
      .locator('[data-item-id="authority"] .fontBodyMedium')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    const address = await page
      .locator('[data-item-id*="address"] .fontBodyMedium')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    // If they have a website, try to find an email there
    let email = null;
    if (website) {
      email = await findEmailOnWebsite(context, normalizeUrl(website));
    }

    if (!name) return null;

    return {
      business_name: name.trim(),
      phone: phone?.trim() || null,
      website: website ? normalizeUrl(website) : null,
      address: address?.trim() || null,
      email,
      source: 'google_maps',
      source_url: url,
    };
  } finally {
    await page.close();
  }
}


// ─── Yelp Scraper ─────────────────────────────────────────────────────────────

/**
 * Searches Yelp for businesses matching niche + state.
 */
async function scrapeYelp(context, niche, state, limit) {
  const page = await context.newPage();
  const results = [];

  try {
    // Yelp search URL format
    const find_desc = encodeURIComponent(niche);
    const find_loc = encodeURIComponent(state);
    const url = `https://www.yelp.com/search?find_desc=${find_desc}&find_loc=${find_loc}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay();

    // Collect all business listing links on the search results page
    const listingLinks = await page
      .locator('a[href*="/biz/"]')
      .evaluateAll((els) =>
        [...new Set(els.map((el) => el.href))].filter(
          (h) => h.includes('yelp.com/biz/') && !h.includes('?')
        )
      );

    console.log(`[Scout:Yelp] Found ${listingLinks.length} listing links.`);

    for (const link of listingLinks) {
      if (results.length >= limit) break;

      try {
        const detail = await scrapeYelpListing(context, link);
        if (detail && detail.email) {
          results.push(detail);
        }
        await randomDelay();
      } catch (err) {
        console.warn(`[Scout:Yelp] Failed to scrape ${link}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[Scout:Yelp] Fatal error: ${err.message}`);
  } finally {
    await page.close();
  }

  return results;
}

/**
 * Opens a single Yelp business page and extracts contact info.
 */
async function scrapeYelpListing(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(1000, 2000);

    const name = await page
      .locator('h1')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    const phone = await page
      .locator('p[class*="phoneNumber"]')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    // Yelp links to external website — grab the href
    const websiteEl = await page
      .locator('a[href*="biz_redir"]')
      .first()
      .getAttribute('href', { timeout: 5000 })
      .catch(() => null);

    // Parse the actual URL out of Yelp's redirect
    let website = null;
    if (websiteEl) {
      const match = websiteEl.match(/url=([^&]+)/);
      if (match) website = decodeURIComponent(match[1]);
    }

    const address = await page
      .locator('address')
      .first()
      .textContent({ timeout: 5000 })
      .catch(() => null);

    let email = null;
    if (website) {
      email = await findEmailOnWebsite(context, normalizeUrl(website));
    }

    if (!name) return null;

    return {
      business_name: name.trim(),
      phone: phone?.trim() || null,
      website: website ? normalizeUrl(website) : null,
      address: address?.replace(/\s+/g, ' ').trim() || null,
      email,
      source: 'yelp',
      source_url: url,
    };
  } finally {
    await page.close();
  }
}


// ─── Email Finder ─────────────────────────────────────────────────────────────

/**
 * Visits a business website and tries to extract an email address.
 * Checks homepage and /contact page.
 */
async function findEmailOnWebsite(context, url) {
  if (!url) return null;

  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // Pages to check, in order
  const pagesToCheck = [url, `${url.replace(/\/$/, '')}/contact`];

  for (const pageUrl of pagesToCheck) {
    const page = await context.newPage();
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const content = await page.content();
      const matches = content.match(emailRegex) || [];

      // Filter out common non-personal emails
      const filtered = matches.filter(
        (e) =>
          !e.includes('example.') &&
          !e.includes('sentry.') &&
          !e.includes('wix.') &&
          !e.includes('wordpress.') &&
          !e.match(/\.(png|jpg|gif|svg|css|js)$/)
      );

      if (filtered.length > 0) {
        return filtered[0].toLowerCase();
      }
    } catch {
      // Page failed to load — move on
    } finally {
      await page.close();
    }
  }

  return null;
}


// ─── Supabase Writer ──────────────────────────────────────────────────────────

/**
 * Saves a single prospect to Supabase.
 * Returns true if inserted, false if it was a duplicate.
 */
async function saveProspect(clientId, prospect, niche) {
  const { city, state, zip } = parseAddressParts(prospect.address);

  const { error } = await supabase.from('prospects').insert({
    client_id: clientId,
    business_name: prospect.business_name,
    owner_name: prospect.owner_name || null,
    email: prospect.email,
    phone: prospect.phone,
    website: prospect.website,
    address: prospect.address,
    city,
    state,
    zip,
    niche,
    source: prospect.source,
    source_url: prospect.source_url,
    status: 'discovered',
  });

  if (error) {
    // Unique constraint violation = duplicate — silently skip
    if (error.code === '23505') {
      console.log(`[Scout] Duplicate skipped: ${prospect.email}`);
      return false;
    }
    console.error(`[Scout] DB insert error: ${error.message}`);
    return false;
  }

  console.log(`[Scout] Saved: ${prospect.business_name} <${prospect.email}>`);
  return true;
}


// ─── Event Logger ─────────────────────────────────────────────────────────────

async function logEvent(clientId, prospectId, type, payload) {
  await supabase.from('events').insert({
    client_id: clientId,
    prospect_id: prospectId,
    type,
    payload,
    source: 'scout',
  });
}


// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Parses city, state, and zip from a US address string.
 * Handles formats like "123 Main St, Houston, TX 77002" or "Houston, TX".
 */
function parseAddressParts(address) {
  if (!address) return { city: null, state: null, zip: null };

  const parts = address.replace(/\s+/g, ' ').trim().split(',').map((s) => s.trim());

  let city = null;
  let state = null;
  let zip = null;

  // Walk from the end — the last comma segment should contain the state (+zip)
  for (let i = parts.length - 1; i >= 0; i--) {
    // Match "TX" or "TX 77002"
    const stateZip = parts[i].match(/^([A-Z]{2})\s*(\d{5})?$/);
    if (stateZip) {
      state = stateZip[1];
      zip = stateZip[2] || null;
      if (i > 0) city = parts[i - 1];
      break;
    }
    // Match "Houston TX 77002" (no comma before state)
    const inline = parts[i].match(/^(.+?)\s+([A-Z]{2})\s+(\d{5})$/);
    if (inline) {
      city = inline[1];
      state = inline[2];
      zip = inline[3];
      break;
    }
  }

  // Last-resort zip extraction
  if (!zip) {
    const m = address.match(/\b(\d{5})\b/);
    if (m) zip = m[1];
  }

  return { city, state, zip };
}

/** Ensure a URL has a protocol prefix. */
function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!url.startsWith('http')) return `https://${url}`;
  return url;
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('scout.js')) {
  const clientId = process.env.CLIENT_ID;
  const niche = process.env.NICHE || 'plumbing';
  const state = process.env.STATE || 'TX';

  if (!clientId) {
    console.error('Usage: CLIENT_ID=<uuid> NICHE=plumbing STATE=TX node agents/scout.js');
    process.exit(1);
  }

  runScout(clientId, niche, state)
    .then((result) => {
      console.log(`[Scout] Done. ${result.totalSaved} new prospects saved.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Scout] Fatal:', err.message);
      process.exit(1);
    });
}
