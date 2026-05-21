/**
 * scripts/run.js — Pipeline Orchestrator
 *
 * Runs Scout → Brain → Connector in sequence for all active clients.
 * Each stage is safe to re-run — agents skip clients that are paused
 * or have hit their monthly quota.
 *
 * Usage:
 *   node scripts/run.js                    # run all active clients
 *   CLIENT_ID=<uuid> node scripts/run.js   # run one specific client
 *
 * Typical workflow:
 *   1. node scripts/run.js        (Scout finds prospects, Brain writes drafts)
 *   2. node scripts/approve.js    (Operator reviews + approves drafts)
 *   3. node scripts/run.js        (Connector pushes approved emails to Instantly)
 */

import { supabase } from '../lib/supabase.js';
import { runScout } from '../agents/scout.js';
import { runBrain } from '../agents/brain.js';
import { runConnector } from '../agents/connector.js';
import 'dotenv/config';


// ─── Main ─────────────────────────────────────────────────────────────────────

async function runAll(targetClientId = null) {
  const clients = await fetchClients(targetClientId);

  if (clients.length === 0) {
    console.log('[Run] No active clients found.');
    return;
  }

  console.log(`[Run] Starting pipeline for ${clients.length} client(s).\n`);

  const results = [];

  for (const client of clients) {
    console.log(`${'─'.repeat(60)}`);
    console.log(`[Run] Client: ${client.name} (${client.tier}) — ${client.id}`);

    try {
      const result = await runClientPipeline(client);
      results.push({ client: client.name, ...result, error: null });
    } catch (err) {
      console.error(`[Run] Pipeline failed for ${client.name}: ${err.message}`);
      results.push({ client: client.name, error: err.message });
    }

    console.log('');
  }

  printSummary(results);
}


// ─── Per-client pipeline ──────────────────────────────────────────────────────

async function runClientPipeline(client) {
  const states = client.target_states?.length ? client.target_states : [];
  const niche = client.target_niche;

  if (!niche) {
    console.warn(`[Run] ${client.name} has no target_niche set — skipping Scout.`);
  }

  // 1. Ensure a campaign exists for this month
  const campaignId = await ensureCampaign(client);
  console.log(`[Run] Campaign ID: ${campaignId}`);

  // 2. Scout — run for each target state (skip if niche/states not configured)
  let totalProspects = 0;
  if (niche && states.length > 0) {
    for (const state of states) {
      try {
        const { totalSaved } = await runScout(client.id, niche, state);
        totalProspects += totalSaved;
      } catch (err) {
        console.error(`[Run] Scout failed for ${niche}/${state}: ${err.message}`);
      }
    }
  } else if (niche && states.length === 0) {
    console.warn(`[Run] ${client.name} has no target_states set — skipping Scout.`);
  }

  // 3. Brain — write emails for newly discovered prospects
  let drafted = 0;
  try {
    const result = await runBrain(client.id, campaignId);
    drafted = result?.drafted || 0;
  } catch (err) {
    console.error(`[Run] Brain failed for ${client.name}: ${err.message}`);
  }

  // 4. Connector — push approved emails to Instantly
  let pushed = 0;
  try {
    const result = await runConnector(client.id, campaignId);
    pushed = result?.pushed || 0;
  } catch (err) {
    console.error(`[Run] Connector failed for ${client.name}: ${err.message}`);
  }

  return { totalProspects, drafted, pushed };
}


// ─── Campaign management ──────────────────────────────────────────────────────

/**
 * Finds or creates a campaign for this client in the current month.
 * Returns the campaign UUID.
 */
async function ensureCampaign(client) {
  const month = currentMonth();

  const { data: existing } = await supabase
    .from('campaigns')
    .select('id')
    .eq('client_id', client.id)
    .eq('month', month)
    .maybeSingle();

  if (existing) return existing.id;

  const name = `${client.name} – ${formatMonth(month)}`;

  const { data: created, error } = await supabase
    .from('campaigns')
    .insert({
      client_id: client.id,
      name,
      month,
      status: 'building',
      follow_up_count: 4,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create campaign: ${error.message}`);

  await supabase.from('events').insert({
    client_id: client.id,
    type: 'campaign.created',
    payload: { name, month },
    source: 'run',
  });

  console.log(`[Run] Created campaign: ${name}`);
  return created.id;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchClients(targetClientId) {
  let query = supabase
    .from('clients')
    .select('id, name, tier, target_niche, target_states, monthly_quota, prospects_sent_this_month, is_paused')
    .eq('billing_status', 'active')
    .eq('is_paused', false);

  if (targetClientId) {
    query = query.eq('id', targetClientId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`DB error: ${error.message}`);
  return data || [];
}

/** Returns current month as "YYYY-MM" */
function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Formats "2026-05" → "May 2026" */
function formatMonth(label) {
  const [year, month] = label.split('-');
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function printSummary(results) {
  console.log('─'.repeat(60));
  console.log('[Run] Pipeline complete.\n');
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.client}: FAILED — ${r.error}`);
    } else {
      console.log(
        `  ${r.client}: +${r.totalProspects} prospects  ${r.drafted} drafted  ${r.pushed} pushed to Instantly`
      );
    }
  }
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

const targetClientId = process.env.CLIENT_ID || null;

runAll(targetClientId)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Run] Fatal:', err.message);
    process.exit(1);
  });
