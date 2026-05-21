/**
 * lib/job-runner.js — Background pipeline job manager
 *
 * Tracks in-memory state for running Scout→Brain pipelines.
 * All significant events are written to the Supabase events table
 * so they survive a page refresh and stream to the admin feed.
 */

import { supabase } from './supabase.js';
import { runScout } from '../agents/scout.js';
import { runBrain } from '../agents/brain.js';
import { runConnector } from '../agents/connector.js';

// clientId → { status, step, startedAt, abort }
const jobs = new Map();

function log(clientId, type, payload = {}) {
  supabase.from('events').insert({
    client_id: clientId, type, source: 'admin-runner', payload,
  }).then(() => {});
}

export function getJob(clientId) {
  return jobs.get(clientId) || { status: 'idle', step: '', startedAt: null };
}

export async function pauseClient(clientId) {
  await supabase.from('clients').update({ is_paused: true }).eq('id', clientId);
  const job = jobs.get(clientId);
  if (job) { job.status = 'paused'; job.step = 'Paused by operator'; }
  log(clientId, 'campaign.paused');
}

export async function resumeClient(clientId) {
  await supabase.from('clients').update({ is_paused: false }).eq('id', clientId);
  const job = jobs.get(clientId);
  if (job) job.status = 'running';
  log(clientId, 'campaign.resumed');
}

export function stopJob(clientId) {
  const job = jobs.get(clientId);
  if (job?.abort) job.abort.abort();
  jobs.delete(clientId);
  log(clientId, 'campaign.stopped');
}

async function ensureCampaign(clientId, clientName) {
  const month = new Date().toISOString().slice(0, 7); // "2026-05"

  const { data: existing } = await supabase
    .from('campaigns')
    .select('id')
    .eq('client_id', clientId)
    .eq('month', month)
    .maybeSingle();

  if (existing) return existing.id;

  const label = new Date().toLocaleString('en-US', { month: 'short', year: 'numeric' });
  const { data: created, error } = await supabase
    .from('campaigns')
    .insert({ client_id: clientId, name: `${clientName} – ${label}`, month, status: 'building' })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create campaign: ${error.message}`);
  return created.id;
}

/**
 * Start the Scout → Brain pipeline in the background.
 * Returns immediately; progress is tracked via getJob() and the events table.
 *
 * @param {string} clientId
 * @param {{ autoApprove?: boolean, scheduled?: boolean }} [options]
 *   autoApprove — auto-approve Brain drafts and run Connector (used by scheduler)
 *   scheduled   — logs campaign.scheduled_run event for idempotency guard
 */
export function startPipeline(clientId, options = {}) {
  const existing = jobs.get(clientId);
  if (existing?.status === 'running') throw new Error('A pipeline is already running for this client.');

  const abort = new AbortController();
  const state = { status: 'running', step: 'Starting…', startedAt: new Date(), abort };
  jobs.set(clientId, state);

  _run(clientId, state, abort.signal, options).catch(err => {
    console.error(`[Runner] Pipeline error for ${clientId}:`, err.message);
    state.status = 'error';
    state.step = err.message;
    log(clientId, 'error', { message: err.message, source: 'pipeline' });
  });
}

async function _run(clientId, state, signal, options = {}) {
  log(clientId, 'campaign.started');

  const { data: client } = await supabase
    .from('clients')
    .select('name, target_niche, target_states, target_cities')
    .eq('id', clientId)
    .single();

  if (!client) throw new Error('Client not found.');

  const niches = client.target_niche || [];
  const states = client.target_states || [];
  const cities = client.target_cities || [];

  if (!niches.length) throw new Error('No niches configured — update Settings first.');
  if (!cities.length && !states.length) {
    throw new Error('No target locations configured — add cities or states in Settings first.');
  }

  const campaignId = await ensureCampaign(clientId, client.name);

  // ── Scout: city-level targeting when available, otherwise per-state ──────────
  const checkPause = async () => {
    const { data: fresh } = await supabase
      .from('clients').select('is_paused').eq('id', clientId).single();
    if (fresh?.is_paused) { state.status = 'paused'; state.step = 'Paused by operator'; return true; }
    return false;
  };

  if (cities.length > 0) {
    for (const niche of niches) {
      for (const city of cities) {
        if (signal.aborted) { state.status = 'idle'; return; }
        if (await checkPause()) return;
        state.step = `Scouting ${niche} · ZIP ${city.zip}`;
        await runScout(clientId, niche, null, city);
      }
    }
  } else {
    for (const niche of niches) {
      for (const st of states) {
        if (signal.aborted) { state.status = 'idle'; return; }
        if (await checkPause()) return;
        state.step = `Scouting ${niche} · ${st}`;
        await runScout(clientId, niche, st);
      }
    }
  }

  if (signal.aborted) { state.status = 'idle'; return; }

  // ── Brain: draft emails for all discovered prospects ─────────────────────
  state.step = 'Writing email drafts…';
  log(clientId, 'brain.started', { campaignId });
  await runBrain(clientId, campaignId);

  // ── Auto-approve + send (scheduler mode only) ─────────────────────────────
  if (options?.autoApprove) {
    state.step = 'Auto-approving drafts…';
    await supabase
      .from('emails')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('campaign_id', campaignId)
      .eq('status', 'draft');

    state.step = 'Sending emails…';
    log(clientId, 'connector.started', { campaignId, source: 'scheduler' });
    await runConnector(clientId, campaignId);
    log(clientId, 'connector.complete', { campaignId });
  }

  if (options?.scheduled) {
    log(clientId, 'campaign.scheduled_run', {
      campaignId,
      date: new Date().toISOString().slice(0, 10),
    });
  }

  state.status = 'done';
  state.step = 'Pipeline complete';
  log(clientId, 'campaign.pipeline_complete', { campaignId });
}

/**
 * Run Connector for the client's current-month campaign.
 * Only pushes emails with status='approved'.
 */
export async function sendEmails(clientId) {
  const month = new Date().toISOString().slice(0, 7);

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('client_id', clientId)
    .eq('month', month)
    .maybeSingle();

  if (!campaign) throw new Error('No campaign for this month — start a campaign first.');

  log(clientId, 'connector.started', { campaignId: campaign.id });
  const result = await runConnector(clientId, campaign.id);
  log(clientId, 'connector.complete', { campaignId: campaign.id, pushed: result?.pushed ?? 0 });
  return result;
}
