/**
 * watchdog.js — Conversion & Reply Monitor
 *
 * Handles two signals that mean we should stop outreach to a prospect:
 *   1. Stripe webhook events — payment and subscription lifecycle.
 *      handleStripeEvent() is called by api/stripe-webhook.js.
 *
 *   2. Instantly reply / bounce / unsubscribe events — polled every 2 hours
 *      directly from the Instantly API. No inbound webhook needed.
 *      startInstantlyPoller() is called by api/server.js on boot.
 */

import axios from 'axios';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// ─── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const iHeaders = () => ({
  Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
  'Content-Type': 'application/json',
});

// How far back to look on the very first poll (before any saved timestamp)
const INITIAL_LOOKBACK_HOURS = 3;


// ─── Stripe event handler ─────────────────────────────────────────────────────

/**
 * Called by api/stripe-webhook.js when a Stripe event is received.
 */
export async function handleStripeEvent(event) {
  console.log(`[Watchdog] Stripe event: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'invoice.payment_succeeded': {
      const customerId =
        event.data.object.customer || event.data.object.customer_id;
      await handlePaymentSuccess(customerId, event);
      break;
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      await handleSubscriptionEnd(event.data.object.customer, event);
      break;
    }
    default:
      console.log(`[Watchdog] Unhandled Stripe event: ${event.type}`);
  }
}

async function handlePaymentSuccess(stripeCustomerId, event) {
  const { data: client } = await supabase
    .from('clients')
    .select('id, name')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (!client) {
    console.log(`[Watchdog] No client for Stripe customer ${stripeCustomerId}`);
    return;
  }

  await supabase
    .from('clients')
    .update({ billing_status: 'active', is_paused: false })
    .eq('id', client.id);

  await logEvent(client.id, null, 'payment.received', {
    stripe_customer_id: stripeCustomerId,
    stripe_event_id: event.id,
    amount: event.data.object.amount_paid || event.data.object.amount_total,
  });

  console.log(`[Watchdog] Payment confirmed for client: ${client.name}`);
}

async function handleSubscriptionEnd(stripeCustomerId, event) {
  const { data: client } = await supabase
    .from('clients')
    .select('id, name')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (!client) return;

  const newStatus =
    event.type === 'invoice.payment_failed' ? 'past_due' : 'cancelled';

  await supabase
    .from('clients')
    .update({ billing_status: newStatus, is_paused: true })
    .eq('id', client.id);

  await logEvent(client.id, null, 'subscription.cancelled', {
    reason: event.type,
    stripe_event_id: event.id,
  });

  console.log(`[Watchdog] Client ${client.name} marked as ${newStatus}.`);
}


// ─── Instantly poller ─────────────────────────────────────────────────────────

/**
 * Starts a cron job that polls Instantly every 2 hours.
 * Call this once from api/server.js on boot.
 */
export function startInstantlyPoller() {
  console.log('[Watchdog] Instantly poller starting — runs every 2 hours.');

  // Run immediately on boot, then every 2 hours
  pollInstantly();
  cron.schedule('0 */2 * * *', pollInstantly);
}

/**
 * Polls all Instantly campaigns for leads that have replied, bounced,
 * or unsubscribed since the last poll. Updates Supabase accordingly.
 */
async function pollInstantly() {
  const since = await getLastPollTime();
  const now = new Date().toISOString();

  console.log(`[Watchdog] Polling Instantly for activity since ${since}`);

  try {
    const campaigns = await fetchInstantlyCampaigns();
    console.log(`[Watchdog] Found ${campaigns.length} Instantly campaign(s).`);

    let replied = 0;
    let bounced = 0;
    let unsubscribed = 0;

    for (const campaign of campaigns) {
      const leads = await fetchCampaignLeads(campaign.id, since);

      for (const lead of leads) {
        const email = lead.email?.toLowerCase();
        if (!email) continue;

        // NOTE: Instantly v2 lead fields — verify against your API version:
        // is_replied / has_replies  →  reply detection
        // email_bounced             →  hard bounce
        // is_unsubscribed           →  unsubscribe
        if (lead.is_replied || lead.has_replies) {
          await processReply(email, lead);
          replied++;
        } else if (lead.email_bounced) {
          await processBounce(email);
          bounced++;
        } else if (lead.is_unsubscribed) {
          await processUnsubscribe(email, lead);
          unsubscribed++;
        }
      }
    }

    console.log(
      `[Watchdog] Poll done — ${replied} replies, ${bounced} bounces, ${unsubscribed} unsubscribes.`
    );

    // Stamp the successful poll time
    await logEvent(null, null, 'watchdog.polled', { since, campaigns: campaigns.length });
  } catch (err) {
    console.error(`[Watchdog] Poll error: ${err.message}`);
  }
}


// ─── Instantly API calls ──────────────────────────────────────────────────────

/**
 * Returns all campaigns from Instantly.
 * NOTE: Verify endpoint path against your Instantly API version.
 */
async function fetchInstantlyCampaigns() {
  try {
    const { data } = await axios.get(`${INSTANTLY_BASE}/campaign`, {
      headers: iHeaders(),
      params: { limit: 100, skip: 0 },
      timeout: 15000,
    });
    // Response shape: { data: [...] } or directly an array
    return data?.data || data || [];
  } catch (err) {
    console.error(`[Watchdog] Failed to fetch Instantly campaigns: ${err.message}`);
    return [];
  }
}

/**
 * Returns leads for one campaign updated after `since` (ISO timestamp).
 * Paginates through all pages.
 */
async function fetchCampaignLeads(campaignId, since) {
  const results = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    try {
      const { data } = await axios.get(`${INSTANTLY_BASE}/leads`, {
        headers: iHeaders(),
        params: {
          campaign_id: campaignId,
          limit,
          skip,
          // NOTE: Instantly may use updated_at_min or a similar filter name
          updated_at_min: since,
        },
        timeout: 15000,
      });

      const page = data?.data || data?.leads || [];
      results.push(...page);

      if (page.length < limit) break;
      skip += limit;
    } catch (err) {
      console.error(`[Watchdog] Failed to fetch leads for campaign ${campaignId}: ${err.message}`);
      break;
    }
  }

  return results;
}

/**
 * Adds an email to Instantly's global block list, stopping all future outreach.
 * NOTE: Verify endpoint against your Instantly API version.
 */
async function blockInInstantly(email) {
  try {
    await axios.post(
      `${INSTANTLY_BASE}/blocklist/add`,
      { emails: [email] },
      { headers: iHeaders(), timeout: 8000 }
    );
    console.log(`[Watchdog] Blocked in Instantly: ${email}`);
  } catch (err) {
    // Non-fatal — email may already be blocked
    console.warn(`[Watchdog] Could not block ${email} in Instantly: ${err.message}`);
  }
}


// ─── Lead event processors ────────────────────────────────────────────────────

async function processReply(email, lead) {
  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, client_id, business_name')
    .eq('email', email)
    .not('status', 'in', '("replied","converted")')
    .maybeSingle();

  if (!prospect) return;

  await supabase
    .from('prospects')
    .update({ status: 'replied' })
    .eq('id', prospect.id);

  await blockInInstantly(email);

  await logEvent(prospect.client_id, prospect.id, 'reply.received', {
    email,
    instantly_lead: lead,
  });

  console.log(`[Watchdog] Reply — stopped outreach for: ${prospect.business_name}`);
}

async function processBounce(email) {
  const { error } = await supabase
    .from('prospects')
    .update({ status: 'bounced' })
    .eq('email', email);

  if (!error) console.log(`[Watchdog] Bounce recorded for: ${email}`);
}

async function processUnsubscribe(email, lead) {
  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, client_id, business_name')
    .eq('email', email)
    .maybeSingle();

  if (!prospect) return;

  await supabase
    .from('prospects')
    .update({ status: 'unsubscribed' })
    .eq('id', prospect.id);

  await blockInInstantly(email);

  await logEvent(prospect.client_id, prospect.id, 'outreach.stopped', {
    reason: 'unsubscribed',
    email,
    instantly_lead: lead,
  });

  console.log(`[Watchdog] Unsubscribe — stopped outreach for: ${prospect.business_name}`);
}


// ─── Poll timestamp ───────────────────────────────────────────────────────────

/**
 * Returns the ISO timestamp of the last successful poll.
 * Falls back to INITIAL_LOOKBACK_HOURS ago if no prior poll found.
 */
async function getLastPollTime() {
  const { data } = await supabase
    .from('events')
    .select('created_at')
    .eq('type', 'watchdog.polled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data?.created_at) return data.created_at;

  const fallback = new Date(Date.now() - INITIAL_LOOKBACK_HOURS * 60 * 60 * 1000);
  return fallback.toISOString();
}


// ─── Event Logger ─────────────────────────────────────────────────────────────

async function logEvent(clientId, prospectId, type, payload) {
  await supabase.from('events').insert({
    client_id: clientId,
    prospect_id: prospectId,
    type,
    payload,
    source: 'watchdog',
  });
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('watchdog.js')) {
  console.log('[Watchdog] Running standalone — polling Instantly every 2 hours.');
  startInstantlyPoller();
  // Keep the process alive
  process.on('SIGINT', () => {
    console.log('[Watchdog] Shutting down.');
    process.exit(0);
  });
}
