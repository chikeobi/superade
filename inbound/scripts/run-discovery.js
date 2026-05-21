/**
 * scripts/run-discovery.js — Manual trigger for the discovery agent
 *
 * Run from the /inbound directory:
 *   node scripts/run-discovery.js
 *   npm run discovery
 */

import { runDiscovery } from '../agents/discovery.js';

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Superade Inbound — Discovery Agent');
console.log(`  Started: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

runDiscovery()
  .then((summary) => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Complete — ${summary.scored} opportunities scored`);
    if (summary.topOpportunities.length > 0) {
      const top = summary.topOpportunities[0];
      console.log(`  Best: ${top.niche} — ${top.city}, ${top.state} (${top.score}/100)`);
    }
    console.log('  Review results at: api.suparade.com/admin/inbound');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n[run-discovery] Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
