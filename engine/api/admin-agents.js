/**
 * engine/api/admin-agents.js — Outbound agent controls
 *
 * Exports:
 *   buildAgentControlsHtml(agents) — renders the "Agent Controls" section
 *   registerAgentRoutes(router, requireAuth) — POST routes for toggle/run/schedule
 *   startOutboundScheduler() — kicks off the 60-second interval scheduler
 */

import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, '..');

const AGENT_SCRIPTS = {
  'outbound.scout':     path.join(ENGINE_DIR, 'agents/scout.js'),
  'outbound.brain':     path.join(ENGINE_DIR, 'agents/brain.js'),
  'outbound.connector': path.join(ENGINE_DIR, 'agents/connector.js'),
  'outbound.reporter':  path.join(ENGINE_DIR, 'scripts/reporter.js'),
};

// ─── Button styles (inline, matching outbound dashboard) ──────────────────────

const B  = `font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;padding:7px 16px;border-radius:100px;cursor:pointer;line-height:1;white-space:nowrap;border:none`;
const BD = `${B};background:#1a1a1a;color:#faf9f6`;
const BG = `${B};background:transparent;color:#666;border:1.5px solid #e8e5e0`;
const BGN = `${B};background:#16a34a14;color:#16a34a;border:1px solid #16a34a30`;
const BRD = `${B};background:#dc262614;color:#dc2626;border:1px solid #dc262630`;

// ─── Schedule helpers ─────────────────────────────────────────────────────────

function parseSchedule(val) {
  if (!val || val === 'manual') return { type: 'manual', value: null };
  if (val.startsWith('interval_')) return { type: 'interval', value: val.replace('interval_', '') };
  if (val.startsWith('daily_'))    return { type: 'daily',    value: val.replace('daily_', '') };
  return { type: 'manual', value: null };
}

function scheduleKey(a) {
  if (a.schedule_type === 'interval') return `interval_${a.schedule_value}`;
  if (a.schedule_type === 'daily')    return `daily_${a.schedule_value}`;
  return 'manual';
}

