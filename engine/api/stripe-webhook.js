/**
 * api/stripe-webhook.js — Stripe Webhook Route
 *
 * Verifies the Stripe webhook signature, then passes the event
 * to Watchdog for processing.
 *
 * Mount this on POST /webhooks/stripe in your Express server.
 *
 * Stripe requires the raw request body (not parsed JSON) for
 * signature verification — make sure Express is configured with
 * express.raw() on this route (see api/server.js).
 */

import Stripe from 'stripe';
import { handleStripeEvent } from '../agents/watchdog.js';
import 'dotenv/config';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Express route handler for POST /webhooks/stripe
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    console.warn('[StripeWebhook] Missing stripe-signature header.');
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event;
  try {
    // Verify signature using the raw body buffer
    event = stripe.webhooks.constructEvent(
      req.body,                           // raw Buffer (not parsed)
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`[StripeWebhook] Signature verification failed: ${err.message}`);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // Acknowledge receipt immediately — Stripe expects a 2xx within 5 seconds.
  // Process asynchronously so we don't time out on slow DB writes.
  res.status(200).json({ received: true });

  try {
    await handleStripeEvent(event);
  } catch (err) {
    // Don't return a 500 here — we already sent 200. Just log.
    console.error(`[StripeWebhook] Handler error for event ${event.id}: ${err.message}`);
  }
}
