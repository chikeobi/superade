/**
 * api/admin/overview.js — Overview, Opportunities, Sites, and Mode Control routes
 *
 * Routes registered:
 *   GET  /                       → inbound overview + mode control
 *   POST /mode                   → update mode + score threshold
 *   GET  /opportunities          → scored opportunities table
 *   POST /opportunities/:id/approve
 *   POST /opportunities/:id/reject
 *   GET  /sites                  → generated sites table
 */

import express from 'express';
import { supabase } from '../../lib/supabase.js';
import { requireAuth, esc, adminShell, scoreBadge, statusBadge } from './auth.js';
import { registerAgentRoutes, startInboundScheduler } from './agents.js';

const up = express.urlencoded({ extended: false });

export function registerOverviewRoutes(router) {
  router.get('/', requireAuth, overviewHandler);
  router.post('/mode', requireAuth, up, modeHandler);
  router.get('/opportunities', requireAuth, opportunitiesHandler);
  router.post('/opportunities/:id/approve', requireAuth, approveHandler);
  router.post('/opportunities/:id/reject', requireAuth, up, rejectHandler);
  router.get('/sites', requireAuth, sitesHandler);
  registerAgentRoutes(router);
  startInboundScheduler().catch(err => console.error('[agents:inbound] Scheduler init error:', err.message));
}

// ─── Overview ─────────────────────────────────────────────────────────────────

