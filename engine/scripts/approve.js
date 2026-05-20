/**
 * scripts/approve.js — Email Draft Review CLI
 *
 * Fetches Brain's draft emails from Supabase and lets the operator
 * approve or reject each one interactively.
 *
 * Usage:
 *   node scripts/approve.js                    # review ALL pending drafts
 *   CLIENT_ID=<uuid> node scripts/approve.js   # review one client's drafts
 *
 * Keys: [A] Approve  [R] Reject  [S] Skip  [Q] Quit
 */

import { createClient } from '@supabase/supabase-js';
import * as readline from 'readline';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = 100;


// ─── Main ─────────────────────────────────────────────────────────────────────

async function runApprover(targetClientId = null) {
  const drafts = await fetchDrafts(targetClientId);

  if (drafts.length === 0) {
    console.log('No draft emails pending review.');
    return;
  }

  console.log(`\n${drafts.length} draft(s) to review.`);
  console.log('Keys: [A] Approve  [R] Reject  [S] Skip  [Q] Quit\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  let approved = 0;
  let rejected = 0;
  let skipped = 0;

  for (const email of drafts) {
    printDraft(email);

    const answer = await ask('[A]pprove / [R]eject / [S]kip / [Q]uit: ');
    const key = answer.trim().toLowerCase();

    if (key === 'q') {
      console.log('\nQuitting.');
      break;
    }

    if (key === 'a') {
      await approveEmail(email);
      approved++;
      console.log('  Approved.\n');
    } else if (key === 'r') {
      await rejectEmail(email);
      rejected++;
      console.log('  Rejected — prospect reset to discovered for Brain to rewrite.\n');
    } else {
      skipped++;
      console.log('  Skipped.\n');
    }
  }

  rl.close();
  console.log('─'.repeat(60));
  console.log(`Done.  Approved: ${approved}  Rejected: ${rejected}  Skipped: ${skipped}`);
}


// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchDrafts(targetClientId) {
  // If filtering by client, get their prospect IDs first
  let prospectIdFilter = null;
  if (targetClientId) {
    const { data: prospects, error: pErr } = await supabase
      .from('prospects')
      .select('id')
      .eq('client_id', targetClientId);
    if (pErr) throw new Error(`DB error: ${pErr.message}`);
    if (!prospects?.length) return [];
    prospectIdFilter = prospects.map((p) => p.id);
  }

  let query = supabase
    .from('emails')
    .select(`
      id, subject, body, step, created_at, prospect_id, campaign_id,
      prospects ( id, business_name, owner_name, email, website, niche, city, state, client_id ),
      campaigns ( id, name, month )
    `)
    .eq('status', 'draft')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (prospectIdFilter) {
    query = query.in('prospect_id', prospectIdFilter);
  }

  const { data, error } = await query;
  if (error) throw new Error(`DB error: ${error.message}`);
  return data || [];
}


// ─── Display ──────────────────────────────────────────────────────────────────

function printDraft(email) {
  const p = email.prospects;
  const c = email.campaigns;
  const location = [p?.city, p?.state].filter(Boolean).join(', ') || '—';

  console.log('─'.repeat(60));
  console.log(`Business : ${p?.business_name || '—'}`);
  console.log(`To       : ${p?.email || '—'}`);
  console.log(`Niche    : ${p?.niche || '—'}   Location: ${location}`);
  console.log(`Campaign : ${c?.name || '—'}   Step: ${email.step}`);
  if (p?.website) console.log(`Website  : ${p.website}`);
  console.log('');
  console.log(`Subject  : ${email.subject}`);
  console.log('');
  console.log(email.body);
  console.log('');
}


// ─── Approve / Reject ─────────────────────────────────────────────────────────

async function approveEmail(email) {
  const clientId = email.prospects?.client_id;

  await supabase
    .from('emails')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', email.id);

  // Mark prospect as approved so Connector picks it up
  await supabase
    .from('prospects')
    .update({ status: 'approved' })
    .eq('id', email.prospect_id);

  await logEvent(clientId, email.prospect_id, email.id, 'email.approved', {
    subject: email.subject,
  });
}

async function rejectEmail(email) {
  const clientId = email.prospects?.client_id;

  await supabase
    .from('emails')
    .update({ status: 'rejected' })
    .eq('id', email.id);

  // Revert to discovered so Brain can pick it up again for a rewrite
  await supabase
    .from('prospects')
    .update({ status: 'discovered' })
    .eq('id', email.prospect_id);

  await logEvent(clientId, email.prospect_id, email.id, 'email.rewrite', {
    reason: 'operator_rejected',
  });
}


// ─── Event Logger ─────────────────────────────────────────────────────────────

async function logEvent(clientId, prospectId, emailId, type, payload) {
  await supabase.from('events').insert({
    client_id: clientId,
    prospect_id: prospectId,
    email_id: emailId,
    type,
    payload,
    source: 'approve',
  });
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

const targetClientId = process.env.CLIENT_ID || null;

runApprover(targetClientId)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Approver] Fatal:', err.message);
    process.exit(1);
  });
