/**
 * agents/discovery.js — Opportunity Scoring Agent
 *
 * For each niche + city combination:
 *   1. Scrapes Google SERP and Google Maps for live signals
 *   2. Calls Claude API to score the opportunity (0-100)
 *   3. Writes results to the Supabase `opportunities` table
 *
 * After all seed combos are scored, asks Claude to suggest additional
 * cities beyond the seed list and scores those too (dynamic expansion).
 *
 * Runs in ALL inbound modes — discovery is always allowed.
 * Nothing gets built. No side effects beyond writing to `opportunities`.
 *
 * Usage:
 *   node agents/discovery.js
 *   or: import { runDiscovery } from './discovery.js'
 */

import { supabase } from '../lib/supabase.js';
import { launchBrowser, scrapeGoogleSerp, scrapeGoogleMaps } from '../lib/scraper.js';
import { scoreOpportunity, suggestAdditionalCities } from '../lib/scorer.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pause between each scrape pair — keeps us under Google rate limits
const SCRAPE_DELAY_MS = 4000;

// Skip re-scoring an opportunity scored within this many days
const RESCORE_THRESHOLD_DAYS = 30;


// ─── Config loader ────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = join(__dirname, '..', 'config', 'niches-cities.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}


// ─── Mode check ───────────────────────────────────────────────────────────────

async function getMode() {
  const { data, error } = await supabase
    .from('inbound_mode')
    .select('mode, score_threshold')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`[Discovery] Cannot read inbound_mode: ${error.message}`);
  return data;
}


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Runs the full discovery cycle.
 * Returns a summary object with counts and top opportunities.
 */
export async function runDiscovery() {
  const currentDate = new Date().toISOString().slice(0, 10);
  console.log(`[Discovery] Starting run — ${currentDate}`);

  const config = loadConfig();
  const mode = await getMode();
  console.log(`[Discovery] Mode: ${mode.mode} | Score threshold: ${mode.score_threshold}`);
  // Discovery runs regardless of mode — no gate needed here

  const browser = await launchBrowser();
  const allResults = [];

  try {
    // ── Phase 1: Score all seed niche × city combinations ──────────────────
    const totalSeedCombos = config.niches.length * config.seed_cities.length;
    console.log(`[Discovery] Phase 1: scoring ${totalSeedCombos} seed combos (${config.niches.length} niches × ${config.seed_cities.length} cities)`);

    for (const cityConfig of config.seed_cities) {
      for (const nicheConfig of config.niches) {
        const result = await scoreCombo(browser, nicheConfig, cityConfig, true, currentDate);
        if (result) allResults.push(result);
        await sleep(SCRAPE_DELAY_MS);
      }
    }

    // ── Phase 2: Ask Claude to suggest additional cities ───────────────────
    console.log('[Discovery] Phase 2: requesting city expansion from Claude...');
    const suggestedCities = await suggestAdditionalCities(allResults, currentDate);
    console.log(`[Discovery] Claude suggested ${suggestedCities.length} additional cities.`);

    if (suggestedCities.length > 0) {
      console.log('[Discovery] Phase 2: scoring expanded cities...');
      for (const cityMeta of suggestedCities) {
        for (const nicheConfig of config.niches) {
          const result = await scoreCombo(browser, nicheConfig, cityMeta, false, currentDate);
          if (result) allResults.push(result);
          await sleep(SCRAPE_DELAY_MS);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const scored = allResults.filter((r) => r.score !== null);
  const topOpportunities = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  console.log(`\n[Discovery] ── Run complete ─────────────────────────────`);
  console.log(`[Discovery] Total combos processed : ${allResults.length}`);
  console.log(`[Discovery] Successfully scored    : ${scored.length}`);
  console.log(`[Discovery] Skipped (recent score) : ${allResults.length - scored.length}`);
  console.log(`[Discovery] Top 10 opportunities:`);
  topOpportunities.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.niche.padEnd(28)} ${r.city}, ${r.state}  →  ${r.score}/100`);
  });

  return {
    total: allResults.length,
    scored: scored.length,
    topOpportunities,
  };
}


// ─── Score one niche+city combo ───────────────────────────────────────────────

/**
 * Scrapes signals, calls Claude to score, upserts to Supabase.
 * Returns { niche, city, state, score } or null on hard failure.
 */
async function scoreCombo(browser, nicheConfig, cityConfig, isSeedCity, currentDate) {
  const niche = nicheConfig.name;
  const { city, state } = cityConfig;

  // Skip if scored recently enough
  const { data: existing } = await supabase
    .from('opportunities')
    .select('id, score, scored_at, status')
    .eq('niche', niche)
    .eq('city', city)
    .eq('state', state)
    .maybeSingle();

  if (existing?.scored_at) {
    const daysSince = (Date.now() - new Date(existing.scored_at).getTime()) / 86400000;
    if (daysSince < RESCORE_THRESHOLD_DAYS) {
      console.log(`[Discovery] Skip (scored ${Math.round(daysSince)}d ago): ${niche} — ${city}, ${state}`);
      return { niche, city, state, score: existing.score };
    }
  }

  console.log(`[Discovery] Scoring: ${niche} — ${city}, ${state}`);

  // Scrape sequentially to avoid parallel requests to Google
  const serpData = await scrapeGoogleSerp(browser, niche, city, state);
  await sleep(1500);
  const mapsData = await scrapeGoogleMaps(browser, niche, city, state);

  // Score with Claude
  const { score, breakdown, rationale, greenFlags, redFlags } = await scoreOpportunity({
    niche,
    city,
    state,
    serpData,
    mapsData,
    nicheConfig,
    cityConfig,
    currentDate,
  });

  if (score === null) {
    console.warn(`[Discovery] Scoring returned null for ${niche} — ${city}, ${state}`);
    return null;
  }

  // Upsert to Supabase (update if the unique niche+city+state exists)
  const record = {
    niche,
    city,
    state,
    score,
    scoring_rationale: rationale,
    score_breakdown: breakdown,
    scored_at: new Date().toISOString(),
    maps_listing_count: mapsData.listingCount,
    maps_avg_rating: mapsData.avgRating,
    serp_has_ads: serpData.hasAds,
    serp_has_map_pack: serpData.hasMapPack,
    serp_aggregator_count: serpData.aggregatorCount,
    serp_leadgen_count: serpData.leadGenCount,
    serp_snapshot: { organicUrls: serpData.organicUrls },
    is_seed_city: isSeedCity,
    suggested_by: isSeedCity ? 'seed' : 'claude',
    status: existing ? existing.status : 'discovered',
    // Preserve existing approval/rejection status if the row already exists
  };

  const { error: upsertError } = await supabase
    .from('opportunities')
    .upsert(record, { onConflict: 'niche,city,state' });

  if (upsertError) {
    console.error(`[Discovery] DB upsert failed for ${niche} — ${city}: ${upsertError.message}`);
    return null;
  }

  const flag = score >= 75 ? '🔥' : score >= 60 ? '✓' : '–';
  console.log(`[Discovery] ${flag} ${niche} — ${city}, ${state}: ${score}/100`);
  return { niche, city, state, score };
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('discovery.js')) {
  runDiscovery()
    .then((summary) => {
      console.log(`\n[Discovery] Done. ${summary.scored}/${summary.total} combos scored.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Discovery] Fatal:', err.message);
      process.exit(1);
    });
}
