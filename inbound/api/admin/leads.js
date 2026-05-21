/**
 * api/admin/leads.js — Inbound leads view
 *
 * Routes registered:
 *   GET  /leads            → full leads table with routing status + revenue
 *   POST /leads/:id/route  → manually mark a lead as routed (assign vendor)
 */

import express from 'express';
import { supabase } from '../../lib/supabase.js';
import { requireAuth, esc, adminShell, statusBadge } from './auth.js';

const up = express.urlencoded({ extended: false });

export function registerLeadsRoutes(router) {
  router.get('/leads', requireAuth, leadsHandler);
  router.post('/leads/:id/route', requireAuth, up, routeLeadHandler);
}

// ─── Leads list ───────────────────────────────────────────────────────────────

async function leadsHandler(req, res) {
  const { status: filterStatus, vendor: filterVendor } = req.query;

  // Fetch leads with site + vendor info
  let query = supabase
    .from('inbound_leads')
    .select('*, generated_sites(domain, site_path, opportunities(niche, city, state)), vendors(name)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (filterStatus) query = query.eq('status', filterStatus);
  if (filterVendor) query = query.eq('vendor_id', filterVendor);

  const [{ data: leads }, { data: vendors }] = await Promise.all([
    query,
    supabase.from('vendors').select('id, name').eq('billing_status', 'active').order('name'),
  ]);

  // Revenue summary
  const totalRevenue = (leads || []).reduce((s, l) => s + (l.revenue || 0), 0);
  const soldLeads    = (leads || []).filter(l => l.status === 'sold').length;
  const newLeads     = (leads || []).filter(l => l.status === 'new').length;
  const routedLeads  = (leads || []).filter(l => l.status === 'routed').length;

  // Filter bar
  const statusFilter = ['new','routed','sold','rejected'].map(s =>
    `<a href="?status=${s}${filterVendor ? '&vendor='+filterVendor : ''}" class="btn btn-sm ${filterStatus===s ? 'btn-dark' : 'btn-ghost'}">${s}</a>`
  ).join('');

  // Vendor filter dropdown
  const vendorOpts = (vendors || []).map(v =>
    `<option value="${v.id}"${filterVendor===v.id?' selected':''}>${esc(v.name)}</option>`).join('');

  // Active vendors for the route modal (inline selects)
  const vendorSelectOpts = (vendors || []).map(v =>
    `<option value="${v.id}">${esc(v.name)}</option>`).join('');

  const rows = (leads || []).map(l => {
    const site = l.generated_sites || {};
    const opp  = site.opportunities || {};
    const siteName = site.domain || site.site_path || '—';
    const niche    = opp.niche    ? `${opp.niche} · ${opp.city}, ${opp.state}` : '—';
    const date     = new Date(l.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const contact  = [l.name, l.email].filter(Boolean).join(' · ') || '—';
    const vendor   = l.vendors?.name || '—';
    const revenue  = l.revenue != null ? `$${parseFloat(l.revenue).toFixed(0)}` : '—';

    const routeForm = l.status === 'new' && vendors?.length
      ? `<form method="POST" action="/admin/inbound/leads/${l.id}/route" style="display:flex;gap:6px">
          <select name="vendor_id" class="form-i" style="font-size:13px;padding:5px 10px;width:auto" required>
            <option value="">Assign…</option>${vendorSelectOpts}
          </select>
          <button class="btn btn-sm btn-green">Route</button>
        </form>`
      : statusBadge(l.status);

    return `<tr>
      <td style="font-size:13px;color:#bbb;white-space:nowrap">${date}</td>
      <td style="font-size:13px">${esc(niche)}</td>
      <td>${esc(contact)}<div style="font-size:12px;color:#bbb">${esc(l.phone||'')}</div></td>
      <td style="font-size:13px;color:#888;max-width:200px">${esc((l.service_requested||l.message||'').slice(0,80))}${(l.service_requested||l.message||'').length>80?'…':''}</td>
      <td>${esc(vendor)}</td>
      <td>${revenue}</td>
      <td>${routeForm}</td>
    </tr>`;
  }).join('');

  const body = `
<div class="ph">
  <div class="ph-left"><h1><em>Leads.</em></h1>
    <div class="ph-sub">${(leads||[]).length} leads shown · ${soldLeads} sold · $${totalRevenue.toLocaleString()} total revenue</div></div>
</div>

<div class="stats">
  <div class="stat"><div class="sl">New</div><div class="sv">${newLeads}</div></div>
  <div class="stat"><div class="sl">Routed</div><div class="sv">${routedLeads}</div></div>
  <div class="stat"><div class="sl">Sold</div><div class="sv">${soldLeads}</div></div>
  <div class="stat"><div class="sl">Total Revenue</div><div class="sv">$${totalRevenue.toLocaleString()}</div></div>
</div>

<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
  <a href="?" class="btn btn-sm ${!filterStatus ? 'btn-dark' : 'btn-ghost'}">All</a>
  ${statusFilter}
  <form style="margin-left:auto;display:flex;gap:8px">
    <select name="vendor" class="form-i" style="width:auto;font-size:13px;padding:6px 12px"
      onchange="this.form.submit()">
      <option value="">All vendors</option>${vendorOpts}
    </select>
    ${filterStatus ? `<input type="hidden" name="status" value="${esc(filterStatus)}">` : ''}
  </form>
</div>

<div class="card"><div class="tw"><table>
  <thead><tr><th>Date</th><th>Niche · City</th><th>Contact</th><th>Service</th><th>Vendor</th><th>Revenue</th><th>Action</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7" class="empty">No leads yet. Once sites are live, leads will appear here.</td></tr>`}</tbody>
</table></div></div>`;

  res.send(adminShell('Leads', body, '/admin/inbound/leads'));
}

// ─── Route a lead to a vendor ─────────────────────────────────────────────────

async function routeLeadHandler(req, res) {
  const { id } = req.params;
  const { vendor_id } = req.body;
  if (!vendor_id) return res.redirect('/admin/inbound/leads');

  const { data: vendor } = await supabase.from('vendors')
    .select('lead_price').eq('id', vendor_id).single();

  await supabase.from('inbound_leads').update({
    status: 'routed',
    vendor_id,
    routed_at: new Date().toISOString(),
    revenue: vendor?.lead_price || null,
  }).eq('id', id);

  res.redirect('/admin/inbound/leads');
}
