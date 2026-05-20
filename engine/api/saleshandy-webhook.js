/**
 * api/saleshandy-webhook.js — Saleshandy Webhook Route
 *
 * Receives reply/bounce/unsubscribe events from Saleshandy and
 * passes them to Watchdog.
 *
 * Saleshandy sends a shared secret in the X-Saleshandy-Secret header.
 * Verify it against SALESHANDY_WEBHOOK_SECRET in .env.
 *
 * Mount on POST /webhooks/saleshandy in your Express server.
 */

import { handleSaleshandyEvent } from '../agents/watchdog.js';
import 'dotenv/config';

/**
 * Express route handler for POST /webhooks/saleshandy
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
export async function saleshandyWebhookHandler(req, res) {
  // Verify the shared secret Saleshandy includes in every request
  const incomingSecret = req.headers['x-saleshandy-secret'];
  const expectedSecret = process.env.SALESHANDY_WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.warn('[SaleshandyWebhook] SALESHANDY_WEBHOOK_SECRET not set — skipping auth.');
  } else if (incomingSecret !== expectedSecret) {
    console.warn('[SaleshandyWebhook] Invalid webhook secret — rejecting request.');
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const payload = req.body;

  if (!payload?.event) {
    console.warn('[SaleshandyWebhook] Payload missing event field:', payload);
    return res.status(400).json({ error: 'Missing event field in payload' });
  }

  // Acknowledge receipt immediately
  res.status(200).json({ received: true });

  try {
    await handleSaleshandyEvent(payload);
  } catch (err) {
    // Already sent 200 — just log
    console.error(`[SaleshandyWebhook] Handler error: ${err.message}`);
  }
}