async function overviewHandler(_req, res) {
  const [
    { data: mode },
    { data: opps },
    { data: sites },
    { data: leads },
    { data: vendors },
  ] = await Promise.all([
    supabase.from('inbound_mode').select('*').eq('id', 1).single(),
    supabase.from('opportunities').select('id, score, status, niche, city, state').order('score', { ascending: false }),
    supabase.from('generated_sites').select('id, status'),
    supabase.from('inbound_leads').select('id, status, revenue, created_at'),
    supabase.from('vendors').select('id, billing_status'),
  ]);

  const scored    = (opps || []).filter(o => o.score !== null).length;
  const highScore = (opps || []).filter(o => o.score >= (mode?.score_threshold || 75)).length;
  const approved  = (opps || []).filter(o => o.status === 'approved').length;
  const liveSites = (sites || []).filter(s => s.status === 'live').length;

  const thisMonth = new Date(); thisMonth.setDate(1); thisMonth.setHours(0,0,0,0);
  const monthLeads   = (leads || []).filter(l => new Date(l.created_at) >= thisMonth);
  const monthRevenue = monthLeads.reduce((s, l) => s + (l.revenue || 0), 0);
  const activeVendors = (vendors || []).filter(v => v.billing_status === 'active').length;

  const top10 = (opps || [])
    .filter(o => o.score !== null).slice(0, 10)
    .map(o => `<tr>
      <td style="font-weight:500;color:#1a1a1a">${esc(o.niche)}</td>
      <td>${esc(o.city)}, ${esc(o.state)}</td>
      <td>${scoreBadge(o.score)}</td>
      <td>${statusBadge(o.status)}</td>
      <td style="text-align:right">
        ${o.status === 'discovered'
          ? `<form method="POST" action="/admin/inbound/opportunities/${o.id}/approve" style="display:inline">
               <button class="btn btn-sm btn-green">Approve</button></form>`
          : '—'}
      </td>
    </tr>`).join('');

  const MODES = ['discovery_only','controlled_build','semi_auto','full_auto'];
  const modeOptions = MODES.map(m =>
    `<option value="${m}"${mode?.mode === m ? ' selected' : ''}>${m.replace(/_/g,' ')}</option>`
  ).join('');

  const body = `
<div class="ph">
  <div class="ph-left"><h1>Inbound <em>overview.</em></h1>
    <div class="ph-sub">Lead generation sites, vendors, and scoring dashboard.</div></div>
  <a href="/admin/inbound/vendors/new" class="btn btn-dark">Add Vendor +</a>
</div>

<div class="stats">
  <div class="stat"><div class="sl">Scored</div><div class="sv">${scored}</div></div>
  <div class="stat"><div class="sl">Score ≥${mode?.score_threshold || 75}</div><div class="sv">${highScore}</div></div>
  <div class="stat"><div class="sl">Approved</div><div class="sv">${approved}</div></div>
  <div class="stat"><div class="sl">Live Sites</div><div class="sv">${liveSites}</div></div>
  <div class="stat"><div class="sl">Leads / mo</div><div class="sv">${monthLeads.length}</div></div>
  <div class="stat"><div class="sl">Revenue / mo</div><div class="sv">$${monthRevenue.toLocaleString()}</div></div>
  <div class="stat"><div class="sl">Active Vendors</div><div class="sv">${activeVendors}</div></div>
</div>

<div class="card">
  <div class="ch">
    <span class="ct">Mode Control</span>
    <span>${statusBadge(mode?.mode || 'discovery_only')}</span>
  </div>
  <div class="cb">
    <form method="POST" action="/admin/inbound/mode" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <div class="form-g" style="margin-bottom:0">
        <label class="form-l">Mode</label>
        <select name="mode" class="form-i" style="min-width:200px">${modeOptions}</select>
      </div>
      <div class="form-g" style="margin-bottom:0">
        <label class="form-l">Auto-build threshold</label>
        <input type="number" name="score_threshold" class="form-i" value="${mode?.score_threshold || 75}" min="0" max="100" style="width:100px">
      </div>
      <button type="submit" class="btn btn-dark">Save Mode</button>
    </form>
    <p style="font-family:'Outfit',sans-serif;font-size:13px;color:#bbb;margin-top:12px">
      discovery_only: nothing gets built. controlled_build: manual approval required. semi_auto: auto-builds above threshold. full_auto: fully autonomous.
    </p>
  </div>
</div>

<div class="card">
  <div class="ch">
    <span class="ct">Top Opportunities</span>
    <a href="/admin/inbound/opportunities" class="btn btn-sm btn-ghost">View all →</a>
  </div>
  <div class="tw"><table>
    <thead><tr><th>Niche</th><th>City</th><th>Score</th><th>Status</th><th class="r">Action</th></tr></thead>
    <tbody>${top10 || `<tr><td colspan="5" class="empty">Run discovery to score opportunities.</td></tr>`}</tbody>
  </table></div>
</div>

`;

  res.send(adminShell('Overview', body, '/admin/inbound'));
}

// ─── Mode update ──────────────────────────────────────────────────────────────

async function modeHandler(req, res) {
  const { mode, score_threshold } = req.body;
  const validModes = ['discovery_only','controlled_build','semi_auto','full_auto'];
  if (!validModes.includes(mode)) return res.status(400).send('Invalid mode.');

  await supabase.from('inbound_mode').update({
    mode,
    score_threshold: parseInt(score_threshold, 10) || 75,
    updated_at: new Date().toISOString(),
  }).eq('id', 1);

  res.redirect('/admin/inbound');
}

// ─── Opportunities list ───────────────────────────────────────────────────────

