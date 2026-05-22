/**
 * api/admin.js — Internal admin dashboard
 *
 * GET  /admin/login → styled login form
 * POST /admin/login → validates password, sets signed session cookie
 * GET  /admin       → dashboard (requires valid session cookie)
 * GET  /admin/logout → clears cookie, redirects to login
 */

import express from 'express';
import crypto from 'crypto';
import { supabase } from '../lib/supabase.js';
import { getJob, startPipeline, pauseClient, resumeClient, stopJob, sendEmails } from '../lib/job-runner.js';
import { buildCompactAgentBar, buildAgentControlsHtml, registerAgentRoutes, startOutboundScheduler } from './admin-agents.js';
import { registerAppointmentRoutes } from './admin-appointments.js';

export const adminRouter = express.Router();

// ─── Session helpers ──────────────────────────────────────────────────────────

// A fixed HMAC token derived from the password — stateless, no DB needed.
function sessionToken() {
  return crypto
    .createHmac('sha256', process.env.ADMIN_PASSWORD || 'NEVER_ALLOW_BLANK_PASSWORD_123')
    .update('suparade-admin-session-v1')
    .digest('hex');
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function requireAuth(req, res, next) {
  const cookie   = getCookie(req, 'admin_sid');
  const expected = sessionToken();
  const cookieBuf   = Buffer.from(cookie || '');
  const expectedBuf = Buffer.from(expected);
  const valid =
    cookieBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(cookieBuf, expectedBuf);

  if (!valid) return res.redirect('/admin/login');
  next();
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

async function loadDashboardData() {
  const [{ data: clients }, { data: prospects }] = await Promise.all([
    supabase.from('clients').select('*').order('created_at', { ascending: false }),
    supabase.from('prospects').select('client_id, status'),
  ]);

  const counts = {};
  for (const p of prospects || []) {
    if (!counts[p.client_id]) {
      counts[p.client_id] = { total: 0, sent: 0, replied: 0, converted: 0 };
    }
    counts[p.client_id].total++;
    if (['sent','replied','converted'].includes(p.status)) counts[p.client_id].sent++;
    if (['replied','converted'].includes(p.status))        counts[p.client_id].replied++;
    if (p.status === 'converted')                          counts[p.client_id].converted++;
  }

  return { clients: clients || [], counts };
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600;8..60,700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">`;

const NAV_HTML = `
<nav>
  <div class="nav-inner">
    <div style="display:flex;align-items:center;gap:14px">
      <a href="https://suparade.com" class="nav-logo">Suparade</a>
      <span class="nav-tag">Admin</span>
    </div>
  </div>
</nav>`;

const FOOTER_HTML = `
<footer>
  <div class="footer-inner">
    <div class="footer-logo">Suparade</div>
    <div class="footer-links">
      <a href="/terms" class="footer-link">Terms</a>
      <a href="/policy" class="footer-link">Policy</a>
      <span class="footer-copy">© 2026 Suparade. All rights reserved.</span>
    </div>
  </div>
</footer>`;

// ─── Shared section nav (Outbound ↔ Inbound) ─────────────────────────────────

const SECNAV_CSS = `.navtab{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:6px 14px;border-radius:100px;text-decoration:none;transition:all .15s;white-space:nowrap}.navtab-on{background:#1a1a1a;color:#faf9f6}.navtab-off{color:#aaa}.navtab-off:hover{color:#1a1a1a;background:#f0ede8}.agbar{position:sticky;top:64px;z-index:99;border-bottom:1px solid #e8e5e0;background:rgba(250,249,246,.97);backdrop-filter:blur(10px)}.agbar-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;gap:0}.agbar-tab{font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;color:#999;text-decoration:none;padding:12px 18px;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;display:block}.agbar-tab:hover{color:#1a1a1a}.agbar-tab.on{color:#1a1a1a;border-bottom-color:#1a1a1a;font-weight:600}`;

const SECNAV_HTML = '';

// ─── Shared data ─────────────────────────────────────────────────────────────

const NICHES = [
  'Dentist / Orthodontist',
  'Personal Injury Lawyer',
  'Family Lawyer',
  'Real Estate Agent',
  'Financial Advisor',
  'HVAC (commercial)',
  'Cosmetic Surgeon',
  'Med Spa',
  'Business Consultant',
  'Mortgage Broker',
  'Insurance Broker',
  'Solar Installation',
];

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

// ─── Login page ───────────────────────────────────────────────────────────────

function loginPage(errorMsg = '', infoMsg = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin Login — Suparade</title>
  ${FONTS}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    ::selection{background:#1a1a1a;color:#faf9f6}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column}
    nav{height:64px;display:flex;align-items:center;border-bottom:1px solid #e8e5e0;background:#faf9f6}
    .nav-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
    .nav-tag{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;background:#efece6;color:#888;padding:5px 14px;border-radius:100px}
    .center{flex:1;display:flex;align-items:center;justify-content:center;padding:40px clamp(20px,4vw,48px)}
    .box{width:100%;max-width:420px}
    .badge{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:2.5px;color:#1a1a1a;background:#efece6;display:inline-block;padding:7px 18px;border-radius:100px;margin-bottom:28px}
    h1{font-size:clamp(30px,4vw,42px);font-weight:400;line-height:1.1;letter-spacing:-1px;margin-bottom:32px}
    h1 em{font-style:italic}
    .error{font-family:'Outfit',sans-serif;background:#fff0f0;border:1px solid #e00;border-radius:10px;padding:12px 16px;color:#c00;font-size:14px;margin-bottom:20px}
    .info{font-family:'Outfit',sans-serif;background:#f0fdf4;border:1px solid #16a34a35;border-radius:10px;padding:12px 16px;color:#16a34a;font-size:14px;margin-bottom:20px}
    .field-label{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:8px;display:block}
    .pw-wrap{position:relative}
    .pw-wrap input{width:100%;padding:14px 48px 14px 18px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:16px;color:#1a1a1a;background:#fff;outline:none;transition:border-color .2s}
    .pw-wrap input:focus{border-color:#1a1a1a}
    .pw-wrap input[type=text]{width:100%;padding:14px 48px 14px 18px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:16px;color:#1a1a1a;background:#fff;outline:none;transition:border-color .2s}
    .pw-wrap input[type=text]:focus{border-color:#1a1a1a}
    input::placeholder{color:#bbb}
    .eye-btn{position:absolute;right:14px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:4px;color:#bbb;display:flex;align-items:center;transition:color .15s}
    .eye-btn:hover{color:#555}
    .submit-btn{width:100%;margin-top:20px;padding:15px;background:#1a1a1a;color:#faf9f6;border:none;border-radius:100px;font-family:'Outfit',sans-serif;font-size:16px;font-weight:600;cursor:pointer;transition:all .25s}
    .submit-btn:hover{background:#333;transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.12)}
    .forgot-link{display:block;text-align:center;margin-top:18px;font-family:'Outfit',sans-serif;font-size:14px;color:#aaa;text-decoration:none;transition:color .15s;outline:none}
    .forgot-link:hover{color:#1a1a1a}
    .forgot-link:focus{outline:none}
    .forgot-panel{display:none;margin-top:28px;padding-top:28px;border-top:1px solid #e8e5e0}
    .forgot-panel.open{display:block}
    .forgot-title{font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;color:#1a1a1a;margin-bottom:6px}
    .forgot-sub{font-family:'Outfit',sans-serif;font-size:13px;color:#999;margin-bottom:16px;line-height:1.5}
    .forgot-btn{width:100%;padding:13px;background:#f0ede8;color:#1a1a1a;border:none;border-radius:100px;font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;cursor:pointer;transition:all .2s}
    .forgot-btn:hover{background:#e8e5e0}
    footer{border-top:1px solid #e8e5e0}
    .footer-inner{max-width:1200px;margin:0 auto;width:100%;padding:36px clamp(20px,4vw,48px) 48px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:14px;color:#888;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:14px;color:#888}
  </style>
</head>
<body>
${NAV_HTML}
<div class="center">
  <div class="box">
    <div class="badge">Admin</div>
    <h1>Welcome <em>back.</em></h1>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
    ${infoMsg  ? `<div class="info">${infoMsg}</div>`   : ''}
    <form method="POST" action="/admin/login">
      <label class="field-label" for="password">Password</label>
      <div class="pw-wrap">
        <input type="password" id="password" name="password" required placeholder="Enter your password" autofocus>
        <button type="button" class="eye-btn" id="eye-btn" aria-label="Toggle password visibility" onclick="togglePw()">
          <svg id="eye-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
            <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
          </svg>
        </button>
      </div>
      <button type="submit" class="submit-btn">Sign in →</button>
    </form>

    <a href="#" class="forgot-link" onclick="toggleForgot(event)">Forgot password?</a>

    <div class="forgot-panel" id="forgot-panel">
      <div class="forgot-title">Recover access</div>
      <div class="forgot-sub">A one-time sign-in link will be emailed to hello@suparade.com. It expires in 15 minutes.</div>
      <form method="POST" action="/admin/forgot-password">
        <button type="submit" class="forgot-btn">Generate recovery link →</button>
      </form>
    </div>
  </div>
</div>
${FOOTER_HTML}
<script>
  function togglePw() {
    var inp  = document.getElementById('password');
    var icon = document.getElementById('eye-icon');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    icon.innerHTML = show
      ? '<path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>'
      : '<path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>';
  }

  function toggleForgot(e) {
    e.preventDefault();
    var panel = document.getElementById('forgot-panel');
    var open  = panel.classList.toggle('open');
    if (open) {
      var err = document.querySelector('.error');
      if (err) err.style.display = 'none';
    }
  }
</script>
</body>
</html>`;
}

// ─── Dashboard page ───────────────────────────────────────────────────────────

function tierBadge(tier) {
  const styles = {
    starter: 'background:#efece6;color:#666;border:1px solid #e0dcd5',
    growth:  'background:#1a1a1a12;color:#1a1a1a;border:1px solid #1a1a1a30',
    scale:   'background:#1a1a1a;color:#faf9f6;border:1px solid #1a1a1a',
  };
  const s = styles[tier] || styles.starter;
  return `<span style="font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;padding:4px 12px;border-radius:100px;white-space:nowrap;${s}">${esc(tier)}</span>`;
}

function statusBadge(status) {
  const styles = {
    active:    'background:#16a34a14;color:#16a34a;border:1px solid #16a34a35',
    past_due:  'background:#ca8a0414;color:#ca8a04;border:1px solid #ca8a0435',
    cancelled: 'background:#dc262614;color:#dc2626;border:1px solid #dc262635',
  };
  const s = styles[status] || styles.active;
  return `<span style="font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;padding:4px 12px;border-radius:100px;white-space:nowrap;${s}">${esc(status.replace('_',' '))}</span>`;
}

function clientRow(client, cnt) {
  const c    = cnt || { total: 0, sent: 0, replied: 0, converted: 0 };
  const since = new Date(client.created_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const initial = esc((client.name || '?')[0].toUpperCase());
  const internalBadge = client.is_internal
    ? `<span style="font-family:'Outfit',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:#f0ede8;color:#aaa;padding:2px 8px;border-radius:100px;margin-left:6px;vertical-align:middle">Internal</span>`
    : '';

  return `<tr>
    <td>
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:100px;background:#efece6;display:flex;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;font-size:14px;font-weight:700;color:#666;flex-shrink:0">${initial}</div>
        <div>
          <div style="font-family:'Outfit',sans-serif;font-weight:600;font-size:15px;color:#1a1a1a"><a href="/admin/clients/${client.id}" style="color:inherit;text-decoration:none;transition:color .15s" onmouseover="this.style.color='#555'" onmouseout="this.style.color='inherit'">${esc(client.name)}</a>${internalBadge}</div>
          <div style="font-family:'Outfit',sans-serif;font-size:13px;color:#999;margin-top:1px">${esc(client.email)}</div>
        </div>
      </div>
    </td>
    <td>${tierBadge(client.tier)}</td>
    <td>${statusBadge(client.billing_status)}</td>
    <td style="text-align:right;font-family:'Outfit',sans-serif;font-size:15px;color:#1a1a1a;font-weight:500">${c.total.toLocaleString()}</td>
    <td style="text-align:right;font-family:'Outfit',sans-serif;font-size:15px;color:#555">${c.sent.toLocaleString()}</td>
    <td style="text-align:right;font-family:'Outfit',sans-serif;font-size:15px;color:#555">${c.replied}</td>
    <td style="text-align:right;font-family:'Outfit',sans-serif;font-size:15px;color:#555">${c.converted}</td>
    <td style="font-family:'Outfit',sans-serif;font-size:13px;color:#999;white-space:nowrap">${since}</td>
  </tr>`;
}

function dashboardPage(clients, counts, agents = []) {
  const totalProspects = Object.values(counts).reduce((s, c) => s + c.total, 0);
  const totalSent      = Object.values(counts).reduce((s, c) => s + c.sent, 0);
  const totalReplies   = Object.values(counts).reduce((s, c) => s + c.replied, 0);
  const replyRate      = totalSent > 0 ? ((totalReplies / totalSent) * 100).toFixed(1) + '%' : '—';
  const activeClients  = clients.filter(c => c.billing_status === 'active').length;

  const clientRows = clients.length
    ? clients.map(c => clientRow(c, counts[c.id])).join('')
    : `<tr><td colspan="8" style="text-align:center;font-family:'Outfit',sans-serif;color:#999;padding:60px;font-size:16px">No clients yet.</td></tr>`;

  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin — Suparade</title>
  ${FONTS}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    ::selection{background:#1a1a1a;color:#faf9f6}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh}
    nav{position:sticky;top:0;z-index:100;height:64px;display:flex;align-items:center;background:rgba(250,249,246,.95);backdrop-filter:blur(14px);border-bottom:1px solid #e8e5e0}
    .nav-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
    .nav-tag{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;background:#efece6;color:#888;padding:5px 14px;border-radius:100px}
    .nav-meta{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb}
    .nav-logout{font-family:'Outfit',sans-serif;font-size:13px;color:#888;text-decoration:none;transition:color .15s}
    .nav-logout:hover{color:#1a1a1a}
    .container{max-width:1200px;margin:0 auto;padding:0 clamp(20px,4vw,48px)}
    .page-header{padding:48px 0 40px;border-bottom:1px solid #e8e5e0}
    .section-label{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:2.5px;color:#888;margin-bottom:12px}
    h1{font-size:clamp(32px,4vw,44px);font-weight:400;line-height:1.1;letter-spacing:-1px;margin-bottom:8px}
    h1 em{font-style:italic}
    .page-sub{font-family:'Outfit',sans-serif;font-size:16px;color:#999}
    .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:40px 0}
    .stat-card{background:#fff;border:1px solid #e8e5e0;border-radius:14px;padding:24px 28px;transition:transform .25s,box-shadow .25s}
    .stat-card:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.06)}
    .stat-card-label{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#aaa;margin-bottom:10px}
    .stat-card-value{font-family:'Outfit',sans-serif;font-size:36px;font-weight:400;letter-spacing:-.5px;color:#1a1a1a;line-height:1}
    .table-card{background:#fff;border:1px solid #e8e5e0;border-radius:14px;overflow:hidden;margin-bottom:80px}
    .table-header{padding:24px 28px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;justify-content:space-between}
    .table-title{font-family:'Outfit',sans-serif;font-size:16px;font-weight:600;color:#1a1a1a}
    .table-count{font-family:'Outfit',sans-serif;font-size:14px;color:#999}
    .table-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse;min-width:800px}
    thead tr{border-bottom:1px solid #f0ede8}
    th{font-family:'Outfit',sans-serif;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#bbb;padding:14px 20px;text-align:left;white-space:nowrap}
    th.r{text-align:right}
    td{padding:18px 20px;border-bottom:1px solid #f9f8f6;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tbody tr{transition:background .12s}
    tbody tr:hover td{background:#faf9f6}
    .divider{border-top:1px solid #e8e5e0}
    footer{}
    .footer-inner{display:flex;justify-content:space-between;align-items:center;padding:36px 0 48px;flex-wrap:wrap;gap:16px}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:14px;color:#888;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:14px;color:#888}
    @media(max-width:900px){.stats-grid{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:560px){.stats-grid{grid-template-columns:1fr}.nav-meta{display:none}}
    ${SECNAV_CSS}
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
      <a href="/admin" class="navtab navtab-on">Outbound</a>
      <a href="/admin/inbound" class="navtab navtab-off">Inbound</a>
      <a href="/admin/appointments" class="navtab navtab-off">Appointments</a>
    </div>
    <div style="display:flex;align-items:center;gap:24px">
      <span class="nav-meta">${now} ET</span>
      <a href="/admin/logout" class="nav-logout">Sign out</a>
    </div>
  </div>
</nav>
<div class="agbar">
  <div class="agbar-inner">
    <a href="/admin" class="agbar-tab on">Overview</a>
    <a href="/admin/agents" class="agbar-tab">Agent Controls</a>
  </div>
</div>
<div class="container">
  <div class="stats-grid" style="padding-top:40px">
    <div class="stat-card"><div class="stat-card-label">Total Clients</div><div class="stat-card-value">${clients.length}</div></div>
    <div class="stat-card"><div class="stat-card-label">Prospects Found</div><div class="stat-card-value">${totalProspects.toLocaleString()}</div></div>
    <div class="stat-card"><div class="stat-card-label">Replies</div><div class="stat-card-value">${totalReplies}</div></div>
    <div class="stat-card"><div class="stat-card-label">Reply Rate</div><div class="stat-card-value">${replyRate}</div></div>
  </div>

  <div class="table-card">
    <div class="table-header">
      <span class="table-title">Clients</span>
      <div style="display:flex;align-items:center;gap:16px">
        <span class="table-count">${clients.length} total</span>
        <a href="/admin/add-client" style="font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;color:#faf9f6;background:#1a1a1a;padding:9px 20px;border-radius:100px;text-decoration:none;transition:all .2s;white-space:nowrap">Add Client +</a>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Client</th><th>Tier</th><th>Status</th>
            <th class="r">Prospects</th><th class="r">Sent</th>
            <th class="r">Replies</th><th class="r">Converted</th><th>Since</th>
          </tr>
        </thead>
        <tbody>${clientRows}</tbody>
      </table>
    </div>
  </div>

  <div class="divider"></div>
  ${FOOTER_HTML}
</div>
</body>
</html>`;
}

// ─── Client detail page ───────────────────────────────────────────────────────

function clientDetailPage(client) {
  const initial = esc((client.name || '?')[0].toUpperCase());
  const sel = (arr, v) => (arr || []).includes(v) ? 'checked' : '';

  const nichePills = NICHES.map(n => {
    const id = 'cn-' + n.replace(/\s+/g, '').toLowerCase();
    return `<input type="checkbox" id="${id}" name="niche" value="${esc(n)}" ${sel(client.target_niche, n)}><label for="${id}">${esc(n)}</label>`;
  }).join('');

  const statePills = US_STATES.map(s => {
    const id = 'cs-' + s.toLowerCase();
    return `<input type="checkbox" id="${id}" name="state" value="${s}" ${sel(client.target_states, s)}><label for="${id}">${s}</label>`;
  }).join('');

  const TIMEZONES = [
    ['America/New_York','Eastern (ET)'],['America/Chicago','Central (CT)'],
    ['America/Denver','Mountain (MT)'],['America/Los_Angeles','Pacific (PT)'],
    ['America/Anchorage','Alaska (AKT)'],['Pacific/Honolulu','Hawaii (HT)'],
  ];
  const runHour = client.schedule_run_hour ?? 8;
  const hourOptions = Array.from({length:24}, (_,h) => {
    const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
    return `<option value="${h}"${runHour === h ? ' selected' : ''}>${label}</option>`;
  }).join('');
  const curTz = client.schedule_timezone || 'America/New_York';
  const tzOptions = TIMEZONES.map(([v,l]) =>
    `<option value="${v}"${curTz === v ? ' selected' : ''}>${l}</option>`
  ).join('');

  const internalTag = client.is_internal
    ? `<span style="font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;background:#f0ede8;color:#aaa;padding:4px 12px;border-radius:100px">Internal</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(client.name)} — Suparade Admin</title>
  ${FONTS}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    ::selection{background:#1a1a1a;color:#faf9f6}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh}
    nav{position:sticky;top:0;z-index:100;height:64px;display:flex;align-items:center;background:rgba(250,249,246,.95);backdrop-filter:blur(14px);border-bottom:1px solid #e8e5e0}
    .nav-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
    .nav-tag{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;background:#efece6;color:#888;padding:5px 14px;border-radius:100px}
    .nav-logout{font-family:'Outfit',sans-serif;font-size:13px;color:#888;text-decoration:none;transition:color .15s}
    .nav-logout:hover{color:#1a1a1a}
    .container{max-width:1200px;margin:0 auto;padding:0 clamp(20px,4vw,48px) 80px}
    .back{font-family:'Outfit',sans-serif;font-size:14px;padding:32px 0 0}
    .back a{color:#888;text-decoration:none;transition:color .15s}.back a:hover{color:#1a1a1a}
    .ch{display:flex;align-items:center;gap:20px;padding:28px 0 32px;border-bottom:1px solid #e8e5e0;margin-bottom:32px}
    .ch-avatar{width:56px;height:56px;border-radius:100px;background:#efece6;display:flex;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;font-size:22px;font-weight:700;color:#666;flex-shrink:0}
    .ch-name{font-size:clamp(24px,3vw,32px);font-weight:400;letter-spacing:-.5px;line-height:1.1;margin-bottom:8px}
    .ch-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-family:'Outfit',sans-serif;font-size:14px;color:#999}
    .card{background:#fff;border:1px solid #e8e5e0;border-radius:14px;overflow:hidden;margin-bottom:24px}
    .card-hd{padding:20px 28px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;justify-content:space-between}
    .card-title{font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb}
    .card-bd{padding:24px 28px}
    .job-ind{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;color:#aaa;transition:color .3s}
    .job-step{font-family:'Outfit',sans-serif;font-size:14px;color:#888;min-height:20px;margin-bottom:18px}
    .brow{display:flex;flex-wrap:wrap;gap:10px}
    .btn-act{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;padding:11px 22px;border-radius:100px;cursor:pointer;transition:all .2s;line-height:1;border:none}
    .btn-start{background:#1a1a1a;color:#faf9f6}.btn-start:hover:not(:disabled){background:#333}
    .btn-start:disabled{background:#ddd;color:#aaa;cursor:not-allowed}
    .btn-pause{background:#ca8a04;color:#fff}.btn-pause:hover{background:#a16207}
    .btn-resume{background:#16a34a;color:#fff}.btn-resume:hover{background:#15803d}
    .btn-stop{background:#fff;color:#dc2626;border:1.5px solid #fecaca}.btn-stop:hover:not(:disabled){background:#fef2f2;border-color:#dc2626}
    .btn-stop:disabled{opacity:.35;cursor:not-allowed}
    .btn-send{background:#f5f3ef;color:#1a1a1a;border:1.5px solid #e8e5e0}.btn-send:hover{background:#efece6}
    .stats-bar{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:#e8e5e0;border:1px solid #e8e5e0;border-radius:14px;overflow:hidden;margin-bottom:24px}
    .sbar-item{background:#fff;padding:20px 16px;text-align:center}
    .sbar-val{font-family:'Outfit',sans-serif;font-size:28px;font-weight:400;letter-spacing:-.5px;color:#1a1a1a;margin-bottom:4px}
    .sbar-lbl{font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#bbb}
    .ssec{margin-bottom:24px}.ssec:last-child{margin-bottom:0}
    .slbl{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:10px}
    .pills{display:flex;flex-wrap:wrap;gap:8px}
    .pills input[type=checkbox]{display:none}
    .pills label{font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;padding:7px 16px;border:1.5px solid #e8e5e0;border-radius:100px;cursor:pointer;color:#666;background:#faf9f6;transition:all .15s;user-select:none}
    .pills label:hover{border-color:#1a1a1a;color:#1a1a1a}
    .pills input:checked + label{background:#1a1a1a;color:#faf9f6;border-color:#1a1a1a}
    .spills{max-height:148px;overflow-y:auto;padding:10px;border:1.5px solid #e8e5e0;border-radius:12px;background:#fff;display:flex;flex-wrap:wrap;gap:6px}
    .spills label{font-size:13px;padding:5px 12px;background:#fff}
    .quota-row{display:flex;align-items:center;gap:16px;margin-top:4px}
    .quota-input{width:140px;padding:12px 16px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:16px;color:#1a1a1a;background:#fff;outline:none;transition:border-color .2s}
    .quota-input:focus{border-color:#1a1a1a}
    .btn-save{font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;padding:13px 28px;border-radius:100px;border:none;background:#1a1a1a;color:#faf9f6;cursor:pointer;transition:all .25s}
    .btn-save:hover{background:#333;transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.12)}
    .evlog{max-height:380px;overflow-y:auto}
    .evrow{display:flex;align-items:center;justify-content:space-between;padding:13px 28px;border-bottom:1px solid #f9f8f6;gap:16px}
    .evrow:last-child{border-bottom:none}
    .evlbl{font-family:'Outfit',sans-serif;font-size:14px;color:#555;flex:1}
    .evtime{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb;white-space:nowrap}
    .evempty{font-family:'Outfit',sans-serif;color:#bbb;font-size:15px;text-align:center;padding:48px 28px}
    .live-dot{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;color:#16a34a}
    footer{border-top:1px solid #e8e5e0}
    .footer-inner{display:flex;justify-content:space-between;align-items:center;padding:36px 0 48px;flex-wrap:wrap;gap:16px}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:14px;color:#888;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:14px;color:#888}
    @media(max-width:720px){.stats-bar{grid-template-columns:repeat(3,1fr)}.ch{flex-direction:column}}
    @media(max-width:440px){.stats-bar{grid-template-columns:repeat(2,1fr)}}
    ${SECNAV_CSS}
    select.sched-sel{width:100%;padding:12px 16px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:15px;color:#1a1a1a;background:#fff;outline:none;transition:border-color .2s;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center}
    select.sched-sel:focus{border-color:#1a1a1a}
    input[type=date].quota-input{font-size:15px}
    .sched-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .sched-active-row{display:flex;align-items:center;gap:10px;font-family:'Outfit',sans-serif;font-size:15px;color:#555;margin-bottom:4px;cursor:pointer}
    .sched-active-row input[type=checkbox]{width:18px;height:18px;cursor:pointer;accent-color:#1a1a1a}
    @media(max-width:600px){.sched-grid{grid-template-columns:1fr}}
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
      <a href="/admin" class="navtab navtab-on">Outbound</a>
      <a href="/admin/inbound" class="navtab navtab-off">Inbound</a>
      <a href="/admin/appointments" class="navtab navtab-off">Appointments</a>
    </div>
    <div style="display:flex;align-items:center;gap:20px">
      <span class="nav-meta">${new Date().toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span>
      <a href="/admin/logout" class="nav-logout">Sign out</a>
    </div>
  </div>
</nav>
<div class="container">
  <div class="back"><a href="/admin">← All clients</a></div>

  <div class="ch">
    <div class="ch-avatar">${initial}</div>
    <div>
      <div class="ch-name">${esc(client.name)}</div>
      <div class="ch-meta">
        <span>${esc(client.email)}</span>
        ${tierBadge(client.tier)}
        ${statusBadge(client.billing_status)}
        ${internalTag}
      </div>
    </div>
  </div>

  <!-- Campaign controls -->
  <div class="card">
    <div class="card-hd">
      <span class="card-title">Campaign</span>
      <span class="job-ind" id="job-ind">● Idle</span>
    </div>
    <div class="card-bd">
      <div class="job-step" id="job-step"></div>
      <div class="brow">
        <button class="btn-act btn-start"  id="btn-start"  onclick="act('start')">▶ Start Campaign</button>
        <button class="btn-act btn-pause"  id="btn-pause"  onclick="act('pause')"  style="display:none">⏸ Pause</button>
        <button class="btn-act btn-resume" id="btn-resume" onclick="act('resume')" style="display:none">▶ Resume</button>
        <button class="btn-act btn-stop"   id="btn-stop"   onclick="act('stop')"   disabled>■ Stop</button>
        <button class="btn-act btn-send"   onclick="act('send')">Send Emails →</button>
      </div>
    </div>
  </div>

  <!-- Prospect stats -->
  <div class="stats-bar">
    <div class="sbar-item"><div class="sbar-val" id="s-total">—</div><div class="sbar-lbl">Prospects</div></div>
    <div class="sbar-item"><div class="sbar-val" id="s-researched">—</div><div class="sbar-lbl">Researched</div></div>
    <div class="sbar-item"><div class="sbar-val" id="s-sent">—</div><div class="sbar-lbl">Sent</div></div>
    <div class="sbar-item"><div class="sbar-val" id="s-replied">—</div><div class="sbar-lbl">Replied</div></div>
    <div class="sbar-item"><div class="sbar-val" id="s-converted">—</div><div class="sbar-lbl">Converted</div></div>
  </div>

  <!-- Settings -->
  <div class="card">
    <div class="card-hd"><span class="card-title">Settings</span></div>
    <div class="card-bd">
      <form method="POST" action="/admin/clients/${client.id}/settings">
        <div class="ssec">
          <div class="slbl">Niches</div>
          <div class="pills">${nichePills}</div>
        </div>
        <div class="ssec">
          <div class="slbl">Target Cities <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#bbb">(optional — overrides states)</span></div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
            <input type="text" id="det-city-zip" placeholder="ZIP" maxlength="5" class="quota-input" style="width:100px;flex-shrink:0">
            <select id="det-city-miles" class="sched-sel" style="width:auto;flex-shrink:0">
              <option value="5">5 mi</option>
              <option value="10">10 mi</option>
              <option value="25" selected>25 mi</option>
              <option value="50">50 mi</option>
            </select>
            <button type="button" onclick="addDetCity()" class="btn-act btn-send">+ Add</button>
          </div>
          <div id="det-city-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
          <div id="det-city-hidden"></div>
        </div>
        <div class="ssec">
          <div class="slbl">Target States <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#bbb">(optional when cities are set)</span></div>
          <div class="spills">${statePills}</div>
        </div>
        <div class="ssec">
          <div class="slbl">Monthly Quota</div>
          <div class="quota-row">
            <input type="number" class="quota-input" name="monthly_quota" value="${client.monthly_quota}" min="1" max="100000">
          </div>
        </div>
        <div class="ssec">
          <div class="slbl">Daily Send Cap</div>
          <div class="quota-row">
            <input type="number" class="quota-input" name="daily_send_limit" value="${client.daily_send_limit ?? 100}" min="1" max="10000">
            <button type="submit" class="btn-save">Save Settings</button>
          </div>
        </div>
      </form>
    </div>
  </div>

  <!-- Campaign Schedule -->
  <div class="card">
    <div class="card-hd"><span class="card-title">Campaign Schedule</span></div>
    <div class="card-bd">
      <form method="POST" action="/admin/clients/${esc(client.id)}/schedule">
        <div class="ssec">
          <label class="sched-active-row">
            <input type="checkbox" name="schedule_active" ${client.schedule_active ? 'checked' : ''}>
            Auto-run enabled
          </label>
        </div>
        <div class="sched-grid ssec">
          <div>
            <div class="slbl">Start Date</div>
            <input type="date" class="quota-input" name="schedule_start_date" value="${client.schedule_start_date || ''}" style="width:100%">
          </div>
          <div>
            <div class="slbl">Number of Days</div>
            <input type="number" class="quota-input" name="schedule_days" value="${client.schedule_days ?? 1}" min="1" max="90" style="width:100%">
          </div>
        </div>
        <div class="sched-grid ssec">
          <div>
            <div class="slbl">Run Hour</div>
            <select class="sched-sel" name="schedule_run_hour">${hourOptions}</select>
          </div>
          <div>
            <div class="slbl">Timezone</div>
            <select class="sched-sel" name="schedule_timezone">${tzOptions}</select>
          </div>
        </div>
        <button type="submit" class="btn-save">Save Schedule</button>
      </form>
    </div>
  </div>

  <!-- Live Activity -->
  <div class="card" style="margin-bottom:0">
    <div class="card-hd">
      <span class="card-title">Live Activity</span>
      <span class="live-dot" id="live-dot">● Live</span>
    </div>
    <div class="evlog" id="evlog"><div class="evempty">Loading…</div></div>
  </div>

  <div style="border-top:1px solid #e8e5e0;margin-top:48px"></div>
  ${FOOTER_HTML}
</div>

<script>
  const CID  = '${client.id}';
  const BASE = '/admin/clients/' + CID;

  // ── SSE ────────────────────────────────────────────────────────────────────
  (function connect() {
    const src = new EventSource(BASE + '/feed');
    src.onmessage = e => {
      const d = JSON.parse(e.data);
      setJob(d.job);
      setStats(d.counts);
      setLog(d.events);
      const ld = document.getElementById('live-dot');
      ld.textContent = '● Live'; ld.style.color = '#16a34a';
    };
    src.onerror = () => {
      const ld = document.getElementById('live-dot');
      ld.textContent = '○ Reconnecting'; ld.style.color = '#ca8a04';
    };
  })();

  // ── Job status ─────────────────────────────────────────────────────────────
  const JOB_CFG = {
    running:{ text:'⟳ Running', color:'#16a34a' },
    paused: { text:'⏸ Paused',  color:'#ca8a04' },
    done:   { text:'✓ Complete',color:'#16a34a' },
    error:  { text:'✕ Error',   color:'#dc2626' },
    idle:   { text:'● Idle',    color:'#aaa' },
  };
  function setJob(job) {
    const cfg = JOB_CFG[job.status] || JOB_CFG.idle;
    const ind = document.getElementById('job-ind');
    ind.textContent = cfg.text; ind.style.color = cfg.color;
    document.getElementById('job-step').textContent = job.step || '';

    const running = job.status === 'running';
    const paused  = job.status === 'paused';
    document.getElementById('btn-start').disabled         = running;
    document.getElementById('btn-pause').style.display   = running ? '' : 'none';
    document.getElementById('btn-resume').style.display  = paused  ? '' : 'none';
    document.getElementById('btn-stop').disabled          = !running && !paused;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  function setStats(c) {
    ['total','researched','sent','replied','converted'].forEach(k => {
      const el = document.getElementById('s-' + k);
      if (el) el.textContent = (c[k] || 0).toLocaleString();
    });
  }

  // ── Event log ──────────────────────────────────────────────────────────────
  const EV = {
    'prospect.batch_discovered':'🔍 Prospects discovered',
    'brain.started':            '✍ Brain started',
    'email.drafted':            '📧 Email drafted',
    'email.rewrite':            '🔄 Email rewrite requested',
    'email.sent':               '📤 Email sent',
    'email.failed':             '⚠ Email send failed',
    'connector.started':        '📤 Sending emails to Instantly',
    'connector.complete':       '✅ Emails delivered',
    'campaign.started':         '🚀 Campaign started',
    'campaign.paused':          '⏸ Campaign paused',
    'campaign.resumed':         '▶ Campaign resumed',
    'campaign.stopped':         '■ Campaign stopped',
    'campaign.pipeline_complete':'🎉 Pipeline complete',
    'reply.received':           '💬 Reply received',
    'payment.received':         '💰 Payment received',
    'error':                    '⚠ Error',
  };
  function setLog(events) {
    const log = document.getElementById('evlog');
    if (!events?.length) {
      log.innerHTML = '<div class="evempty">No activity yet. Start a campaign to begin.</div>';
      return;
    }
    log.innerHTML = events.map(ev => {
      const label  = EV[ev.type] || ev.type;
      const p      = ev.payload || {};
      const detail = p.niche       ? ' · ' + p.niche + (p.state  ? ' / ' + p.state  : '')
                   : p.message     ? ' · ' + p.message
                   : p.pushed      ? ' · ' + p.pushed + ' emails pushed'
                   : p.total_saved ? ' · ' + p.total_saved + ' saved'
                   : '';
      const t = new Date(ev.created_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      return '<div class="evrow"><span class="evlbl">' + label + detail + '</span><span class="evtime">' + t + '</span></div>';
    }).join('');
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function act(action) {
    try {
      const res = await fetch(BASE + '/' + action, { method: 'POST' });
      if (!res.ok) alert('Error: ' + await res.text());
    } catch (e) { alert('Request failed: ' + e.message); }
  }

  // ── City targeting ─────────────────────────────────────────────────────────
  var detCities = ${JSON.stringify(client.target_cities || [])};

  function renderDetCityChips() {
    var chips  = document.getElementById('det-city-chips');
    var hidden = document.getElementById('det-city-hidden');
    chips.innerHTML = detCities.map(function(c, i) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;background:#1a1a1a;color:#faf9f6;padding:5px 12px;border-radius:100px;font-family:Outfit,sans-serif;font-size:13px">' +
        c.zip + ' · ' + c.miles + ' mi' +
        '<button type="button" onclick="removeDetCity(' + i + ')" style="background:none;border:none;color:#faf9f6;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 4px">×</button></span>';
    }).join('');
    hidden.innerHTML = detCities.map(function(c) {
      return '<input type="hidden" name="target_city" value=\'' + JSON.stringify(c) + '\'>';
    }).join('');
  }

  window.removeDetCity = function(i) { detCities.splice(i, 1); renderDetCityChips(); };

  window.addDetCity = function() {
    var zip   = document.getElementById('det-city-zip').value.trim();
    var miles = parseInt(document.getElementById('det-city-miles').value, 10);
    if (!/^\d{5}$/.test(zip)) { alert('Please enter a valid 5-digit ZIP code.'); return; }
    if (detCities.find(function(c) { return c.zip === zip; })) { alert('That ZIP is already added.'); return; }
    detCities.push({ zip: zip, miles: miles });
    renderDetCityChips();
    document.getElementById('det-city-zip').value = '';
  };

  renderDetCityChips();
</script>
</body>
</html>`;
}

// ─── Add Client page ──────────────────────────────────────────────────────────

function addClientPage(errorMsg = '') {
  const nichePills = NICHES.map(n => {
    const id = 'n-' + n.replace(/\s+/g, '').toLowerCase();
    return `<input type="checkbox" id="${id}" name="niche" value="${esc(n)}"><label for="${id}">${esc(n)}</label>`;
  }).join('');

  const statePills = US_STATES.map(s => {
    const id = 'st-' + s.toLowerCase();
    return `<input type="checkbox" id="${id}" name="state" value="${s}"><label for="${id}">${s}</label>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Add Client — Suparade</title>
  ${FONTS}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    ::selection{background:#1a1a1a;color:#faf9f6}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column}
    nav{position:sticky;top:0;z-index:100;height:64px;display:flex;align-items:center;border-bottom:1px solid #e8e5e0;background:rgba(250,249,246,.95);backdrop-filter:blur(14px)}
    .nav-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
    .nav-tag{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;background:#efece6;color:#888;padding:5px 14px;border-radius:100px}
    .nav-logout{font-family:'Outfit',sans-serif;font-size:13px;color:#888;text-decoration:none;transition:color .15s}
    .nav-logout:hover{color:#1a1a1a}
    .wrap{flex:1;max-width:700px;margin:0 auto;width:100%;padding:48px clamp(20px,4vw,48px) 80px}
    .back-link{font-family:'Outfit',sans-serif;font-size:14px;margin-bottom:28px}
    .back-link a{color:#888;text-decoration:none;transition:color .15s}
    .back-link a:hover{color:#1a1a1a}
    h1{font-size:clamp(32px,4vw,44px);font-weight:400;line-height:1.1;letter-spacing:-1px;margin-bottom:8px}
    h1 em{font-style:italic}
    .pg-sub{font-family:'Outfit',sans-serif;font-size:16px;color:#999;margin-bottom:40px}
    .error{font-family:'Outfit',sans-serif;background:#fff0f0;border:1px solid #e00;border-radius:10px;padding:12px 16px;color:#c00;font-size:14px;margin-bottom:24px}
    .form-section{margin-bottom:28px}
    .section-label{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:10px}
    .field-label{font-family:'Outfit',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:8px;display:block}
    .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    @media(max-width:500px){.form-row{grid-template-columns:1fr}}
    input[type=text],input[type=email],input[type=number]{width:100%;padding:14px 18px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:16px;color:#1a1a1a;background:#fff;outline:none;transition:border-color .2s}
    input[type=text]:focus,input[type=email]:focus,input[type=number]:focus{border-color:#1a1a1a}
    input::placeholder{color:#bbb}
    .pills{display:flex;flex-wrap:wrap;gap:8px}
    .pills input[type=checkbox]{display:none}
    .pills label{font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;padding:8px 16px;border:1.5px solid #e8e5e0;border-radius:100px;cursor:pointer;color:#666;background:#fff;transition:all .15s;user-select:none}
    .pills label:hover{border-color:#1a1a1a;color:#1a1a1a}
    .pills input:checked + label{background:#1a1a1a;color:#faf9f6;border-color:#1a1a1a}
    .states-pills{max-height:156px;overflow-y:auto;padding:10px 12px;border:1.5px solid #e8e5e0;border-radius:12px;background:#fff;display:flex;flex-wrap:wrap;gap:6px}
    .states-pills label{font-size:13px;padding:5px 12px}
    .tier-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
    .tier-card{cursor:pointer}
    .tier-card input[type=radio]{display:none}
    .tier-card-inner{border:1.5px solid #e8e5e0;border-radius:12px;padding:18px 20px;background:#fff;transition:all .2s}
    .tier-card input:checked + .tier-card-inner{border-color:#1a1a1a;background:#1a1a1a}
    .tier-card input:checked + .tier-card-inner .tier-name{color:#faf9f6}
    .tier-card input:checked + .tier-card-inner .tier-detail{color:#888}
    .tier-name{font-family:'Outfit',sans-serif;font-size:15px;font-weight:700;color:#1a1a1a;margin-bottom:4px;text-transform:capitalize}
    .tier-detail{font-family:'Outfit',sans-serif;font-size:13px;color:#999}
    .form-actions{display:flex;gap:12px;justify-content:flex-end;margin-top:40px;padding-top:24px;border-top:1px solid #e8e5e0}
    .btn-cancel{font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;padding:13px 28px;border-radius:100px;border:1.5px solid #e8e5e0;background:#fff;color:#666;cursor:pointer;text-decoration:none;transition:all .2s;line-height:1;display:inline-block}
    .btn-cancel:hover{border-color:#1a1a1a;color:#1a1a1a}
    .btn-submit{font-family:'Outfit',sans-serif;font-size:15px;font-weight:600;padding:13px 28px;border-radius:100px;border:none;background:#1a1a1a;color:#faf9f6;cursor:pointer;transition:all .25s}
    .btn-submit:hover{background:#333;transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.12)}
    footer{border-top:1px solid #e8e5e0}
    .footer-inner{max-width:1200px;margin:0 auto;width:100%;padding:36px clamp(20px,4vw,48px) 48px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:14px;color:#888;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:14px;color:#888}
    ${SECNAV_CSS}
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
      <a href="/admin" class="navtab navtab-on">Outbound</a>
      <a href="/admin/inbound" class="navtab navtab-off">Inbound</a>
      <a href="/admin/appointments" class="navtab navtab-off">Appointments</a>
    </div>
    <div style="display:flex;align-items:center;gap:20px">
      <span class="nav-meta">${new Date().toLocaleString('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span>
      <a href="/admin/logout" class="nav-logout">Sign out</a>
    </div>
  </div>
</nav>
<div class="wrap">
  <div class="back-link"><a href="/admin">← Dashboard</a></div>
  <h1>Add <em>client.</em></h1>
  <p class="pg-sub">Creates an internal account without Stripe billing.</p>
  ${errorMsg ? `<div class="error">${esc(errorMsg)}</div>` : ''}
  <form method="POST" action="/admin/add-client">

    <div class="form-section">
      <div class="form-row">
        <div>
          <label class="field-label" for="ac-name">Full Name</label>
          <input type="text" id="ac-name" name="name" required placeholder="Jane Smith">
        </div>
        <div>
          <label class="field-label" for="ac-email">Email</label>
          <input type="email" id="ac-email" name="email" required placeholder="jane@example.com">
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="section-label">Niches</div>
      <div class="pills">${nichePills}</div>
    </div>

    <div class="form-section">
      <div class="section-label">Target Cities <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#bbb">(optional — overrides states)</span></div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        <input type="text" id="ac-city-zip" placeholder="ZIP code" maxlength="5" style="max-width:120px">
        <select id="ac-city-miles" style="padding:14px 12px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:15px;color:#1a1a1a;background:#fff;outline:none;-webkit-appearance:none;appearance:none">
          <option value="5">5 mi</option>
          <option value="10">10 mi</option>
          <option value="25" selected>25 mi</option>
          <option value="50">50 mi</option>
        </select>
        <button type="button" onclick="addAcCity()" class="btn-cancel" style="white-space:nowrap">+ Add</button>
      </div>
      <div id="ac-city-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px"></div>
      <div id="ac-city-hidden"></div>
    </div>

    <div class="form-section">
      <div class="section-label">Target States <span style="text-transform:none;font-weight:400;letter-spacing:0;color:#bbb">(optional when cities are set)</span></div>
      <div class="states-pills">${statePills}</div>
    </div>

    <div class="form-section">
      <div class="section-label">Plan</div>
      <div class="tier-grid">
        <label class="tier-card">
          <input type="radio" name="tier" value="starter" checked onchange="syncQuota(this)">
          <div class="tier-card-inner">
            <div class="tier-name">Starter</div>
            <div class="tier-detail">500 prospects/mo</div>
          </div>
        </label>
        <label class="tier-card">
          <input type="radio" name="tier" value="growth" onchange="syncQuota(this)">
          <div class="tier-card-inner">
            <div class="tier-name">Growth</div>
            <div class="tier-detail">1,000 prospects/mo</div>
          </div>
        </label>
        <label class="tier-card">
          <input type="radio" name="tier" value="scale" onchange="syncQuota(this)">
          <div class="tier-card-inner">
            <div class="tier-name">Scale</div>
            <div class="tier-detail">2,000 prospects/mo</div>
          </div>
        </label>
      </div>
      <label class="field-label" for="ac-quota">Monthly Quota</label>
      <input type="number" id="ac-quota" name="monthly_quota" value="500" min="1" max="100000" style="max-width:200px">
    </div>

    <div class="form-actions">
      <a href="/admin" class="btn-cancel">Cancel</a>
      <button type="submit" class="btn-submit">Create Client</button>
    </div>
  </form>
</div>
${FOOTER_HTML}
<script>
  const TIER_QUOTAS = {starter:500,growth:1000,scale:2000};
  function syncQuota(radio) {
    document.getElementById('ac-quota').value = TIER_QUOTAS[radio.value] || 500;
  }

  var acCities = [];

  function renderAcCityChips() {
    var chips  = document.getElementById('ac-city-chips');
    var hidden = document.getElementById('ac-city-hidden');
    chips.innerHTML = acCities.map(function(c, i) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;background:#1a1a1a;color:#faf9f6;padding:5px 12px;border-radius:100px;font-family:Outfit,sans-serif;font-size:13px">' +
        c.zip + ' · ' + c.miles + ' mi' +
        '<button type="button" onclick="removeAcCity(' + i + ')" style="background:none;border:none;color:#faf9f6;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 4px">×</button></span>';
    }).join('');
    hidden.innerHTML = acCities.map(function(c) {
      return '<input type="hidden" name="target_city" value=\'' + JSON.stringify(c) + '\'>';
    }).join('');
  }

  window.removeAcCity = function(i) { acCities.splice(i, 1); renderAcCityChips(); };

  window.addAcCity = function() {
    var zip   = document.getElementById('ac-city-zip').value.trim();
    var miles = parseInt(document.getElementById('ac-city-miles').value, 10);
    if (!/^\d{5}$/.test(zip)) { alert('Please enter a valid 5-digit ZIP code.'); return; }
    if (acCities.find(function(c) { return c.zip === zip; })) { alert('That ZIP is already added.'); return; }
    acCities.push({ zip: zip, miles: miles });
    renderAcCityChips();
    document.getElementById('ac-city-zip').value = '';
  };
</script>
</body>
</html>`;
}

// ─── Agent Controls page ──────────────────────────────────────────────────────

function agentsPage(agents = []) {
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent Controls — Suparade</title>
  ${FONTS}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    ::selection{background:#1a1a1a;color:#faf9f6}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh}
    nav{position:sticky;top:0;z-index:100;height:64px;display:flex;align-items:center;background:rgba(250,249,246,.95);backdrop-filter:blur(14px);border-bottom:1px solid #e8e5e0}
    .nav-inner{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
    .nav-tag{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;background:#efece6;color:#888;padding:5px 14px;border-radius:100px}
    .nav-meta{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb}
    .nav-logout{font-family:'Outfit',sans-serif;font-size:13px;color:#888;text-decoration:none;transition:color .15s}
    .nav-logout:hover{color:#1a1a1a}
    .container{max-width:1200px;margin:0 auto;padding:0 clamp(20px,4vw,48px) 80px}
    footer{}
    .footer-inner{display:flex;justify-content:space-between;align-items:center;padding:36px 0 48px;flex-wrap:wrap;gap:16px}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:14px;color:#888;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:14px;color:#888}
    ${SECNAV_CSS}
    /* Agent card styles (mirrors inbound) */
    .card{background:#fff;border:1px solid #e8e5e0;border-radius:14px;overflow:hidden;margin-top:32px;margin-bottom:24px}
    .ch{padding:20px 28px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;justify-content:space-between}
    .ct{font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb}
    .btn{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;padding:9px 20px;border-radius:100px;cursor:pointer;text-decoration:none;border:none;transition:all .2s;display:inline-block;white-space:nowrap}
    .btn-sm{padding:7px 16px;font-size:13px}
    .btn-green{background:#16a34a;color:#fff}.btn-green:hover{background:#15803d}
    .btn-red{background:#dc2626;color:#fff}.btn-red:hover{background:#b91c1c}
    .btn-dark{background:#1a1a1a;color:#faf9f6}.btn-dark:hover{background:#333}
    .btn-ghost{background:transparent;color:#888;border:1.5px solid #e8e5e0}.btn-ghost:hover{color:#1a1a1a;border-color:#1a1a1a}
    .badge{font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;padding:4px 12px;border-radius:100px;white-space:nowrap}
    .bg{background:#16a34a14;color:#16a34a;border:1px solid #16a34a35}
    .br{background:#dc262614;color:#dc2626;border:1px solid #dc262635}
    .bb{background:#2563eb14;color:#2563eb;border:1px solid #2563eb35}
    .bk{background:#f0ede8;color:#aaa;border:1px solid #e8e5e0}
    .form-i{font-family:'Outfit',sans-serif;font-size:14px;padding:8px 12px;border:1.5px solid #e8e5e0;border-radius:8px;background:#fff;color:#1a1a1a;outline:none}
    .form-i:focus{border-color:#1a1a1a}
    .ph{padding:40px 0 32px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px}
    .ph-left h1{font-size:clamp(28px,4vw,40px);font-weight:400;letter-spacing:-1px;line-height:1.1}
    .ph-left h1 em{font-style:italic}
    .ph-sub{font-family:'Outfit',sans-serif;font-size:15px;color:#999;margin-top:8px}
    .empty{font-family:'Outfit',sans-serif;font-size:14px;color:#bbb;text-align:center;padding:40px}
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
      <a href="/admin" class="navtab navtab-on">Outbound</a>
      <a href="/admin/inbound" class="navtab navtab-off">Inbound</a>
      <a href="/admin/appointments" class="navtab navtab-off">Appointments</a>
    </div>
    <div style="display:flex;align-items:center;gap:24px">
      <span class="nav-meta">${now} ET</span>
      <a href="/admin/logout" class="nav-logout">Sign out</a>
    </div>
  </div>
</nav>
<div class="agbar">
  <div class="agbar-inner">
    <a href="/admin" class="agbar-tab">Overview</a>
    <a href="/admin/agents" class="agbar-tab on">Agent Controls</a>
  </div>
</div>
<div class="container">
  <div class="ph">
    <div class="ph-left">
      <h1><em>Agent Controls.</em></h1>
      <div class="ph-sub">Manage outbound agent schedules and trigger manual runs.</div>
    </div>
  </div>
  ${buildAgentControlsHtml(agents)}
  <div class="footer-inner">
    <div class="footer-logo">Suparade</div>
    <div class="footer-links">
      <a href="/terms" class="footer-link">Terms</a>
      <a href="/policy" class="footer-link">Policy</a>
      <span class="footer-copy">© 2026 Suparade. All rights reserved.</span>
    </div>
  </div>
</div>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

adminRouter.get('/login', (req, res) => {
  // Already logged in → go straight to dashboard
  const cookie   = getCookie(req, 'admin_sid');
  const expected = sessionToken();
  const cookieBuf   = Buffer.from(cookie || '');
  const expectedBuf = Buffer.from(expected);
  const valid =
    cookieBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(cookieBuf, expectedBuf);

  if (valid) return res.redirect('/admin');
  res.send(loginPage());
});

adminRouter.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const submitted = req.body.password || '';
  const expected  = process.env.ADMIN_PASSWORD || 'NEVER_ALLOW_BLANK_PASSWORD_123';

  const submittedBuf = Buffer.from(submitted);
  const expectedBuf  = Buffer.from(expected);
  const valid =
    submittedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(submittedBuf, expectedBuf);

  if (!valid) return res.send(loginPage('Incorrect password. Try again.'));

  // Set signed session cookie — 7-day expiry
  const token = sessionToken();
  res.setHeader('Set-Cookie',
    `admin_sid=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=604800; Path=/`
  );
  res.redirect('/admin');
});

adminRouter.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'admin_sid=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
  res.redirect('/admin/login');
});

// ─── Forgot / reset password ───────────────────────────────────────────────────

function resetToken(ts) {
  return crypto
    .createHmac('sha256', process.env.ADMIN_PASSWORD || 'NEVER_ALLOW_BLANK_PASSWORD_123')
    .update(`reset-${ts}`)
    .digest('hex');
}

adminRouter.post('/forgot-password', express.urlencoded({ extended: false }), async (_req, res) => {
  const ts    = Date.now();
  const token = resetToken(ts);
  const link  = `https://api.suparade.com/admin/reset?token=${token}&ts=${ts}`;

  console.log('[Admin] Forgot-password triggered, sending recovery email...');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:    'Suparade <onboarding@resend.dev>',
        to:      'hello@suparade.com',
        subject: 'Admin recovery link',
        html: `<p style="font-family:sans-serif;font-size:15px;color:#1a1a1a">
          Click the link below to sign in. It expires in <strong>15 minutes</strong>.
        </p>
        <p style="margin-top:20px">
          <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;font-family:sans-serif;font-size:14px;font-weight:600;padding:12px 24px;border-radius:100px;text-decoration:none">
            Sign in to Admin →
          </a>
        </p>
        <p style="font-family:sans-serif;font-size:12px;color:#999;margin-top:20px">
          If you didn't request this, ignore this email.
        </p>`,
      }),
    });
    const body = await r.json();
    console.log('[Admin] Resend response:', r.status, JSON.stringify(body));
    if (!r.ok) {
      return res.send(loginPage(`Email send failed: ${body.message || r.status}`));
    }
    res.send(loginPage('', 'Recovery link sent to hello@suparade.com — check your inbox. Expires in 15 minutes.'));
  } catch (err) {
    console.error('[Admin] Recovery email failed:', err.message);
    res.send(loginPage('Failed to send recovery email. Try again.'));
  }
});

adminRouter.get('/reset', (req, res) => {
  const { token, ts } = req.query;
  if (!token || !ts) return res.redirect('/admin/login');

  const age = Date.now() - parseInt(ts, 10);
  if (age > 15 * 60 * 1000) return res.send(loginPage('Recovery link has expired. Please generate a new one.'));

  const expected    = resetToken(ts);
  const tokenBuf    = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  const valid =
    tokenBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf);

  if (!valid) return res.send(loginPage('Invalid recovery link.'));

  const session = sessionToken();
  res.setHeader('Set-Cookie',
    `admin_sid=${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Max-Age=604800; Path=/`
  );
  res.redirect('/admin');
});

adminRouter.get('/', requireAuth, async (_req, res) => {
  try {
    const [dashData, { data: agents }] = await Promise.all([
      loadDashboardData(),
      supabase.from('agent_states').select('*').eq('system', 'outbound').order('id'),
    ]);
    res.send(dashboardPage(dashData.clients, dashData.counts, agents || []));
  } catch (err) {
    console.error('[Admin] Dashboard error:', err.message);
    res.status(500).send('Error loading dashboard.');
  }
});

adminRouter.get('/agents', requireAuth, async (_req, res) => {
  const { data: agents } = await supabase.from('agent_states').select('*').eq('system', 'outbound').order('id');
  res.send(agentsPage(agents || []));
});

adminRouter.get('/add-client', requireAuth, (_req, res) => {
  res.send(addClientPage());
});

adminRouter.post('/add-client', requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { name, email, tier, monthly_quota } = req.body;

    if (!name?.trim() || !email?.trim()) {
      return res.send(addClientPage('Name and email are required.'));
    }

    const niches = req.body.niche
      ? (Array.isArray(req.body.niche) ? req.body.niche : [req.body.niche])
      : [];
    const states = req.body.state
      ? (Array.isArray(req.body.state) ? req.body.state : [req.body.state])
      : [];
    const rawCities = req.body.target_city
      ? (Array.isArray(req.body.target_city) ? req.body.target_city : [req.body.target_city])
      : [];
    const cities = rawCities
      .map(v => { try { return JSON.parse(v); } catch { return null; } })
      .filter(c => c && c.zip && typeof c.miles === 'number');

    const tierQuotas = { starter: 500, growth: 1000, scale: 2000 };
    const validTier  = ['starter','growth','scale'].includes(tier) ? tier : 'starter';
    const quota      = parseInt(monthly_quota, 10) || tierQuotas[validTier];

    const { error } = await supabase.from('clients').insert({
      name:           name.trim(),
      email:          email.trim().toLowerCase(),
      tier:           validTier,
      monthly_quota:  quota,
      target_niche:   niches,
      target_states:  states,
      target_cities:  cities.length ? cities : null,
      billing_status: 'active',
      is_internal:    true,
      style_profile:  'example',
    });

    if (error) {
      console.error('[Admin] Add client error:', error.message);
      const msg = error.code === '23505' ? 'A client with that email already exists.' : error.message;
      return res.send(addClientPage(msg));
    }

    res.redirect('/admin');
  } catch (err) {
    console.error('[Admin] Add client error:', err.message);
    res.send(addClientPage('Something went wrong. Please try again.'));
  }
});

// ─── Client detail routes ─────────────────────────────────────────────────────

adminRouter.get('/clients/:id', requireAuth, async (req, res) => {
  const { data: client, error } = await supabase
    .from('clients').select('*').eq('id', req.params.id).single();
  if (error || !client) return res.status(404).send('Client not found.');
  res.send(clientDetailPage(client));
});

adminRouter.post('/clients/:id/start', requireAuth, async (req, res) => {
  try {
    startPipeline(req.params.id);
    res.sendStatus(200);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

adminRouter.post('/clients/:id/pause', requireAuth, async (req, res) => {
  try {
    await pauseClient(req.params.id);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

adminRouter.post('/clients/:id/resume', requireAuth, async (req, res) => {
  try {
    await resumeClient(req.params.id);
    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

adminRouter.post('/clients/:id/stop', requireAuth, (req, res) => {
  stopJob(req.params.id);
  res.sendStatus(200);
});

adminRouter.post('/clients/:id/send', requireAuth, async (req, res) => {
  try {
    const result = await sendEmails(req.params.id);
    res.json({ pushed: result?.pushed ?? 0 });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

adminRouter.post('/clients/:id/settings', requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
  const { id } = req.params;
  const { monthly_quota, daily_send_limit } = req.body;

  const niches = req.body.niche
    ? (Array.isArray(req.body.niche) ? req.body.niche : [req.body.niche])
    : [];
  const states = req.body.state
    ? (Array.isArray(req.body.state) ? req.body.state : [req.body.state])
    : [];
  const rawCities = req.body.target_city
    ? (Array.isArray(req.body.target_city) ? req.body.target_city : [req.body.target_city])
    : [];
  const cities = rawCities
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(c => c && c.zip && typeof c.miles === 'number');

  const { error } = await supabase.from('clients').update({
    target_niche:     niches,
    target_states:    states,
    target_cities:    cities.length ? cities : null,
    monthly_quota:    parseInt(monthly_quota, 10) || 500,
    daily_send_limit: parseInt(daily_send_limit, 10) || 100,
  }).eq('id', id);

  if (error) return res.status(500).send(error.message);
  res.redirect(`/admin/clients/${id}`);
});

adminRouter.post('/clients/:id/schedule', requireAuth, express.urlencoded({ extended: false }), async (req, res) => {
  const { id } = req.params;
  const { schedule_start_date, schedule_days, schedule_run_hour, schedule_timezone, schedule_active } = req.body;

  const { error } = await supabase.from('clients').update({
    schedule_start_date: schedule_start_date || null,
    schedule_days:       parseInt(schedule_days, 10) || 1,
    schedule_run_hour:   parseInt(schedule_run_hour, 10) || 8,
    schedule_timezone:   schedule_timezone || 'America/New_York',
    schedule_active:     schedule_active === 'on',
  }).eq('id', id);

  if (error) return res.status(500).send(error.message);
  res.redirect(`/admin/clients/${id}`);
});

// SSE: streams job state + recent events + prospect counts every 3 seconds
adminRouter.get('/clients/:id/feed', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { id } = req.params;

  async function push() {
    try {
      const job = getJob(id);

      const [{ data: events }, { data: prospects }] = await Promise.all([
        supabase.from('events').select('id, created_at, type, payload')
          .eq('client_id', id).order('created_at', { ascending: false }).limit(40),
        supabase.from('prospects').select('status').eq('client_id', id),
      ]);

      const counts = { total: 0, researched: 0, sent: 0, replied: 0, converted: 0 };
      for (const p of prospects || []) {
        counts.total++;
        if (p.status === 'researched')                            counts.researched++;
        if (['sent','replied','converted'].includes(p.status))    counts.sent++;
        if (['replied','converted'].includes(p.status))           counts.replied++;
        if (p.status === 'converted')                             counts.converted++;
      }

      const payload = JSON.stringify({
        job:    { status: job.status, step: job.step, startedAt: job.startedAt },
        counts,
        events: events || [],
      });
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.error('[Admin SSE] Error:', err.message);
    }
  }

  await push();
  const timer = setInterval(push, 3000);
  req.on('close', () => clearInterval(timer));
});

// ─── Agent control routes + scheduler ────────────────────────────────────────

registerAgentRoutes(adminRouter, requireAuth);
registerAppointmentRoutes(adminRouter, requireAuth);
startOutboundScheduler().catch(err => console.error('[agents:outbound] Scheduler init error:', err.message));
