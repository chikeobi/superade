/**
 * api/server.js — Webhook HTTP Server
 *
 * Starts a minimal Express server that receives webhooks from Stripe,
 * and boots the Instantly poller (reply / bounce / unsubscribe detection).
 *
 * Run with: node api/server.js
 *
 * In production, put this behind a reverse proxy (Nginx, Caddy, or
 * a platform like Railway/Render that terminates TLS).
 */

import express from 'express';
import { stripeWebhookHandler } from './stripe-webhook.js';
import { startInstantlyPoller } from '../agents/watchdog.js';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Stripe webhook: MUST receive raw body for signature verification ─────────
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Webhook server listening on port ${PORT}`);
  console.log(`[Server] Stripe endpoint: POST /webhooks/stripe`);

  // Start polling Instantly for replies/bounces/unsubscribes every 2 hours
  startInstantlyPoller();
});
