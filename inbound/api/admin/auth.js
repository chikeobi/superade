/**
 * api/admin/auth.js — Auth helpers + shared HTML shell for inbound admin
 *
 * Uses the same ADMIN_PASSWORD + cookie name as engine/api/admin.js so
 * the session is shared across both admin servers on the same domain.
 */

import crypto from 'crypto';

export function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function sessionToken() {
  return crypto
    .createHmac('sha256', process.env.ADMIN_PASSWORD || 'NEVER_ALLOW_BLANK_PASSWORD_123')
    .update('suparade-admin-session-v1')
    .digest('hex');
}

export function requireAuth(req, res, next) {
  const cookie = getCookie(req, 'admin_sid');
  const expected = sessionToken();
  const a = Buffer.from(cookie || ''), b = Buffer.from(expected);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return res.redirect('/admin/login');
  next();
}

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Shared HTML shell ────────────────────────────────────────────────────────

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">`;

const CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}::selection{background:#1a1a1a;color:#faf9f6}
body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh}
nav{position:sticky;top:0;z-index:100;height:64px;display:flex;align-items:center;background:rgba(250,249,246,.95);backdrop-filter:blur(14px);border-bottom:1px solid #e8e5e0}
.ni{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;align-items:center;justify-content:space-between}
.logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
.tag{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;background:#efece6;color:#888;padding:5px 14px;border-radius:100px}
.navtab{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;padding:6px 14px;border-radius:100px;text-decoration:none;transition:all .15s;white-space:nowrap}.navtab-on{background:#1a1a1a;color:#faf9f6}.navtab-off{color:#aaa}.navtab-off:hover{color:#1a1a1a;background:#f0ede8}
.sn{position:sticky;top:64px;z-index:99;border-bottom:1px solid #e8e5e0;overflow-x:auto;background:rgba(250,249,246,.97);backdrop-filter:blur(10px)}
.sni{max-width:1200px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px);display:flex;gap:0}
.snl{font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;color:#999;text-decoration:none;padding:12px 18px;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap;display:block}
.snl:hover,.snl.on{color:#1a1a1a}.snl.on{border-bottom-color:#1a1a1a;font-weight:600}
.wrap{max-width:1200px;margin:0 auto;padding:0 clamp(20px,4vw,48px) 80px}
.ph{padding:36px 0 28px;margin-bottom:28px;border-bottom:1px solid #e8e5e0;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ph-left h1{font-size:clamp(28px,3.5vw,38px);font-weight:400;letter-spacing:-1px;line-height:1.1}
.ph-left h1 em{font-style:italic}
.ph-sub{font-family:'Outfit',sans-serif;font-size:15px;color:#999;margin-top:6px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.stat{background:#fff;border:1px solid #e8e5e0;border-radius:12px;padding:18px 20px}
.sl{font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#bbb;margin-bottom:6px}
.sv{font-family:'Outfit',sans-serif;font-size:30px;font-weight:400;letter-spacing:-.5px;color:#1a1a1a;line-height:1}
.card{background:#fff;border:1px solid #e8e5e0;border-radius:14px;overflow:hidden;margin-bottom:20px}
.ch{padding:18px 22px;border-bottom:1px solid #f0ede8;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ct{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#bbb}
.cb{padding:22px}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:580px}
th{font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#bbb;padding:11px 14px;text-align:left;border-bottom:1px solid #f0ede8;white-space:nowrap}
th.r{text-align:right}td{padding:13px 14px;border-bottom:1px solid #f9f8f6;font-family:'Outfit',sans-serif;font-size:14px;color:#555;vertical-align:middle}
td.r{text-align:right}tr:last-child td{border-bottom:none}tbody tr:hover td{background:#faf9f6}
.btn{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;padding:9px 18px;border-radius:100px;border:none;cursor:pointer;transition:all .2s;line-height:1;text-decoration:none;display:inline-block;white-space:nowrap}
.btn-sm{font-size:12px;padding:5px 13px}.btn-dark{background:#1a1a1a;color:#faf9f6}.btn-dark:hover{background:#333}
.btn-ghost{background:transparent;color:#666;border:1.5px solid #e8e5e0}.btn-ghost:hover{border-color:#1a1a1a;color:#1a1a1a}
.btn-green{background:#16a34a14;color:#16a34a;border:1px solid #16a34a30}.btn-green:hover{background:#16a34a22}
.btn-red{background:#dc262614;color:#dc2626;border:1px solid #dc262630}.btn-red:hover{background:#dc262622}
.btn-amber{background:#ca8a0414;color:#ca8a04;border:1px solid #ca8a0430}.btn-amber:hover{background:#ca8a0422}
.badge{font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;padding:3px 10px;border-radius:100px;white-space:nowrap}
.bg{background:#16a34a14;color:#16a34a;border:1px solid #16a34a30}
.by{background:#ca8a0414;color:#ca8a04;border:1px solid #ca8a0430}
.br{background:#dc262614;color:#dc2626;border:1px solid #dc262630}
.bb{background:#2563eb14;color:#2563eb;border:1px solid #2563eb30}
.bk{background:#f0ede8;color:#888;border:1px solid #e0dcd5}
.form-g{margin-bottom:18px}.form-l{font-family:'Outfit',sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#888;display:block;margin-bottom:7px}
.form-i{width:100%;padding:11px 14px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:15px;color:#1a1a1a;background:#fff;outline:none;transition:border-color .2s}
.form-i:focus{border-color:#1a1a1a}select.form-i{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='7'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}
.fr{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:580px){.fr{grid-template-columns:1fr}}
.empty{font-family:'Outfit',sans-serif;color:#bbb;text-align:center;padding:48px;font-size:15px}
footer{border-top:1px solid #e8e5e0}
.fi{max-width:1200px;margin:0 auto;padding:24px clamp(20px,4vw,48px) 32px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}
.fl{font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;letter-spacing:-.5px}
.fc{font-family:'Outfit',sans-serif;font-size:14px;color:#888}`;

const SUB_NAV_LINKS = [
  ['/admin/inbound',              'Overview'],
  ['/admin/inbound/opportunities','Opportunities'],
  ['/admin/inbound/sites',        'Sites'],
  ['/admin/inbound/leads',        'Leads'],
  ['/admin/inbound/vendors',      'Vendors'],
  ['/admin/inbound/agents',       'Agent Controls'],
];

/** Returns a complete HTML page with shared nav, sub-nav, CSS, and footer. */
export function adminShell(title, bodyHtml, activePath = '', agentBarHtml = '') {
  const snLinks = SUB_NAV_LINKS.map(([href, label]) => {
    const cls = activePath === href ? 'snl on' : 'snl';
    return `<a href="${href}" class="${cls}">${label}</a>`;
  }).join('');

  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Suparade</title>
${FONTS}
<style>${CSS}</style>
</head>
<body>
<nav><div class="ni">
  <div style="display:flex;align-items:center;gap:10px">
    <a href="https://suparade.com" class="logo">Suparade</a>
    <span class="tag">Admin</span>
  </div>
  <div style="display:flex;align-items:center;gap:4px">
    <a href="/admin" class="navtab navtab-off">Outbound</a>
    <a href="/admin/inbound" class="navtab navtab-on">Inbound</a>
    <a href="/admin/appointments" class="navtab navtab-off">Appointments</a>
  </div>
  <div style="display:flex;align-items:center;gap:20px">
    <span style="font-family:'Outfit',sans-serif;font-size:13px;color:#bbb">${now} ET</span>
    <a href="/admin/logout" style="font-family:'Outfit',sans-serif;font-size:13px;color:#888;text-decoration:none">Sign out</a>
  </div>
</div></nav>
<div class="sn"><div class="sni">${snLinks}</div></div>
<div class="wrap">${bodyHtml}</div>
<footer><div class="fi"><div class="fl">Suparade</div><div class="fc">© 2026 Suparade</div></div></footer>
</body></html>`;
}

/** Score badge: color-coded by score range. */
export function scoreBadge(score) {
  if (score === null || score === undefined) return `<span class="badge bk">—</span>`;
  const cls = score >= 75 ? 'bg' : score >= 60 ? 'by' : 'br';
  return `<span class="badge ${cls}">${score}</span>`;
}

/** Status badge for opportunities/sites/vendors/leads. */
export function statusBadge(status) {
  const map = {
    discovered:'bk', approved:'bg', live:'bg', active:'bg',
    rejected:'br',  cancelled:'br', failed:'br',
    building:'bb',  paused:'by', prospect:'by', pending:'by',
    new:'bb', routed:'by', sold:'bg', draft:'bk', paid:'bg',
    controlled_build:'bb', semi_auto:'by', full_auto:'bg', discovery_only:'bk',
  };
  const cls = map[status] || 'bk';
  return `<span class="badge ${cls}">${esc(String(status).replace(/_/g,' '))}</span>`;
}

// ─── Auth routes (login redirect + logout) ────────────────────────────────────

export function registerAuthRoutes(router) {
  // Login is handled by the outbound admin on port 3000.
  // The session cookie is shared by domain so login there works here too.
  // If someone hits /admin/inbound without a session, requireAuth redirects /admin/login.

  router.get('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'admin_sid=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
    res.redirect('/admin/login');
  });
}
