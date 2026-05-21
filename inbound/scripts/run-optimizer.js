/**
 * scripts/run-optimizer.js — CLI trigger for the optimizer agent
 *
 * Usage: node scripts/run-optimizer.js
 *        npm run optimizer
 *
 * Analyzes all live sites, prints a performance report,
 * and saves recommendations to inbound_mode.last_optimizer_report.
 *
 * Run weekly or whenever you want a performance snapshot.
 */

import { runOptimizer } from '../agents/optimizer.js';
import 'dotenv/config';

runOptimizer()
  .then(() => {
    console.log('[run-optimizer] Report saved to Supabase.');
    process.exit(0);
  })
  .catch(err => {
    console.error('[run-optimizer] Fatal:', err);
    process.exit(1);
  });