async function opportunitiesHandler(req, res) {
  const { status: filterStatus, niche: filterNiche } = req.query;

  let query = supabase.from('opportunities').select('*').order('score', { ascending: false });
  if (filterStatus) query = query.eq('status', filterStatus);
  if (filterNiche)  query = query.eq('niche', filterNiche);

  const { data: opps } = await query;

  const rows = (opps || []).map(o => {
    const bd = o.score_breakdown || {};
    const breakdown = o.score !== null
      ? `D:${bd.demand||'?'} C:${bd.competition||'?'} V:${bd.viability||'?'} S:${bd.seasonal||'?'}`
      : '—';
    const scoredDate = o.scored_at ? new Date(o.scored_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '—';
    const actions = o.status === 'discovered'
      ? `<form method="POST" action="/admin/inbound/opportunities/${o.id}/approve" style="display:inline">
           <button class="btn btn-sm btn-green">Approve</button></form>
         <form method="POST" action="/admin/inbound/opportunities/${o.id}/reject" style="display:inline;margin-left:6px">
           <button class="btn btn-sm btn-red">Reject</button></form>`
      : statusBadge(o.status);

    return `<tr>
      <td style="font-weight:500;color:#1a1a1a">${esc(o.niche)}</td>
      <td>${esc(o.city)}, ${esc(o.state)}</td>
      <td>${scoreBadge(o.score)}</td>
      <td style="font-family:monospace;font-size:12px;color:#999">${breakdown}</td>
      <td>${o.serp_has_ads ? '✓ Ads' : '—'} ${o.serp_has_map_pack ? '✓ Map' : ''}</td>
      <td>${o.maps_listing_count ?? '—'}</td>
      <td style="font-size:12px;color:#bbb">${scoredDate}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  const body = `
<div class="ph">
  <div class="ph-left"><h1><em>Opportunities.</em></h1>
    <div class="ph-sub">${(opps || []).length} combos scored. Approve to queue for site build.</div></div>
</div>
<div class="card"><div class="tw"><table>
  <thead><tr><th>Niche</th><th>City</th><th>Score</th><th>Breakdown</th><th>Signals</th><th>Maps</th><th>Scored</th><th>Actions</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="8" class="empty">No opportunities scored yet. Run discovery.</td></tr>`}</tbody>
</table></div></div>`;

  res.send(adminShell('Opportunities', body, '/admin/inbound/opportunities'));
}

// ─── Approve / Reject ─────────────────────────────────────────────────────────

async function approveHandler(req, res) {
  await supabase.from('opportunities').update({
    status: 'approved', approved_at: new Date().toISOString(),
  }).eq('id', req.params.id);
  res.redirect(req.get('Referer') || '/admin/inbound/opportunities');
}

async function rejectHandler(req, res) {
  await supabase.from('opportunities').update({
    status: 'rejected', rejected_reason: req.body.reason || null,
  }).eq('id', req.params.id);
  res.redirect(req.get('Referer') || '/admin/inbound/opportunities');
}

// ─── Sites list ───────────────────────────────────────────────────────────────

async function sitesHandler(_req, res) {
  const { data: sites } = await supabase
    .from('generated_sites')
    .select('*, opportunities(niche, city, state)')
    .order('created_at', { ascending: false });

  const rows = (sites || []).map(s => {
    const opp = s.opportunities || {};
    const published = s.published_at ? new Date(s.published_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
    return `<tr>
      <td style="font-weight:500;color:#1a1a1a">${esc(s.domain || s.site_path || '—')}</td>
      <td>${esc(opp.niche || '—')}</td>
      <td>${esc(opp.city || '—')}, ${esc(opp.state || '')}</td>
      <td>${statusBadge(s.status)}</td>
      <td class="r">${(s.monthly_visits || 0).toLocaleString()}</td>
      <td class="r">${(s.total_leads || 0).toLocaleString()}</td>
      <td style="font-size:13px;color:#bbb">${published}</td>
    </tr>`;
  }).join('');

  const body = `
<div class="ph">
  <div class="ph-left"><h1><em>Sites.</em></h1>
    <div class="ph-sub">${(sites || []).length} total sites generated.</div></div>
</div>
<div class="card"><div class="tw"><table>
  <thead><tr><th>Domain / Path</th><th>Niche</th><th>City</th><th>Status</th><th class="r">Visits/mo</th><th class="r">Leads</th><th>Published</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7" class="empty">No sites built yet. Approve an opportunity and run site-factory.</td></tr>`}</tbody>
</table></div></div>`;

  res.send(adminShell('Sites', body, '/admin/inbound/sites'));
}
