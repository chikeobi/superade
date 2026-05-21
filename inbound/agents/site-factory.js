/**
 * agents/site-factory.js — builds static HTML lead-gen sites from approved opportunities
 *
 * Flow:
 *   1. Read all opportunities with status='approved' and no linked site
 *   2. Check inbound_mode — only run if mode allows building (not discovery_only)
 *   3. For each opportunity: generate content → build HTML files → save to generated_sites
 *   4. Update opportunity.status = 'live' and link site_id
 *
 * Run: node scripts/run-site-factory.js
 */

import { supabase } from '../lib/supabase.js';
import { generateSiteContent } from '../lib/site-content.js';
import { buildSiteFiles, siteSlug } from '../lib/html-builder.js';

const BUILD_DELAY_MS = 3000; // polite delay between Claude calls

// ─── Mode check ───────────────────────────────────────────────────────────────

async function isBuildingAllowed() {
  const { data } = await supabase.from('inbound_mode').select('mode').eq('id', 1).single();
  return data?.mode !== 'discovery_only';
}

// ─── Fetch approved opportunities without a site ─────────────────────────────

async function fetchApprovedOpportunities() {
  const { data, error } = await supabase
    .from('opportunities')
    .select('*')
    .eq('status', 'approved')
    .is('site_id', null)
    .order('score', { ascending: false });

  if (error) throw new Error(`Failed to fetch opportunities: ${error.message}`);
  return data || [];
}

// ─── Build one site ───────────────────────────────────────────────────────────

async function buildSite(opp) {
  const slug = siteSlug(opp.niche, opp.city, opp.state);
  console.log(`[site-factory] Building: ${slug}`);

  // Check for existing site record (idempotent)
  const { data: existing } = await supabase
    .from('generated_sites')
    .select('id, status')
    .eq('site_path', slug)
    .single();

  if (existing && existing.status === 'live') {
    console.log(`[site-factory] Already live: ${slug} — skipping`);
    return null;
  }

  // Generate content via Claude
  let content;
  try {
    content = await generateSiteContent(opp);
  } catch (err) {
    console.error(`[site-factory] Content generation failed for ${slug}:`, err.message);
    return null;
  }

  // Write HTML files to disk
  let siteDir;
  try {
    siteDir = buildSiteFiles(slug, content, opp);
    console.log(`[site-factory] Files written: ${siteDir}`);
  } catch (err) {
    console.error(`[site-factory] File write failed for ${slug}:`, err.message);
    return null;
  }

  // Upsert generated_sites record
  const siteRecord = {
    opportunity_id: opp.id,
    site_path: slug,
    title: content.headline,
    meta_description: content.metaDescription,
    content,
    status: 'live',
  };

  let siteId;

  if (existing) {
    const { data: updated, error } = await supabase
      .from('generated_sites')
      .update(siteRecord)
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) throw new Error(`Site update failed: ${error.message}`);
    siteId = updated.id;
  } else {
    const { data: created, error } = await supabase
      .from('generated_sites')
      .insert(siteRecord)
      .select('id')
      .single();
    if (error) throw new Error(`Site insert failed: ${error.message}`);
    siteId = created.id;
  }

  // Link opportunity → site and mark live
  await supabase
    .from('opportunities')
    .update({ status: 'live', site_id: siteId })
    .eq('id', opp.id);

  console.log(`[site-factory] Done: ${slug} (site_id=${siteId})`);
  return siteId;
}

// ─── Main run ─────────────────────────────────────────────────────────────────

export async function runSiteFactory() {
  console.log('[site-factory] Starting...');

  if (!await isBuildingAllowed()) {
    console.log('[site-factory] Mode is discovery_only — no sites will be built. Approve opportunities and set mode to controlled_build or higher.');
    return { built: 0, skipped: 0, errors: 0 };
  }

  const opportunities = await fetchApprovedOpportunities();
  console.log(`[site-factory] Found ${opportunities.length} approved opportunities to build`);

  if (opportunities.length === 0) {
    console.log('[site-factory] Nothing to build. Approve opportunities in the admin dashboard first.');
    return { built: 0, skipped: 0, errors: 0 };
  }

  let built = 0, skipped = 0, errors = 0;

  for (let i = 0; i < opportunities.length; i++) {
    const opp = opportunities[i];

    try {
      const result = await buildSite(opp);
      if (result === null) skipped++;
      else built++;
    } catch (err) {
      console.error(`[site-factory] Unhandled error for ${opp.niche}/${opp.city}:`, err.message);
      errors++;
    }

    if (i < opportunities.length - 1) {
      await new Promise(r => setTimeout(r, BUILD_DELAY_MS));
    }
  }

  console.log(`[site-factory] Complete. Built: ${built}, Skipped: ${skipped}, Errors: ${errors}`);
  return { built, skipped, errors };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

if (process.argv[1].endsWith('site-factory.js')) {
  runSiteFactory()
    .then(summary => {
      console.log('[site-factory] Summary:', summary);
      process.exit(0);
    })
    .catch(err => {
      console.error('[site-factory] Fatal:', err);
      process.exit(1);
    });
}
