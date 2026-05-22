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
import { onboardingRouter } from './onboarding.js';
import { adminRouter } from './admin.js';
import { legalRouter } from './legal.js';
import { bookingsRouter } from './bookings.js';
import { startInstantlyPoller } from '../agents/watchdog.js';
import { startScheduler } from '../lib/scheduler.js';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Stripe webhook: MUST receive raw body for signature verification ─────────
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

// ─── Public booking API (CORS-enabled for suparade.com) ──────────────────────
app.use('/api', bookingsRouter);

// ─── Client onboarding form ───────────────────────────────────────────────────
app.use('/onboarding', onboardingRouter);

// ─── Admin dashboard ──────────────────────────────────────────────────────────
app.use('/admin', adminRouter);

// ─── Legal pages ─────────────────────────────────────────────────────────────
app.use('/', legalRouter);

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

  // Start the hourly campaign scheduler (auto-fires Scout → Brain → Connector)
  startScheduler();
});
