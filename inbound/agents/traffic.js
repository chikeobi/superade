/**
 * agents/traffic.js — SEO signal submission for generated lead-gen sites
 *
 * For each live site:
 *   1. Writes a sitemap.xml to the site directory
 *   2. Pings Google and Bing with the sitemap URL
 *   3. Logs manual GBP setup steps (cannot be automated without verification)
 *
 * Run: node scripts/run-traffic.js
 *
 * ENV vars:
 *   SITE_BASE_URL — public base URL, e.g. https://leads.superade.com
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../lib/supabase.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SITES_DIR   = path.resolve(__dirname, '../sites');
const PING_DELAY  = 2000; // ms between pings to be polite

// ─── Sitemap writer ───────────────────────────────────────────────────────────

function writeSitemap(slug, baseUrl) {
  const siteDir  = path.join(SITES_DIR, slug);
  const sitemapPath = path.join(siteDir, 'sitemap.xml');

  if (!fs.existsSync(siteDir)) return null;

  const now = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/sites/${slug}/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>`;

  fs.writeFileSync(sitemapPath, xml, 'utf8');
  return `${baseUrl}/sites/${slug}/sitemap.xml`;
}

// ─── Search engine pings ──────────────────────────────────────────────────────

async function pingSearchEngines(sitemapUrl) {
  const pings = [
    `https://www.google.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
    `https://www.bing.com/ping?sitemap=${encodeURIComponent(sitemapUrl)}`,
  ];

  const results = [];
  for (const url of pings) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      results.push({ url, status: res.status, ok: res.ok });
    } catch (err) {
      results.push({ url, status: null, ok: false, error: err.message });
    }
  }
  return results;
}

// ─── GBP setup instructions ───────────────────────────────────────────────────
// GBP requires phone/postcard verification — cannot be automated.

function logGBPSteps(opp, slug, baseUrl) {
  console.log(`\n[traffic] GBP setup for: ${opp.niche} — ${opp.city}, ${opp.state}`);
  console.log(`  1. Go to business.google.com → Add Business`);
  console.log(`  2. Category: ${opp.niche}`);
  console.log(`  3. Service area: ${opp.city}, ${opp.state}`);
  console.log(`  4. Website: ${baseUrl}/sites/${slug}/`);
  console.log(`  5. Complete phone/postcard verification`);
}

// ─── Process one site ─────────────────────────────────────────────────────────

async function processSite(site, baseUrl) {
  const slug = site.site_path;
  const opp  = site.opportunities || {};

  console.log(`[traffic] Processing: ${slug}`);

  const sitemapUrl = writeSitemap(slug, baseUrl);
  if (!sitemapUrl) {
    console.log(`[traffic] Site directory not found for ${slug} — skipping`);
    return { slug, sitemap: false, pinged: false };
  }
  console.log(`[traffic] Sitemap written: ${sitemapUrl}`);

  const pingResults = await pingSearchEngines(sitemapUrl);
  for (const r of pingResults) {
    const engine = r.url.includes('google') ? 'Google' : 'Bing';
    console.log(`[traffic] ${engine} ping: ${r.ok ? 'OK' : `FAILED (${r.status || r.error})`}`);
  }

  logGBPSteps(opp, slug, baseUrl);

  // Mark site as having received traffic submission
  await supabase
    .from('generated_sites')
    .update({ status: 'live' })
    .eq('id', site.id);

  return { slug, sitemap: true, pinged: pingResults.some(r => r.ok) };
}

// ─── Main run ─────────────────────────────────────────────────────────────────

export async function runTraffic() {
  const baseUrl = (process.env.SITE_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
  console.log(`[traffic] Starting. Base URL: ${baseUrl}`);

  const { data: sites, error } = await supabase
    .from('generated_sites')
    .select('id, site_path, opportunities(niche, city, state)')
    .eq('status', 'live')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch sites: ${error.message}`);

  if (!sites?.length) {
    console.log('[traffic] No live sites found.');
    return { processed: 0 };
  }

  console.log(`[traffic] Found ${sites.length} live sites`);
  let processed = 0;

  for (let i = 0; i < sites.length; i++) {
    try {
      await processSite(sites[i], baseUrl);
      processed++;
    } catch (err) {
      console.error(`[traffic] Error for ${sites[i].site_path}:`, err.message);
    }
    if (i < sites.length - 1) await new Promise(r => setTimeout(r, PING_DELAY));
  }

  console.log(`[traffic] Done. Processed: ${processed}/${sites.length}`);
  return { processed };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (process.argv[1].endsWith('traffic.js')) {
  runTraffic()
    .then(() => process.exit(0))
    .catch(err => { console.error('[traffic] Fatal:', err); process.exit(1); });
}
