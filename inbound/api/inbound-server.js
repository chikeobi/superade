/**
 * api/inbound-server.js — Inbound system HTTP server (port 3001)
 *
 * Completely separate from engine/api/server.js (port 3000).
 * Mounts the inbound admin dashboard at /admin/inbound.
 *
 * Auth: uses the same ADMIN_PASSWORD env var and admin_sid cookie
 * as the outbound admin — logging in on either server works on both
 * because the session cookie is shared by domain.
 *
 * Run with: node api/inbound-server.js
 * PM2:      pm2 start api/inbound-server.js --name superade-inbound
 */

import express from 'express';
import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerAuthRoutes } from './admin/auth.js';
import { registerOverviewRoutes } from './admin/overview.js';
import { registerVendorRoutes } from './admin/vendors.js';
import { registerLeadsRoutes } from './admin/leads.js';
import { registerCaptureRoutes } from './lead-capture.js';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.INBOUND_PORT || 3001;

// ─── Build the inbound admin router ──────────────────────────────────────────

const adminRouter = Router();

registerAuthRoutes(adminRouter);
registerOverviewRoutes(adminRouter);
registerVendorRoutes(adminRouter);
registerLeadsRoutes(adminRouter);

// ─── Lead capture router ──────────────────────────────────────────────────────

const leadsRouter = Router();
registerCaptureRoutes(leadsRouter);

// ─── Mount + boot ─────────────────────────────────────────────────────────────

app.use(express.json());

// Serve generated site files: /sites/<slug>/index.html, /sites/<slug>/thanks.html
const SITES_DIR = path.resolve(__dirname, '../sites');
app.use('/sites', express.static(SITES_DIR));

// Lead capture — POST from generated site forms
app.use('/leads', leadsRouter);

// Mount the admin router at /admin/inbound
// Nginx proxies api.suparade.com/admin/inbound → localhost:3001
app.use('/admin/inbound', adminRouter);

// Root redirect
app.get('/', (_req, res) => res.redirect('/admin/inbound'));

// Health check (useful for PM2 + monitoring)
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  service: 'superade-inbound',
  ts: new Date().toISOString(),
}));

app.listen(PORT, () => {
  console.log(`[Inbound] Server listening on port ${PORT}`);
  console.log(`[Inbound] Admin dashboard: http://localhost:${PORT}/admin/inbound`);
});
