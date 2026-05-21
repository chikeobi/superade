/**
 * lib/scheduler.js — Automated campaign scheduler
 *
 * Checks every hour (via node-cron) whether any client has a scheduled
 * campaign window active for today. If so, fires the full
 * Scout → Brain → (auto-approve) → Connector pipeline automatically.
 *
 * Schedule config lives on the clients row:
 *   schedule_start_date  — first day to run (date, e.g. "2026-06-01")
 *   schedule_days        — how many consecutive days to run
 *   schedule_run_hour    — local hour to trigger (0-23, e.g. 8 = 8am)
 *   schedule_timezone    — IANA tz string, e.g. "America/New_York"
 *   schedule_active      — boolean gate; set false to pause scheduling
 */

import cron from 'node-cron';
import { supabase } from './supabase.js';
import { startPipeline, getJob } from './job-runner.js';


// ─── Timezone helpers ─────────────────────────────────────────────────────────

/** Returns the current local hour (0-23) in the given IANA timezone. */
function localHour(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '', 10);
    return isNaN(h) ? new Date().getUTCHours() : h % 24;
  } catch {
    return new Date().getUTCHours();
  }
}

/** Returns today's date string "YYYY-MM-DD" in the given IANA timezone. */
function localDateStr(timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}


// ─── Core check ───────────────────────────────────────────────────────────────

async function checkSchedules() {
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, name, schedule_start_date, schedule_days, schedule_run_hour, schedule_timezone')
    .eq('schedule_active', true)
    .eq('billing_status', 'active')
    .eq('is_paused', false);

  if (error) {
    console.error('[Scheduler] DB error:', error.message);
    return;
  }

  for (const client of clients || []) {
    try {
      const tz      = client.schedule_timezone || 'America/New_York';
      const today   = localDateStr(tz);
      const curHour = localHour(tz);

      // Only trigger at the configured local hour
      if (client.schedule_run_hour !== curHour) continue;

      // Check client is within the scheduled date window
      const startDate = new Date(client.schedule_start_date + 'T00:00:00');
      const endDate   = new Date(startDate);
      endDate.setDate(endDate.getDate() + (client.schedule_days || 1));
      const todayDate = new Date(today + 'T00:00:00');
      if (todayDate < startDate || todayDate >= endDate) continue;

      // Idempotency guard — only one run per client per day
      const { count } = await supabase
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', client.id)
        .eq('type', 'campaign.scheduled_run')
        .gte('created_at', `${today}T00:00:00Z`);

      if ((count ?? 0) > 0) {
        console.log(`[Scheduler] ${client.name}: already ran today — skipping.`);
        continue;
      }

      if (getJob(client.id).status === 'running') {
        console.log(`[Scheduler] ${client.name}: pipeline already running — skipping.`);
        continue;
      }

      const dayNum = Math.floor((todayDate - startDate) / 86400000) + 1;
      console.log(`[Scheduler] Firing for ${client.name} (day ${dayNum}/${client.schedule_days})`);

      // autoApprove: skip manual review; scheduled: logs campaign.scheduled_run event
      startPipeline(client.id, { autoApprove: true, scheduled: true });

    } catch (err) {
      console.error(`[Scheduler] Error for ${client.name || client.id}:`, err.message);
    }
  }
}


// ─── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Starts the hourly cron and runs an immediate check on boot
 * (so a server restart mid-hour doesn't miss a scheduled window).
 */
export function startScheduler() {
  // Run at the top of every hour
  cron.schedule('0 * * * *', () => {
    checkSchedules().catch(err => console.error('[Scheduler] Check failed:', err.message));
  });

  // Also check immediately on startup
  checkSchedules().catch(err => console.error('[Scheduler] Startup check failed:', err.message));

  console.log('[Scheduler] Started — checks at the top of every hour.');
}