function scheduleOptions(selected) {
  const opts = [
    ['manual',      'Manual only'],
    ['interval_4',  'Every 4h'],
    ['interval_6',  'Every 6h'],
    ['interval_12', 'Every 12h'],
    ['interval_24', 'Every 24h'],
    ['daily_8',     'Daily 8am ET'],
  ];
  return opts.map(([v, l]) =>
    `<option value="${v}"${selected === v ? ' selected' : ''}>${l}</option>`
  ).join('');
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function runBadge(status, alwaysOn) {
  if (alwaysOn) return `<span style="font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px;background:#16a34a14;color:#16a34a;border:1px solid #16a34a30">Always On</span>`;
  const map = {
    success: `background:#16a34a14;color:#16a34a;border:1px solid #16a34a30`,
    failed:  `background:#dc262614;color:#dc2626;border:1px solid #dc262630`,
    running: `background:#2563eb14;color:#2563eb;border:1px solid #2563eb30`,
  };
  const s = status ? (map[status] || `background:#f0ede8;color:#888;border:1px solid #e0dcd5`) : `background:#f0ede8;color:#888;border:1px solid #e0dcd5`;
  const label = status || 'Never run';
  return `<span style="font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px;${s}">${label}</span>`;
}

// ─── Single agent row ─────────────────────────────────────────────────────────

function agentRow(a) {
  const lastRun = a.last_run_at
    ? new Date(a.last_run_at).toLocaleString('en-US', {
        timeZone: 'America/New_York', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : '—';

  const isRunning = a.last_run_status === 'running';
  const canRun    = a.enabled && !a.always_on && !isRunning;

  const toggleBtn = a.always_on
    ? `<span style="font-family:'Outfit',sans-serif;font-size:12px;color:#bbb">Always on</span>`
    : `<form method="POST" action="/admin/agents/${a.id}/toggle" style="display:inline">
         <button style="${a.enabled ? BGN : BRD}">${a.enabled ? 'Enabled' : 'Disabled'}</button>
       </form>`;

  const runBtn = a.always_on ? '' :
    `<form method="POST" action="/admin/agents/${a.id}/run" style="display:inline">
       <button style="${BD}${!canRun ? ';opacity:.4;cursor:not-allowed' : ''}" ${!canRun ? 'disabled' : ''}>${isRunning ? '⟳ Running…' : 'Run Now'}</button>
     </form>`;

  return `
<div style="padding:16px 28px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
  <div style="flex:1;min-width:160px">
    <div style="font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;color:#1a1a1a">${a.name}</div>
    <div style="font-family:'Outfit',sans-serif;font-size:12px;color:#999;margin-top:2px">${a.description || ''}</div>
  </div>
  <div style="text-align:center;min-width:90px">
    ${runBadge(a.last_run_status, a.always_on)}
    <div style="font-family:'Outfit',sans-serif;font-size:11px;color:#bbb;margin-top:4px">${lastRun}</div>
  </div>
  <form method="POST" action="/admin/agents/${a.id}/schedule" style="display:flex;align-items:center;gap:6px">
    <select name="schedule" style="font-family:'Outfit',sans-serif;font-size:13px;padding:6px 10px;border:1.5px solid #e8e5e0;border-radius:8px;background:#fff;color:#555;outline:none" ${a.always_on ? 'disabled' : ''}>
      ${scheduleOptions(scheduleKey(a))}
    </select>
    ${a.always_on ? '' : `<button type="submit" style="${BG}">Save</button>`}
  </form>
  <div style="display:flex;gap:8px;align-items:center">
    ${toggleBtn}
    ${runBtn}
  </div>
</div>`;
}

// ─── Compact agent bar (for the sticky sub-nav row) ──────────────────────────

const PREFIX = '/admin/agents';

function compactScheduleSelectOut(a) {
  const cur = scheduleKey(a);
  const opts = [
    ['manual',      '—'],
    ['interval_4',  '4h'],
    ['interval_6',  '6h'],
    ['interval_12', '12h'],
    ['interval_24', '24h'],
    ['daily_8',     '8am'],
  ].map(([v,l]) => `<option value="${v}"${cur===v?' selected':''}>${l}</option>`).join('');
  return `<form method="POST" action="${PREFIX}/${a.id}/schedule" style="display:inline">
    <select name="schedule" onchange="this.form.submit()" title="Schedule"
      style="border:none;background:none;font-family:'Outfit',sans-serif;font-size:10px;font-weight:600;color:#bbb;outline:none;cursor:pointer;-webkit-appearance:none;appearance:none;width:26px;text-align:center">${opts}</select>
  </form>`;
}

function compactPillOut(a) {
  if (a.always_on) {
    return `<div style="display:flex;align-items:center;gap:4px;border:1px solid #bbf7d0;background:#f0fdf4;border-radius:100px;padding:4px 10px 4px 7px">
      <span style="width:6px;height:6px;border-radius:50%;background:#16a34a;flex-shrink:0;display:inline-block"></span>
      <span style="font-family:'Outfit',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#16a34a;white-space:nowrap">${a.name}</span>
    </div>`;
  }
  const dotColor = !a.enabled ? '#bbb'
    : a.last_run_status === 'success' ? '#16a34a'
    : a.last_run_status === 'failed'  ? '#dc2626'
    : a.last_run_status === 'running' ? '#2563eb'
    : '#d1cfc9';
  const nameColor  = a.enabled ? '#555' : '#bbb';
  const isRunning  = a.last_run_status === 'running';
  const canRun     = a.enabled && !isRunning;
  return `<div style="display:flex;align-items:center;gap:3px;background:#f5f3ef;border:1px solid #e8e5e0;border-radius:100px;padding:4px 10px 4px 7px">
    <form method="POST" action="${PREFIX}/${a.id}/toggle" style="display:inline">
      <button type="submit" title="${a.enabled?'Disable':'Enable'}"
        style="width:6px;height:6px;border-radius:50%;background:${dotColor};border:none;cursor:pointer;padding:0;flex-shrink:0;display:block"></button>
    </form>
    <span style="font-family:'Outfit',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:${nameColor};margin:0 2px;white-space:nowrap">${a.name}</span>
    ${compactScheduleSelectOut(a)}
    <form method="POST" action="${PREFIX}/${a.id}/run" style="display:inline">
      <button type="submit" title="Run now" ${!canRun?'disabled':''}
        style="background:none;border:none;cursor:${canRun?'pointer':'not-allowed'};color:${canRun?'#888':'#ccc'};font-size:11px;padding:0 0 0 1px;line-height:1">▶</button>
    </form>
  </div>`;
}

export function buildCompactAgentBar(agents) {
  const pills = (agents || []).map(a => compactPillOut(a)).join('');
  return pills;
}

// ─── Full agent controls section HTML ─────────────────────────────────────────

export function buildAgentControlsHtml(agents) {
  const rows = (agents || []).map(a => agentRow(a)).join('');
  return `
<div style="background:#fff;border:1px solid #e8e5e0;border-radius:14px;overflow:hidden;margin-bottom:80px">
  <div style="padding:24px 28px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <span style="font-family:'Outfit',sans-serif;font-size:16px;font-weight:600;color:#1a1a1a">Agent Controls</span>
    <div style="display:flex;gap:8px">
      <form method="POST" action="/admin/agents/all/on" style="display:inline">
        <button style="${BGN}">Turn All On</button>
      </form>
      <form method="POST" action="/admin/agents/all/off" style="display:inline">
        <button style="${BRD}">Turn All Off</button>
      </form>
    </div>
  </div>
  ${rows || `<div style="font-family:'Outfit',sans-serif;color:#bbb;text-align:center;padding:48px;font-size:15px">No agents configured.</div>`}
</div>`;
}

// ─── Agent runner ─────────────────────────────────────────────────────────────

async function runAgent(agentId) {
  const script = AGENT_SCRIPTS[agentId];
  if (!script) return;

  // Guard: re-read DB status before spawning to prevent double-runs when the
  // scheduler tick and a manual "Run Now" click race, or when a detached child
  // from a previous server instance is still running and has not yet written back.
  const { data: current } = await supabase
    .from('agent_states').select('last_run_status').eq('id', agentId).single();
  if (current?.last_run_status === 'running') {
    console.log(`[agents:outbound] ${agentId} already running — skipping spawn.`);
    return;
  }

  await supabase.from('agent_states').update({
    last_run_at:      new Date().toISOString(),
    last_run_status:  'running',
    last_run_message: 'Running…',
    updated_at:       new Date().toISOString(),
  }).eq('id', agentId);

  const child = spawn('node', [script], {
    cwd:      ENGINE_DIR,
    detached: true,
    stdio:    ['ignore', 'pipe', 'pipe'],
    env:      { ...process.env },
  });

  let out = '';
  child.stdout?.on('data', d => { out += d; });
  child.stderr?.on('data', d => { out += d; });

  child.on('close', async code => {
    const status = code === 0 ? 'success' : 'failed';
    await supabase.from('agent_states').update({
      last_run_status:  status,
      last_run_message: out.trim().slice(-400) || (code === 0 ? 'Completed OK.' : `Exit ${code}`),
      updated_at:       new Date().toISOString(),
    }).eq('id', agentId);
    console.log(`[agents:outbound] ${agentId} → ${status}`);
  });

  child.unref();
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function shouldRun(a, now) {
  if (!a.enabled || a.always_on)          return false;
  if (a.last_run_status === 'running')     return false;
  if (a.schedule_type === 'manual')        return false;
  if (a.schedule_type === 'interval') {
    const ms = parseInt(a.schedule_value, 10) * 3_600_000;
    if (!a.last_run_at) return true;
    return (now - new Date(a.last_run_at)) >= ms;
  }
  if (a.schedule_type === 'daily') {
    const h  = parseInt(a.schedule_value, 10);
    const ET = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (ET.getHours() < h) return false;
    if (!a.last_run_at) return true;
    const lastET = new Date(new Date(a.last_run_at).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return lastET.toDateString() !== ET.toDateString();
  }
  return false;
}

export async function startOutboundScheduler() {
  await supabase.from('agent_states')
    .update({ last_run_status: 'failed', last_run_message: 'Server restarted mid-run.', updated_at: new Date().toISOString() })
    .eq('system', 'outbound').eq('last_run_status', 'running');

  setInterval(async () => {
    const { data: agents } = await supabase.from('agent_states').select('*').eq('system', 'outbound');
    const now = new Date();
    for (const a of agents || []) {
      if (shouldRun(a, now)) {
        console.log(`[scheduler:outbound] triggering ${a.id}`);
        runAgent(a.id).catch(err => console.error(`[scheduler:outbound] ${a.id}:`, err.message));
      }
    }
  }, 60_000);

  console.log('[agents:outbound] Scheduler started.');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const up = express.urlencoded({ extended: false });

export function registerAgentRoutes(router, requireAuth) {
  const back = (req) => req.get('Referer') || '/admin';

  router.post('/agents/all/on', requireAuth, async (req, res) => {
    await supabase.from('agent_states')
      .update({ enabled: true, updated_at: new Date().toISOString() })
      .eq('system', 'outbound').eq('always_on', false);
    res.redirect(back(req));
  });

  router.post('/agents/all/off', requireAuth, async (req, res) => {
    await supabase.from('agent_states')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('system', 'outbound').eq('always_on', false);
    res.redirect(back(req));
  });

  router.post('/agents/:id/toggle', requireAuth, async (req, res) => {
    const { data } = await supabase.from('agent_states').select('enabled').eq('id', req.params.id).single();
    await supabase.from('agent_states')
      .update({ enabled: !data?.enabled, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.redirect(back(req));
  });

  router.post('/agents/:id/run', requireAuth, async (req, res) => {
    const { data } = await supabase.from('agent_states')
      .select('enabled,last_run_status,always_on').eq('id', req.params.id).single();
    if (data?.enabled && !data?.always_on && data?.last_run_status !== 'running') {
      runAgent(req.params.id).catch(console.error);
    }
    res.redirect(back(req));
  });

  router.post('/agents/:id/schedule', requireAuth, up, async (req, res) => {
    const { type, value } = parseSchedule(req.body.schedule);
    await supabase.from('agent_states')
      .update({ schedule_type: type, schedule_value: value, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    res.redirect(back(req));
  });
}
