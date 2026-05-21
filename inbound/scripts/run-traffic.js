/**
 * scripts/run-traffic.js — CLI trigger for the traffic agent
 *
 * Usage: node scripts/run-traffic.js
 *        npm run traffic
 *
 * Writes sitemap.xml for each live site, pings Google + Bing,
 * and prints GBP setup instructions.
 *
 * Set SITE_BASE_URL in .env to your public domain.
 */

import { runTraffic } from '../agents/traffic.js';
import 'dotenv/config';

runTraffic()
  .then(({ processed }) => {
    console.log(`[run-traffic] Done. Processed ${processed} site(s).`);
    process.exit(0);
  })
  .catch(err => {
    console.error('[run-traffic] Fatal:', err);
    process.exit(1);
  });
