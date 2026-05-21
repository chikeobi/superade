/**
 * agents/scout-b2c.js — B2C Prospect Discovery Agent
 * Strategy: geo-demographic (TruePeopleSearch → BatchData skip trace)
 * Niches: dentist, med spa, financial advisor, consultant
 *
 * Usage:
 *   CLIENT_ID=<uuid> NICHE=dentist STATE=TX node agents/scout-b2c.js
 *   CLIENT_ID=<uuid> NICHE="med spa" ZIP=77002 MILES=25 node agents/scout-b2c.js
 */

import { chromium } from 'playwright';
import { supabase } from '../lib/supabase.js';
import 'dotenv/config';

const HEADLESS            = process.env.PLAYWRIGHT_HEADLESS !== 'false';
const BATCH_DATA_KEY      = process.env.BATCH_DATA_API_KEY;
const SKIP_TRACE_URL      = 'https://api.batchdata.com/api/v1/property/skip-trace';
const PROSPECTS_PER_RUN   = 50;
const SKIP_TRACE_BATCH_SZ = 20;

const sleep       = (ms) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 1500, max = 3500) => sleep(min + Math.random() * (max - min));


// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runScoutB2C(clientId, niche, state, cityTarget = null) {
  if (!BATCH_DATA_KEY) throw new Error('[Scout-B2C] BATCH_DATA_API_KEY not set in .env');

  const locationLabel = cityTarget ? `ZIP ${cityTarget.zip} (${cityTarget.miles} mi)` : state;
  console.log(`[Scout-B2C] Starting — client=${clientId} niche=${niche} location=${locationLabel}`);

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, name, monthly_quota, prospects_sent_this_month, billing_status, is_paused')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) throw new Error(`[Scout-B2C] Client not found: ${clientId}`);
  if (client.billing_status !== 'active') throw new Error(`[Scout-B2C] Billing is ${client.billing_status} — aborting.`);
  if (client.is_paused) { console.log('[Scout-B2C] Client paused — skipping.'); return; }

  const remaining = client.monthly_quota - client.prospects_sent_this_month;
  if (remaining <= 0) { console.log('[Scout-B2C] Monthly quota reached — skipping.'); return; }

  const limit          = Math.min(remaining, PROSPECTS_PER_RUN);
  const searchLocation = cityTarget ? cityTarget.zip : state;

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  let totalSaved = 0;

  try {
    // Step 1: scrape people + addresses from TruePeopleSearch
    const rawLeads = await scrapeTruePeopleSearch(context, searchLocation, limit);
    console.log(`[Scout-B2C] TruePeopleSearch: ${rawLeads.length} raw leads.`);
    if (!rawLeads.length) return { totalSaved: 0 };

    // Step 2: skip trace through BatchData to get email + phone
    const enriched = await batchSkipTrace(rawLeads);
    console.log(`[Scout-B2C] BatchData: ${enriched.length} leads with contact info.`);

    // Step 3: save to Supabase
    for (const lead of enriched) {
      if (totalSaved >= limit) break;
      const saved = await saveProspect(clientId, lead, niche);
      if (saved) totalSaved++;
    }

    await supabase.from('events').insert({
      client_id: clientId, type: 'prospect.batch_discovered', source: 'scout-b2c',
      payload: {
        niche, strategy: 'geo-demographic',
        total_scraped: rawLeads.length, total_enriched: enriched.length, total_saved: totalSaved,
        ...(cityTarget ? { zip: cityTarget.zip, miles: cityTarget.miles } : { state }),
      },
    });
  } finally {
    await browser.close();
  }

  console.log(`[Scout-B2C] Done. ${totalSaved} new prospects saved for ${client.name}.`);
  return { totalSaved };
}


// ─── TruePeopleSearch Scraper ─────────────────────────────────────────────────

