/**
 * lib/scraper.js — Playwright scraping for the discovery agent
 *
 * Exports:
 *   launchBrowser()             — creates one browser for the full run
 *   scrapeGoogleSerp(...)       — SERP: ads, map pack, organic URLs
 *   scrapeGoogleMaps(...)       — Maps: listing count, avg rating
 *
 * All functions fail gracefully — if Google blocks or times out, they
 * return zero-signal defaults so Claude can still score with partial data.
 */

import { chromium } from 'playwright';

// Known lead aggregator domains — their presence validates demand but signals competition
const AGGREGATORS = [
  'angi.com', 'homeadvisor.com', 'thumbtack.com', 'yelp.com', 'houzz.com',
  'porch.com', 'bark.com', 'networx.com', 'expertise.com', 'topratedlocal.com',
  'angieslist.com', 'taskrabbit.com', 'fixr.com', 'hometalk.com',
  'manta.com', 'yellowpages.com', 'superpages.com', 'homeguide.com',
  'craftjack.com', 'kukun.com', 'yelp.com',
];

// Patterns that suggest a dedicated local lead-gen site (our direct competition)
const LEADGEN_PATTERNS = [
  /^(best|top|find|local|pro|get|hire)\w+\.com$/i,
  /\w+(pros|services|near|local|connect|leads)\.\w+$/i,
];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_SERP = {
  hasAds: false,
  hasMapPack: false,
  organicUrls: [],
  aggregatorCount: 0,
  leadGenCount: 0,
};

const DEFAULT_MAPS = { listingCount: 0, avgRating: null };


/**
 * Launches a Playwright Chromium browser configured for scraping.
 * Caller must call browser.close() when the full run is complete.
 */
export async function launchBrowser() {
  return chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}


/**
 * Scrapes Google SERP for the niche+city query.
 *
 * Returns:
 *   hasAds          — true if Google Ads appear at the top (high commercial intent)
 *   hasMapPack      — true if the Local Pack (map results) appears
 *   organicUrls     — up to 10 organic result URLs/domains
 *   aggregatorCount — how many of those are known aggregator sites
 *   leadGenCount    — how many look like dedicated lead-gen sites
 */
export async function scrapeGoogleSerp(browser, niche, city, state) {
  const query = `${niche} ${city} ${state}`;
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en&gl=us`;
  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Short human-like pause before reading the DOM
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));

    const raw = await page.evaluate(() => {
      // Ads: Google labels sponsored results with [data-text-ad] or shows "Sponsored"
      const hasAds =
        document.querySelectorAll('[data-text-ad]').length > 0 ||
        document.body.innerText.includes('Sponsored');

      // Map pack: local results panel with ratings/addresses
      const hasMapPack =
        document.querySelectorAll(
          '.rllt__details, [data-local-attribute], .VkpGBb, .cXedhc'
        ).length > 0;

      // Organic URLs via <cite> elements — more stable than div class names
      const organicUrls = [];
      document.querySelectorAll('cite').forEach((cite) => {
        const text = cite.innerText.trim();
        if (
          text.length > 4 &&
          !text.includes('google.com') &&
          !organicUrls.includes(text)
        ) {
          organicUrls.push(text);
        }
      });

      return { hasAds, hasMapPack, organicUrls: organicUrls.slice(0, 10) };
    });

    // Classify extracted URLs in Node context (AGGREGATORS not available in browser)
    let aggregatorCount = 0;
    let leadGenCount = 0;

    for (const rawUrl of raw.organicUrls) {
      const urlLower = rawUrl.toLowerCase();
      if (AGGREGATORS.some((a) => urlLower.includes(a))) {
        aggregatorCount++;
      } else if (LEADGEN_PATTERNS.some((p) => p.test(rawUrl.replace(/^https?:\/\//, '')))) {
        leadGenCount++;
      }
    }

    return {
      hasAds: raw.hasAds,
      hasMapPack: raw.hasMapPack,
      organicUrls: raw.organicUrls,
      aggregatorCount,
      leadGenCount,
    };
  } catch (err) {
    console.warn(`[Scraper] SERP failed for "${query}": ${err.message}`);
    return { ...DEFAULT_SERP };
  } finally {
    await page.close();
  }
}


/**
 * Scrapes Google Maps for the niche+city query.
 *
 * Returns:
 *   listingCount  — number of business listing cards visible in the sidebar
 *   avgRating     — mean star rating of visible listings, or null if none found
 */
export async function scrapeGoogleMaps(browser, niche, city, state) {
  const query = `${niche} near ${city}, ${state}`;
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(3000);

    const data = await page.evaluate(() => {
      // Business listing cards in the left sidebar
      const cards = document.querySelectorAll(
        '[data-result-index], .Nv2PK, div[aria-label][role="article"]'
      );
      const listingCount = cards.length;

      // Star ratings — Google uses aria-labels like "4.5 stars" and span.MW4etd
      const ratings = [];

      document.querySelectorAll('[aria-label]').forEach((el) => {
        const label = el.getAttribute('aria-label') || '';
        if (label.includes('star') || label.includes('Star')) {
          const match = label.match(/(\d+\.?\d*)/);
          if (match) ratings.push(parseFloat(match[1]));
        }
      });

      document.querySelectorAll('span.MW4etd').forEach((el) => {
        const val = parseFloat(el.innerText);
        if (!isNaN(val) && val >= 1 && val <= 5) ratings.push(val);
      });

      const avgRating =
        ratings.length > 0
          ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
          : null;

      return { listingCount, avgRating };
    });

    return { listingCount: data.listingCount || 0, avgRating: data.avgRating };
  } catch (err) {
    console.warn(`[Scraper] Maps failed for "${query}": ${err.message}`);
    return { ...DEFAULT_MAPS };
  } finally {
    await page.close();
  }
}
