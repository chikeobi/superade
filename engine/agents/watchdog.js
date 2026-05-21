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
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import 'dotenv/config';

// ─── Constants ────────────────────────────────────────────────────────────────

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const TIER_QUOTAS = { starter: 500, growth: 1000, scale: 2000 };
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
    case 'checkout.session.completed': {
      // Initial purchase — create or update the client row with correct tier + Stripe IDs.
      const clientId = await provisionClient(event.data.object);
      if (clientId) {
        await logEvent(clientId, null, 'subscription.created', {
          stripe_event_id: event.id,
          stripe_customer_id: event.data.object.customer,
        });
      }
      break;
    }
    case 'invoice.payment_succeeded': {
      // Recurring payment — just ensure billing_status stays active.
      const customerId = event.data.object.customer || event.data.object.customer_id;
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

/**
 * Maps a Stripe price ID to one of our tier names.
 * Falls back to 'starter' for unknown price IDs.
 */
function resolveTier(priceId) {
  if (!priceId) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_GROWTH) return 'growth';
  if (priceId === process.env.STRIPE_PRICE_SCALE)  return 'scale';
  return 'starter'; // covers STRIPE_PRICE_STARTER + any unrecognised IDs
}

/**
 * Called when checkout.session.completed fires.
 * Creates a new client row or updates an existing one (matched by email).
 * Returns the Supabase client UUID, or null on failure.
 */
async function provisionClient(session) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  // Expand line_items so we can read the price ID and determine tier
  let priceId;
  try {
    const expanded = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['line_items'],
    });
    priceId = expanded.line_items?.data?.[0]?.price?.id;
  } catch (err) {
    console.error('[Watchdog] Could not expand checkout session:', err.message);
  }

  const tier  = resolveTier(priceId);
  const email = (session.customer_details?.email || session.customer_email)?.toLowerCase().trim();
  const name  = session.customer_details?.name?.trim() || 'New Client';
  const stripeCustomerId      = session.customer;
  const stripeSubscriptionId  = session.subscription || null;

  if (!email) {
    console.error('[Watchdog] checkout.session.completed has no customer email — skipping provisioning.');
    return null;
  }

  // Upsert on email — idempotent if the onboarding form was filled first
  const { data: existing } = await supabase
    .from('clients')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    await supabase.from('clients').update({
      stripe_customer_id:     stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      tier,
      monthly_quota:   TIER_QUOTAS[tier],
      billing_status:  'active',
      is_paused:       false,
    }).eq('id', existing.id);

    console.log(`[Watchdog] Updated existing client on checkout: ${email} → ${tier}`);
    return existing.id;
  }

  const { data: created, error } = await supabase
    .from('clients')
    .insert({
      name,
      email,
      tier,
      monthly_quota:          TIER_QUOTAS[tier],
      stripe_customer_id:     stripeCustomerId,
      stripe_subscription_id: stripeSubscriptionId,
      billing_status:         'active',
    })
    .select('id')
    .single();

  if (error) {
    console.error('[Watchdog] Failed to provision client:', error.message);
    return null;
  }

  console.log(`[Watchdog] Provisioned new client: ${email} → ${tier}`);
  return created.id;
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
  const sinceDate = new Date(since);
  const now = new Date().toISOString();

  console.log(`[Watchdog] Polling Instantly for activity since ${since}`);

  try {
    const campaigns = await fetchInstantlyCampaigns();
    console.log(`[Watchdog] Found ${campaigns.length} Instantly campaign(s).`);

    let replied = 0;
    let bounced = 0;
    let unsubscribed = 0;

    for (const campaign of campaigns) {
      const leads = await fetchCampaignLeads(campaign.id);

      for (const lead of leads) {
        const email = lead.email?.toLowerCase();
        if (!email) continue;

        // Instantly v2 lead fields (verified against API docs):
        // email_reply_count + timestamp_last_reply  →  reply detection
        // status === -1                             →  hard bounce
        // status === -2                             →  unsubscribed
        if (
          lead.email_reply_count > 0 &&
          lead.timestamp_last_reply &&
          new Date(lead.timestamp_last_reply) > sinceDate
        ) {
          await processReply(email, lead);
          replied++;
        } else if (lead.status === -1) {
          await processBounce(email);
          bounced++;
        } else if (lead.status === -2) {
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
 * GET /api/v2/campaigns — returns { items: [...] }
 */
async function fetchInstantlyCampaigns() {
  try {
    const { data } = await axios.get(`${INSTANTLY_BASE}/campaigns`, {
      headers: iHeaders(),
      params: { limit: 100 },
      timeout: 15000,
    });
    return data?.items || [];
  } catch (err) {
    console.error(`[Watchdog] Failed to fetch Instantly campaigns: ${err.message}`);
    return [];
  }
}

/**
 * Returns all leads for one Instantly campaign.
 * POST /api/v2/leads — cursor-based pagination via starting_after / next_starting_after.
 */
async function fetchCampaignLeads(campaignId) {
  const results = [];
  let startingAfter = null;
  const limit = 100;

  while (true) {
    try {
      const body = {
        campaign: campaignId,
        limit,
        ...(startingAfter && { starting_after: startingAfter }),
      };

      const { data } = await axios.post(`${INSTANTLY_BASE}/leads`, body, {
        headers: iHeaders(),
        timeout: 15000,
      });

      const page = data?.items || [];
      results.push(...page);

      if (page.length < limit || !data?.next_starting_after) break;
      startingAfter = data.next_starting_after;
    } catch (err) {
      console.error(`[Watchdog] Failed to fetch leads for campaign ${campaignId}: ${err.message}`);
      break;
    }
  }

  return results;
}

/**
 * Adds an email to Instantly's global block list, stopping all future outreach.
 * POST /api/v2/block-lists-entries/bulk-create — body: { bl_values: [email] }
 */
async function blockInInstantly(email) {
  try {
    await axios.post(
      `${INSTANTLY_BASE}/block-lists-entries/bulk-create`,
      { bl_values: [email] },
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
