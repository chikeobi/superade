/**
 * watchdog.js — Conversion & Reply Monitor
 *
 * Listens for two signals that mean we should stop outreach to a prospect:
 *   1. A Stripe payment event — prospect became a paying client
 *   2. A positive Saleshandy reply event — prospect replied to an email
 *
 * When either fires, Watchdog:
 *   - Updates the prospect's status in Supabase ('converted' or 'replied')
 *   - Calls the Saleshandy API to remove them from active sequences
 *   - Logs an event to the events table
 *
 * This module exports handlers that are called by the webhook API routes.
 * It does NOT start its own HTTP server — see api/stripe-webhook.js and
 * api/saleshandy-webhook.js for the Express routes that call these handlers.
 */

import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// ─── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SH_BASE = 'https://api.saleshandy.com/api/v1';
const shHeaders = () => ({
  'X-Auth-Token': process.env.SALESHANDY_API_KEY,
  'Content-Type': 'application/json',
});


// ─── Stripe event handler ─────────────────────────────────────────────────────

/**
 * Called by api/stripe-webhook.js when a Stripe event is received.
 * Handles payment and subscription lifecycle events.
 *
 * @param {object} event - Verified Stripe event object
 */
export async function handleStripeEvent(event) {
  console.log(`[Watchdog] Stripe event: ${event.type}`);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'invoice.payment_succeeded': {
      // A new client paid or renewed — update billing status
      const customerId =
        event.data.object.customer || event.data.object.customer_id;
      await handlePaymentSuccess(customerId, event);
      break;
    }

    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      // Subscription cancelled or payment failed
      const customerId = event.data.object.customer;
      await handleSubscriptionEnd(customerId, event);
      break;
    }

    default:
      console.log(`[Watchdog] Unhandled Stripe event type: ${event.type}`);
  }
}

/**
 * A client's payment succeeded — mark them as active.
 */
async function handlePaymentSuccess(stripeCustomerId, event) {
  const { data: client } = await supabase
    .from('clients')
    .select('id, name')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (!client) {
    // First payment — client record may not exist yet (created by onboarding flow)
    console.log(`[Watchdog] No client found for Stripe customer ${stripeCustomerId}`);
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

/**
 * A subscription ended — pause the client and their outreach.
 */
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


// ─── Saleshandy reply handler ─────────────────────────────────────────────────

/**
 * Called by api/saleshandy-webhook.js when a Saleshandy event fires.
 * Handles replies, bounces, and unsubscribes.
 *
 * @param {object} payload - Raw webhook payload from Saleshandy
 */
export async function handleSaleshandyEvent(payload) {
  const { event, data } = payload;
  console.log(`[Watchdog] Saleshandy event: ${event}`);

  switch (event) {
    case 'email_replied':
      await handleReply(data);
      break;

    case 'email_bounced':
      await handleBounce(data);
      break;

    case 'email_unsubscribed':
      await handleUnsubscribe(data);
      break;

    default:
      console.log(`[Watchdog] Unhandled Saleshandy event: ${event}`);
  }
}

/**
 * A prospect replied to an email — stop all further outreach.
 */
async function handleReply(data) {
  const email = data?.lead_email || data?.email;
  if (!email) {
    console.warn('[Watchdog] Reply event missing email address.');
    return;
  }

  // Find the prospect by email across all clients
  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, client_id, business_name, status')
    .eq('email', email.toLowerCase())
    .neq('status', 'replied')
    .neq('status', 'converted')
    .maybeSingle();

  if (!prospect) {
    console.log(`[Watchdog] No active prospect found for reply from: ${email}`);
    return;
  }

  // Update prospect status
  await supabase
    .from('prospects')
    .update({ status: 'replied' })
    .eq('id', prospect.id);

  // Remove from Saleshandy sequence so no more follow-ups fire
  await stopSaleshandyOutreach(email, data);

  await logEvent(prospect.client_id, prospect.id, 'reply.received', {
    email,
    saleshandy_data: data,
  });

  console.log(`[Watchdog] Reply received — outreach stopped for: ${prospect.business_name}`);
}

/**
 * An email hard-bounced — mark the prospect so we don't retry.
 */
async function handleBounce(data) {
  const email = data?.lead_email || data?.email;
  if (!email) return;

  await supabase
    .from('prospects')
    .update({ status: 'bounced' })
    .eq('email', email.toLowerCase());

  console.log(`[Watchdog] Bounce recorded for: ${email}`);
}

/**
 * A prospect unsubscribed — stop all outreach and mark permanently.
 */
async function handleUnsubscribe(data) {
  const email = data?.lead_email || data?.email;
  if (!email) return;

  const { data: prospect } = await supabase
    .from('prospects')
    .select('id, client_id, business_name')
    .eq('email', email.toLowerCase())
    .maybeSingle();

  if (!prospect) return;

  await supabase
    .from('prospects')
    .update({ status: 'unsubscribed' })
    .eq('id', prospect.id);

  await stopSaleshandyOutreach(email, data);

  await logEvent(prospect.client_id, prospect.id, 'outreach.stopped', {
    reason: 'unsubscribed',
    email,
  });

  console.log(`[Watchdog] Unsubscribe — outreach stopped for: ${prospect.business_name}`);
}


// ─── Saleshandy: stop outreach for a lead ────────────────────────────────────

/**
 * Removes a lead from all active Saleshandy campaigns/sequences.
 * Saleshandy doesn't have a single "stop all" endpoint, so we
 * add the email to a global block list via their unsubscribe API.
 */
async function stopSaleshandyOutreach(email, data) {
  try {
    // Use Saleshandy's unsubscribe endpoint to globally block this email
    await axios.post(
      `${SH_BASE}/unsubscribe`,
      { email },
      { headers: shHeaders(), timeout: 8000 }
    );
    console.log(`[Watchdog] Saleshandy unsubscribe posted for: ${email}`);
  } catch (err) {
    // Non-fatal — log and continue. Email may already be unsubscribed.
    console.warn(`[Watchdog] Could not unsubscribe ${email} from Saleshandy: ${err.message}`);
  }
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