async function scrapeTruePeopleSearch(context, location, limit) {
  const page  = await context.newPage();
  const leads = [];

  try {
    const url = `https://www.truepeoplesearch.com/results?citystatezip=${encodeURIComponent(location)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay();

    let pageNum = 1;

    while (leads.length < limit && pageNum <= 5) {
      // Each person result card
      const cards = await page.locator('[data-link-to-details]').all();
      if (!cards.length) break;

      for (const card of cards) {
        if (leads.length >= limit) break;
        try {
          const nameRaw = await card.locator('.h4, h4, [class*="name"]').first()
            .textContent({ timeout: 3000 }).catch(() => null);
          if (!nameRaw) continue;
          const nameParts = parseNameParts(nameRaw.trim());
          if (!nameParts) continue;

          const addrTexts = await card
            .locator('.link-to-details, [class*="addr"], address').allTextContents().catch(() => []);
          const parsed = parseAddress(addrTexts.join(' '));
          if (!parsed.street || !parsed.state) continue;

          leads.push({ ...nameParts, ...parsed });
        } catch { /* skip malformed card */ }
      }

      const nextBtn = page.locator('a[aria-label="Next"], .pagination-next, a:has-text("Next")').first();
      const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (!hasNext || leads.length >= limit) break;

      await nextBtn.click();
      await page.waitForLoadState('domcontentloaded');
      await randomDelay();
      pageNum++;
    }
  } catch (err) {
    console.error(`[Scout-B2C:TPS] Error: ${err.message}`);
  } finally {
    await page.close();
  }

  return leads;
}


// ─── BatchData Skip Trace ─────────────────────────────────────────────────────

async function batchSkipTrace(leads) {
  const enriched = [];

  for (let i = 0; i < leads.length; i += SKIP_TRACE_BATCH_SZ) {
    const chunk = leads.slice(i, i + SKIP_TRACE_BATCH_SZ);

    try {
      const res = await fetch(SKIP_TRACE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BATCH_DATA_KEY}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          requests: chunk.map(l => ({
            firstName: l.firstName,
            lastName:  l.lastName,
            address: { street: l.street, city: l.city || '', state: l.state || '', zip: l.zip || '' },
          })),
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        console.error(`[Scout-B2C:BatchData] HTTP ${res.status}: ${txt}`);
        continue;
      }

      const data = await res.json();

      // Log raw shape on first batch to confirm response format
      if (i === 0) console.log('[Scout-B2C:BatchData] Sample:', JSON.stringify(data).slice(0, 500));

      // Normalise: results may be an array or an index-keyed object
      const results = Array.isArray(data.results)
        ? data.results
        : data.results
          ? Object.values(data.results)
          : data.data || [];

      results.forEach((result, idx) => {
        const persons = result.persons || result.data?.persons || (Array.isArray(result) ? result : []);
        const person  = persons[0];
        if (!person) return;
        const email = extractFirst(person.emails || person.emailAddresses || [], 'email', 'address');
        const phone = extractFirst(person.phones || person.phoneNumbers   || [], 'number', 'phone');
        if (!email) return;
        enriched.push({ ...chunk[idx], email: email.toLowerCase(), phone: phone || null });
      });
    } catch (err) {
      console.error(`[Scout-B2C:BatchData] Batch error: ${err.message}`);
    }

    if (i + SKIP_TRACE_BATCH_SZ < leads.length) await sleep(1000);
  }

  return enriched;
}


// ─── Supabase Writer ──────────────────────────────────────────────────────────

async function saveProspect(clientId, lead, niche) {
  const fullName = `${lead.firstName} ${lead.lastName}`.trim();
  const { error } = await supabase.from('prospects').insert({
    client_id: clientId, business_name: fullName, owner_name: fullName,
    email: lead.email, phone: lead.phone, address: lead.street,
    city: lead.city || null, state: lead.state || null, zip: lead.zip || null,
    niche, source: 'truepeoplesearch', status: 'discovered',
  });

  if (error) {
    if (error.code === '23505') {
      console.log(`[Scout-B2C] Duplicate skipped: ${lead.email}`);
      return false;
    }
    console.error(`[Scout-B2C] DB insert error: ${error.message}`);
    return false;
  }

  console.log(`[Scout-B2C] Saved: ${fullName} <${lead.email}>`);
  return true;
}


// ─── Utilities ────────────────────────────────────────────────────────────────

function parseNameParts(fullName) {
  const parts = fullName.replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function parseAddress(raw) {
  if (!raw) return {};
  const text = raw.replace(/\s+/g, ' ').trim();
  const m1 = text.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s*(\d{5})?/);
  if (m1) return { street: m1[1].trim(), city: m1[2].trim(), state: m1[3], zip: m1[4] || null };
  const m2 = text.match(/^(.+?)\s+([A-Z][a-z].+?)\s+([A-Z]{2})\s+(\d{5})$/);
  if (m2) return { street: m2[1].trim(), city: m2[2].trim(), state: m2[3], zip: m2[4] };
  return {};
}

function extractFirst(arr, ...keys) {
  if (!arr?.length) return null;
  const item = arr[0];
  if (typeof item === 'string') return item || null;
  for (const k of keys) { if (item[k]) return item[k]; }
  return null;
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('scout-b2c.js')) {
  const clientId  = process.env.CLIENT_ID;
  const niche     = process.env.NICHE || 'dentist';
  const state     = process.env.STATE || null;
  const zip       = process.env.ZIP   || null;
  const miles     = parseInt(process.env.MILES || '25', 10);
  const cityTarget = zip ? { zip, miles } : null;

  if (!clientId) {
    console.error('Usage: CLIENT_ID=<uuid> NICHE=dentist STATE=TX node agents/scout-b2c.js');
    console.error('       CLIENT_ID=<uuid> NICHE="med spa" ZIP=77002 MILES=25 node agents/scout-b2c.js');
    process.exit(1);
  }
  if (!state && !zip) {
    console.error('Provide STATE or ZIP (with optional MILES) to set the search location.');
    process.exit(1);
  }

  runScoutB2C(clientId, niche, state, cityTarget)
    .then(r => { console.log(`[Scout-B2C] Done. ${r?.totalSaved ?? 0} saved.`); process.exit(0); })
    .catch(err => { console.error('[Scout-B2C] Fatal:', err.message); process.exit(1); });
}
