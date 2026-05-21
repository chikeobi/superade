/**
 * agents/optimizer.js — monitors live site performance and surfaces recommendations
 *
 * Checks every live site and flags:
 *   - Sites live > STALE_DAYS with zero leads → candidate for rebuild or pause
 *   - Niches with high lead rates → candidates for city expansion
 *   - Sites with leads → calculates revenue per site for ROI tracking
 *
 * Saves a report to Supabase (inbound_mode.last_optimizer_report jsonb)
 * and prints a human-readable summary.
 *
 * Run: node scripts/run-optimizer.js
 */

import { supabase } from '../lib/supabase.js';

const STALE_DAYS = 30; // days live with 0 leads before flagging

// ─── Fetch all live sites with lead counts ────────────────────────────────────

async function fetchSiteStats() {
  const { data: sites, error } = await supabase
    .from('generated_sites')
    .select(`
      id, site_path, status, created_at, monthly_visits, total_leads,
      opportunities(niche, city, state, score)
    `)
    .eq('status', 'live')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to fetch sites: ${error.message}`);

  // Pull lead counts + revenue per site from inbound_leads
  const { data: leadAgg } = await supabase
    .from('inbound_leads')
    .select('site_id, revenue, status');

  const leadsBySite = {};
  for (const l of leadAgg || []) {
    if (!leadsBySite[l.site_id]) leadsBySite[l.site_id] = { total: 0, revenue: 0 };
    leadsBySite[l.site_id].total++;
    if (l.revenue) leadsBySite[l.site_id].revenue += parseFloat(l.revenue);
  }

  return (sites || []).map(s => ({
    ...s,
    leadCount: leadsBySite[s.id]?.total || 0,
    revenue:   leadsBySite[s.id]?.revenue || 0,
  }));
}

// ─── Stale site detection ─────────────────────────────────────────────────────

function detectStaleSites(sites) {
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  return sites.filter(s => {
    const liveDate = new Date(s.created_at).getTime();
    return liveDate < cutoff && s.leadCount === 0;
  });
}

// ─── Top performing niches ────────────────────────────────────────────────────

function rankNiches(sites) {
  const byNiche = {};
  for (const s of sites) {
    const niche = s.opportunities?.niche || 'Unknown';
    if (!byNiche[niche]) byNiche[niche] = { sites: 0, leads: 0, revenue: 0 };
    byNiche[niche].sites++;
    byNiche[niche].leads   += s.leadCount;
    byNiche[niche].revenue += s.revenue;
  }
  return Object.entries(byNiche)
    .map(([niche, stats]) => ({ niche, ...stats, leadsPerSite: stats.leads / stats.sites }))
    .sort((a, b) => b.leadsPerSite - a.leadsPerSite);
}

// ─── Top performing cities ────────────────────────────────────────────────────

function rankCities(sites) {
  const byCity = {};
  for (const s of sites) {
    const opp  = s.opportunities || {};
    const key  = `${opp.city}, ${opp.state}`;
    if (!byCity[key]) byCity[key] = { sites: 0, leads: 0, revenue: 0 };
    byCity[key].sites++;
    byCity[key].leads   += s.leadCount;
    byCity[key].revenue += s.revenue;
  }
  return Object.entries(byCity)
    .map(([city, stats]) => ({ city, ...stats, leadsPerSite: stats.leads / stats.sites }))
    .sort((a, b) => b.leadsPerSite - a.leadsPerSite);
}

// ─── Recommendations ──────────────────────────────────────────────────────────

function buildRecommendations(staleSites, nicheRanks, cityRanks, totalSites) {
  const recs = [];

  if (staleSites.length > 0) {
    recs.push({
      type: 'stale_sites',
      priority: 'high',
      message: `${staleSites.length} site(s) have been live ${STALE_DAYS}+ days with zero leads.`,
      action: 'Consider pausing and rebuilding with different copy, or verify site is reachable.',
      sites: staleSites.map(s => s.site_path),
    });
  }

  const topNiche = nicheRanks[0];
  if (topNiche && topNiche.leadsPerSite > 0) {
    recs.push({
      type: 'expand_niche',
      priority: 'medium',
      message: `"${topNiche.niche}" is your top-converting niche (${topNiche.leadsPerSite.toFixed(2)} leads/site).`,
      action: `Approve more "${topNiche.niche}" opportunities in new cities to scale revenue.`,
    });
  }

  const bottomNiche = nicheRanks[nicheRanks.length - 1];
  if (bottomNiche && bottomNiche.leadsPerSite === 0 && bottomNiche.sites >= 3) {
    recs.push({
      type: 'pause_niche',
      priority: 'medium',
      message: `"${bottomNiche.niche}" has 0 leads across ${bottomNiche.sites} sites.`,
      action: 'Consider pausing new builds in this niche until you investigate demand.',
    });
  }

  const topCity = cityRanks[0];
  if (topCity && topCity.leadsPerSite > 0) {
    recs.push({
      type: 'expand_city',
      priority: 'low',
      message: `${topCity.city} is your highest-converting city (${topCity.leadsPerSite.toFixed(2)} leads/site).`,
      action: `Approve more niches in ${topCity.city} to maximize returns from this market.`,
    });
  }

  return recs;
}

// ─── Print report ─────────────────────────────────────────────────────────────

function printReport(report) {
  const { summary, staleSites, nicheRanks, cityRanks, recommendations } = report;

  console.log('\n═══════════════════════════════════════════');
  console.log('  INBOUND OPTIMIZER REPORT');
  console.log(`  Generated: ${new Date().toLocaleString()}`);
  console.log('═══════════════════════════════════════════\n');

  console.log(`SUMMARY`);
  console.log(`  Live sites:    ${summary.liveSites}`);
  console.log(`  Total leads:   ${summary.totalLeads}`);
  console.log(`  Total revenue: $${summary.totalRevenue.toFixed(2)}`);
  console.log(`  Stale sites:   ${summary.staleSiteCount}\n`);

  console.log('TOP NICHES (by leads/site)');
  nicheRanks.slice(0, 5).forEach(n =>
    console.log(`  ${n.niche.padEnd(28)} ${n.leadsPerSite.toFixed(2)} leads/site  $${n.revenue.toFixed(0)} revenue`)
  );

  console.log('\nTOP CITIES (by leads/site)');
  cityRanks.slice(0, 5).forEach(c =>
    console.log(`  ${c.city.padEnd(28)} ${c.leadsPerSite.toFixed(2)} leads/site  $${c.revenue.toFixed(0)} revenue`)
  );

  if (recommendations.length) {
    console.log('\nRECOMMENDATIONS');
    recommendations.forEach((r, i) =>
      console.log(`  ${i + 1}. [${r.priority.toUpperCase()}] ${r.message}\n     → ${r.action}`)
    );
  }

  console.log('\n═══════════════════════════════════════════\n');
}

// ─── Main run ─────────────────────────────────────────────────────────────────

export async function runOptimizer() {
  console.log('[optimizer] Analyzing live sites...');

  const sites      = await fetchSiteStats();
  const staleSites = detectStaleSites(sites);
  const nicheRanks = rankNiches(sites);
  const cityRanks  = rankCities(sites);

  const totalLeads   = sites.reduce((s, x) => s + x.leadCount, 0);
  const totalRevenue = sites.reduce((s, x) => s + x.revenue, 0);

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      liveSites:      sites.length,
      totalLeads,
      totalRevenue,
      staleSiteCount: staleSites.length,
    },
    staleSites: staleSites.map(s => ({ slug: s.site_path, daysLive: Math.floor((Date.now() - new Date(s.created_at)) / 86400000) })),
    nicheRanks,
    cityRanks,
    recommendations: buildRecommendations(staleSites, nicheRanks, cityRanks, sites.length),
  };

  printReport(report);

  // Persist to Supabase for the admin dashboard
  await supabase
    .from('inbound_mode')
    .update({ last_optimizer_report: report })
    .eq('id', 1);

  return report;
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (process.argv[1].endsWith('optimizer.js')) {
  runOptimizer()
    .then(() => process.exit(0))
    .catch(err => { console.error('[optimizer] Fatal:', err); process.exit(1); });
}
