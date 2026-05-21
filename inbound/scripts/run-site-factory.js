/**
 * scripts/run-site-factory.js — CLI trigger for the site-factory agent
 *
 * Usage: node scripts/run-site-factory.js
 *   npm run site-factory
 *
 * Reads all approved opportunities from Supabase, generates HTML via Claude,
 * writes files to /inbound/sites/<slug>/, and marks opportunities live.
 *
 * Requires mode != discovery_only in the inbound_mode table.
 */

import { runSiteFactory } from '../agents/site-factory.js';
import 'dotenv/config';

console.log('[run-site-factory] Starting site factory...');

runSiteFactory()
  .then(({ built, skipped, errors }) => {
    console.log(`[run-site-factory] Done — built: ${built}, skipped: ${skipped}, errors: ${errors}`);
    process.exit(errors > 0 ? 1 : 0);
  })
  .catch(err => {
    console.error('[run-site-factory] Fatal error:', err);
    process.exit(1);
  });
