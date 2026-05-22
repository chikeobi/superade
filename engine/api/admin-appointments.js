/**
 * api/admin-appointments.js — Appointments admin pages
 *
 * GET  /admin/appointments                    → list all bookings
 * POST /admin/appointments/:id/status         → update booking status
 * GET  /admin/appointments/availability       → availability settings
 * POST /admin/appointments/availability/save  → save availability settings
 *
 * Mounted on adminRouter inside admin.js.
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';

const up = express.urlencoded({ extended: false });

// ─── Shared nav shell (mirrors admin.js pattern) ──────────────────────────────

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAYS_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function apptShell(title, body, activeTab = '/admin/appointments') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Suparade Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,500&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Outfit',sans-serif;background:#f7f5f2;color:#1a1a1a;min-height:100vh}
    a{color:inherit;text-decoration:none}
    nav{height:64px;display:flex;align-items:center;border-bottom:1px solid #e8e5e0;background:#faf9f6;position:sticky;top:0;z-index:100}
    .nav-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px}
    .nav-tag{font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb;background:#f0ede8;padding:3px 10px;border-radius:100px}
    .navtab{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:6px 14px;border-radius:100px;text-decoration:none;transition:all .15s;white-space:nowrap}
    .navtab-on{background:#1a1a1a;color:#faf9f6}
    .navtab-off{color:#aaa}
    .navtab-off:hover{color:#1a1a1a;background:#f0ede8}
    .nav-meta{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb}
    .nav-logout{font-family:'Outfit',sans-serif;font-size:13px;color:#888;text-decoration:none;transition:color .15s}
    .nav-logout:hover{color:#1a1a1a}
    .agbar{position:sticky;top:64px;z-index:99;border-bottom:1px solid #e8e5e0;background:rgba(250,249,246,.97);backdrop-filter:blur(10px)}
    .agbar-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;gap:0}
    .agbar-tab{font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;color:#999;text-decoration:none;padding:12px 18px;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;display:block}
    .agbar-tab:hover{color:#1a1a1a}
    .agbar-tab.on{color:#1a1a1a;border-bottom-color:#1a1a1a;font-weight:600}
    .container{max-width:1200px;margin:0 auto;padding:32px clamp(20px,4vw,48px) 80px}
    .card{background:#fff;border:1px solid #e8e5e0;border-radius:14px;margin-bottom:24px;overflow:hidden}
    .ch{padding:20px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #f0ede8}
    .ct{font-family:'Outfit',sans-serif;font-size:16px;font-weight:700}
    .badge{display:inline-block;font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:3px 10px;border-radius:100px}
    .bg{background:#dcfce7;color:#16a34a}
    .by{background:#fef9c3;color:#a16207}
    .br{background:#fee2e2;color:#dc2626}
    .bk{background:#f0ede8;color:#888}
    .btn{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;padding:7px 16px;border-radius:100px;border:none;cursor:pointer;text-decoration:none;display:inline-block;transition:all .15s}
    .btn-dark{background:#1a1a1a;color:#faf9f6}
    .btn-dark:hover{background:#333}
    .btn-ghost{background:none;border:1px solid #e8e5e0;color:#888}
    .btn-ghost:hover{border-color:#1a1a1a;color:#1a1a1a}
    .btn-green{background:#dcfce7;color:#16a34a}
    .btn-red{background:#fee2e2;color:#dc2626}
    .empty{padding:40px 24px;text-align:center;color:#bbb;font-size:14px}
    table{width:100%;border-collapse:collapse}
    th{font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#bbb;padding:12px 20px;text-align:left;border-bottom:1px solid #f0ede8}
    td{padding:14px 20px;border-bottom:1px solid #f8f6f3;font-size:14px;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .ph{margin-bottom:28px}
    .ph-title{font-family:'Source Serif 4',Georgia,serif;font-size:clamp(28px,3vw,38px);font-weight:400;letter-spacing:-.5px}
    .ph-title em{font-style:italic}
    .ph-sub{font-family:'Outfit',sans-serif;font-size:15px;color:#888;margin-top:6px}
    .form-i{font-family:'Outfit',sans-serif;font-size:14px;padding:9px 14px;border:1.5px solid #e8e5e0;border-radius:10px;background:#fff;color:#1a1a1a;outline:none;width:100%;transition:border-color .2s}
    .form-i:focus{border-color:#1a1a1a}
  </style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <div style="display:flex;align-items:center;gap:14px">
      <a href="https://suparade.com" class="nav-logo">Suparade</a>
      <span class="nav-tag">Admin</span>
    </div>
    <div style="display:flex;align-items:center;gap:4px">
      <a href="/admin" class="navtab navtab-off">Outbound</a>
      <a href="/admin/inbound" class="navtab navtab-off">Inbound</a>
      <a href="/admin/appointments" class="navtab navtab-on">Appointments</a>
    </div>
    <div style="display:flex;align-items:center;gap:20px">
      <span class="nav-meta">${new Date().toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span>
      <a href="/admin/logout" class="nav-logout">Sign out</a>
    </div>
  </div>
</nav>
<div class="agbar">
  <div class="agbar-inner">
    <a href="/admin/appointments" class="agbar-tab${activeTab === '/admin/appointments' ? ' on' : ''}">Bookings</a>
    <a href="/admin/appointments/availability" class="agbar-tab${activeTab === '/admin/appointments/availability' ? ' on' : ''}">Availability</a>
  </div>
</div>
<div class="container">
${body}
</div>
</body>
</html>`;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function statusBadge(s) {
  const map = { pending: 'by', confirmed: 'bg', cancelled: 'br' };
  return `<span class="badge ${map[s] || 'bk'}">${esc(s)}</span>`;
}

// ─── Format date + time ───────────────────────────────────────────────────────

function fmtDate(d) {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtTime(t) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2,'0')} ${ampm} ET`;
}

// ─── Register routes ──────────────────────────────────────────────────────────

export function registerAppointmentRoutes(router, requireAuth) {

  // ── GET /admin/appointments ────────────────────────────────────────────────

  router.get('/appointments', requireAuth, async (req, res) => {
    const { data: bookings } = await supabase
      .from('bookings')
      .select('*')
      .order('date', { ascending: true })
      .order('time_slot', { ascending: true });

    const upcoming = (bookings || []).filter(b => b.date >= new Date().toISOString().slice(0,10) && b.status !== 'cancelled');
    const past     = (bookings || []).filter(b => b.date <  new Date().toISOString().slice(0,10) || b.status === 'cancelled');

    function bookingRow(b) {
      return `<tr>
        <td>
          <div style="font-weight:600">${esc(b.name)}</div>
          <div style="color:#888;font-size:13px">${esc(b.email)}</div>
          ${b.phone ? `<div style="color:#aaa;font-size:12px">${esc(b.phone)}</div>` : ''}
        </td>
        <td>${b.business_type ? `<span style="background:#f0ede8;padding:3px 10px;border-radius:100px;font-size:12px">${esc(b.business_type)}</span>` : '—'}</td>
        <td>
          <div style="font-weight:600">${fmtDate(b.date)}</div>
          <div style="color:#888;font-size:13px">${fmtTime(b.time_slot)}</div>
        </td>
        <td>${statusBadge(b.status)}</td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${b.status !== 'confirmed'  ? `<form method="POST" action="/admin/appointments/${b.id}/status" style="display:inline"><input type="hidden" name="status" value="confirmed"><button class="btn btn-green" type="submit">Confirm</button></form>` : ''}
            ${b.status !== 'cancelled'  ? `<form method="POST" action="/admin/appointments/${b.id}/status" style="display:inline"><input type="hidden" name="status" value="cancelled"><button class="btn btn-red" type="submit">Cancel</button></form>` : ''}
            ${b.status !== 'pending'    ? `<form method="POST" action="/admin/appointments/${b.id}/status" style="display:inline"><input type="hidden" name="status" value="pending"><button class="btn btn-ghost" type="submit">Reset</button></form>` : ''}
          </div>
        </td>
      </tr>`;
    }

    const upcomingHtml = upcoming.length
      ? `<table><thead><tr><th>Contact</th><th>Business</th><th>When</th><th>Status</th><th>Actions</th></tr></thead><tbody>${upcoming.map(bookingRow).join('')}</tbody></table>`
      : `<div class="empty">No upcoming bookings.</div>`;

    const pastHtml = past.length
      ? `<table><thead><tr><th>Contact</th><th>Business</th><th>When</th><th>Status</th><th>Actions</th></tr></thead><tbody>${past.map(bookingRow).join('')}</tbody></table>`
      : '';

    const body = `
<div class="ph">
  <div class="ph-title">Appointments</div>
  <div class="ph-sub">${upcoming.length} upcoming · ${past.length} past / cancelled</div>
</div>
<div class="card">
  <div class="ch"><span class="ct">Upcoming</span></div>
  ${upcomingHtml}
</div>
${past.length ? `<div class="card"><div class="ch"><span class="ct" style="color:#bbb">Past &amp; Cancelled</span></div>${pastHtml}</div>` : ''}`;

    res.send(apptShell('Appointments', body, '/admin/appointments'));
  });

  // ── POST /admin/appointments/:id/status ────────────────────────────────────

  router.post('/appointments/:id/status', requireAuth, up, async (req, res) => {
    const { status } = req.body;
    if (!['pending','confirmed','cancelled'].includes(status)) return res.redirect('/admin/appointments');
    await supabase.from('bookings').update({ status }).eq('id', req.params.id);
    res.redirect('/admin/appointments');
  });

  // ── GET /admin/appointments/availability ───────────────────────────────────

  router.get('/appointments/availability', requireAuth, async (_req, res) => {
    const { data: rows } = await supabase
      .from('availability')
      .select('day_of_week, time_slot, enabled')
      .eq('enabled', true)
      .order('time_slot');

    // For each day, find the min and max enabled slot
    const byDay = {};
    for (let d = 0; d < 7; d++) byDay[d] = [];
    for (const r of rows || []) byDay[r.day_of_week].push(r.time_slot);

    // Generate time options 6am–8pm for dropdowns
    const timeOpts = [];
    for (let h = 6; h <= 20; h++) {
      timeOpts.push(`${String(h).padStart(2,'0')}:00`);
      if (h < 20) timeOpts.push(`${String(h).padStart(2,'0')}:30`);
    }

    function timeSelect(name, selected, disabled) {
      const opts = timeOpts.map(t => `<option value="${t}"${t === selected ? ' selected' : ''}>${fmtTime(t)}</option>`).join('');
      return `<select name="${name}" ${disabled ? 'disabled ' : ''}style="font-family:'Outfit',sans-serif;font-size:14px;padding:8px 12px;border:1.5px solid #e8e5e0;border-radius:8px;background:#fff;color:#1a1a1a;outline:none;cursor:pointer;transition:opacity .15s;${disabled ? 'opacity:.35;' : ''}">${opts}</select>`;
    }

    const dayRows = [1,2,3,4,5,6,0].map(d => {
      const slots   = byDay[d].sort();
      const on      = slots.length > 0;
      const start   = slots[0]  || '09:00';
      const endSlot = slots[slots.length - 1] || '17:00';
      // end = one 30-min step after the last slot
      const endIdx  = timeOpts.indexOf(endSlot);
      const end     = endIdx >= 0 && endIdx + 1 < timeOpts.length ? timeOpts[endIdx + 1] : endSlot;

      return `<div class="avail-row" id="row-${d}">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;flex-shrink:0">
          <input type="checkbox" name="day_${d}_on" value="1" ${on ? 'checked' : ''}
            onchange="toggleRow(${d},this.checked)"
            style="width:16px;height:16px;cursor:pointer;accent-color:#1a1a1a">
          <span style="font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;width:36px;color:${on ? '#1a1a1a' : '#bbb'}" id="lbl-${d}">${DAYS_SHORT[d]}</span>
        </label>
        <div id="times-${d}" style="display:flex;align-items:center;gap:10px;${!on ? 'opacity:.35;pointer-events:none' : ''}">
          ${timeSelect(`day_${d}_start`, start, false)}
          <span style="font-family:'Outfit',sans-serif;font-size:14px;color:#bbb">to</span>
          ${timeSelect(`day_${d}_end`, end, false)}
        </div>
        <div id="off-${d}" style="font-family:'Outfit',sans-serif;font-size:14px;color:#bbb;${on ? 'display:none' : ''}">Unavailable</div>
      </div>`;
    }).join('');

    const body = `
<div class="ph">
  <div class="ph-title">Availability</div>
  <div class="ph-sub">Your weekly schedule — repeats every week. All times in ET.</div>
</div>
<form method="POST" action="/admin/appointments/availability/save">
  <div class="card" style="padding:8px 0">
    ${dayRows}
    <div style="padding:16px 28px;border-top:1px solid #f0ede8;display:flex;justify-content:flex-end">
      <button type="submit" class="btn btn-dark">Save</button>
    </div>
  </div>
</form>
<style>
  .avail-row{display:flex;align-items:center;gap:24px;padding:16px 28px;border-bottom:1px solid #f8f6f3;flex-wrap:wrap}
  .avail-row:last-of-type{border-bottom:none}
</style>
<script>
function toggleRow(d, on) {
  document.getElementById('lbl-' + d).style.color = on ? '#1a1a1a' : '#bbb';
  document.getElementById('times-' + d).style.opacity = on ? '1' : '.35';
  document.getElementById('times-' + d).style.pointerEvents = on ? '' : 'none';
  document.getElementById('off-' + d).style.display = on ? 'none' : '';
}
</script>`;

    res.send(apptShell('Availability', body, '/admin/appointments/availability'));
  });

  // ── POST /admin/appointments/availability/save ─────────────────────────────

  router.post('/appointments/availability/save', requireAuth, up, async (req, res) => {
    // Generate all possible half-hour slots 6am–8pm
    const allSlots = [];
    for (let h = 6; h < 20; h++) {
      allSlots.push(`${String(h).padStart(2,'0')}:00`);
      allSlots.push(`${String(h).padStart(2,'0')}:30`);
    }

    const rows = [];
    for (let d = 0; d < 7; d++) {
      const on    = req.body[`day_${d}_on`] === '1';
      const start = req.body[`day_${d}_start`] || '09:00';
      const end   = req.body[`day_${d}_end`]   || '17:00';

      for (const slot of allSlots) {
        const enabled = on && slot >= start && slot < end;
        rows.push({ day_of_week: d, time_slot: slot, enabled });
      }
    }

    await supabase.from('availability').upsert(rows, { onConflict: 'day_of_week,time_slot' });
    res.redirect('/admin/appointments/availability');
  });
}
