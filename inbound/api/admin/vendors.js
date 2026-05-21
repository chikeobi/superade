/**
 * api/admin/vendors.js — Vendor management routes
 *
 * Routes registered:
 *   GET  /vendors                    → vendor list
 *   GET  /vendors/new                → add vendor form
 *   POST /vendors                    → create vendor
 *   GET  /vendors/:id                → vendor detail + edit form + billing history
 *   POST /vendors/:id                → update vendor
 *   POST /vendors/:id/invoice        → create manual billing record + optional Stripe invoice
 *   POST /vendors/:id/convert-retainer → switch from pay_per_lead to monthly_retainer billing
 */

import express from 'express';
import Stripe from 'stripe';
import { supabase } from '../../lib/supabase.js';
import { requireAuth, esc, adminShell, statusBadge } from './auth.js';

const up = express.urlencoded({ extended: false });

const NICHES = [
  'Emergency Plumber','HVAC','Water Damage Restoration','Tree Removal',
  'Junk Removal','Roofing','Med Spa','Personal Injury Lawyer',
];
const MODES = ['pay_per_lead','build_first','sell_first'];
const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');

const getStripe = () => new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

export function registerVendorRoutes(router) {
  router.get('/vendors', requireAuth, vendorListHandler);
  router.get('/vendors/new', requireAuth, newVendorHandler);
  router.post('/vendors', requireAuth, up, createVendorHandler);
  router.get('/vendors/:id', requireAuth, vendorDetailHandler);
  router.post('/vendors/:id', requireAuth, up, updateVendorHandler);
  router.post('/vendors/:id/invoice', requireAuth, up, invoiceHandler);
  router.post('/vendors/:id/convert-retainer', requireAuth, up, convertRetainerHandler);
}

// ─── Vendor list ──────────────────────────────────────────────────────────────

async function vendorListHandler(_req, res) {
  const { data: vendors } = await supabase
    .from('vendors').select('*').order('created_at', { ascending: false });

  // Leads this month per vendor
  const thisMonth = new Date(); thisMonth.setDate(1); thisMonth.setHours(0,0,0,0);
  const { data: leads } = await supabase
    .from('inbound_leads').select('vendor_id, created_at, revenue')
    .gte('created_at', thisMonth.toISOString());

  const leadsByVendor = {};
  for (const l of leads || []) {
    if (!l.vendor_id) continue;
    if (!leadsByVendor[l.vendor_id]) leadsByVendor[l.vendor_id] = { count: 0, rev: 0 };
    leadsByVendor[l.vendor_id].count++;
    leadsByVendor[l.vendor_id].rev += l.revenue || 0;
  }

  const rows = (vendors || []).map(v => {
    const lm = leadsByVendor[v.id] || { count: 0, rev: 0 };
    const billing = v.monthly_retainer
      ? `$${v.monthly_retainer}/mo`
      : v.lead_price ? `$${v.lead_price}/lead` : '—';
    return `<tr>
      <td><a href="/admin/inbound/vendors/${v.id}" style="font-weight:600;color:#1a1a1a;text-decoration:none">${esc(v.name)}</a>
        <div style="font-size:12px;color:#bbb;margin-top:2px">${esc(v.email)}</div></td>
      <td>${esc(v.niche)}</td>
      <td>${esc(v.city)}, ${esc(v.state)}</td>
      <td>${statusBadge(v.acquisition_mode)}</td>
      <td>${statusBadge(v.billing_status)}</td>
      <td>${billing}</td>
      <td class="r">${lm.count}</td>
      <td class="r">$${lm.rev.toLocaleString()}</td>
      <td><a href="/admin/inbound/vendors/${v.id}" class="btn btn-sm btn-ghost">Edit →</a></td>
    </tr>`;
  }).join('');

  const body = `
<div class="ph">
  <div class="ph-left"><h1><em>Vendors.</em></h1>
    <div class="ph-sub">${(vendors || []).length} vendors. ${(vendors||[]).filter(v=>v.billing_status==='active').length} active.</div></div>
  <a href="/admin/inbound/vendors/new" class="btn btn-dark">Add Vendor +</a>
</div>
<div class="card"><div class="tw"><table>
  <thead><tr><th>Vendor</th><th>Niche</th><th>City</th><th>Mode</th><th>Status</th><th>Billing</th><th class="r">Leads/mo</th><th class="r">Rev/mo</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="9" class="empty">No vendors yet. Add your first vendor above.</td></tr>`}</tbody>
</table></div></div>`;

  res.send(adminShell('Vendors', body, '/admin/inbound/vendors'));
}

// ─── Add vendor form ──────────────────────────────────────────────────────────

function vendorFormHtml(v = {}, error = '') {
  const nicheOpts = NICHES.map(n => `<option${v.niche===n?' selected':''}>${esc(n)}</option>`).join('');
  const modeOpts  = MODES.map(m => `<option value="${m}"${v.acquisition_mode===m?' selected':''}>${m.replace(/_/g,' ')}</option>`).join('');
  const statusOpts = ['prospect','active','paused','cancelled'].map(s =>
    `<option${v.billing_status===s?' selected':''}>${s}</option>`).join('');
  const stateOpts = STATES.map(s => `<option${v.state===s?' selected':''}>${s}</option>`).join('');

  return `
${error ? `<div style="background:#fff0f0;border:1px solid #fecaca;border-radius:10px;padding:12px 16px;font-family:'Outfit',sans-serif;font-size:14px;color:#dc2626;margin-bottom:20px">${esc(error)}</div>` : ''}
<div class="fr">
  <div class="form-g"><label class="form-l">Name</label><input class="form-i" name="name" value="${esc(v.name||'')}" placeholder="ABC Plumbing Co." required></div>
  <div class="form-g"><label class="form-l">Email</label><input class="form-i" type="email" name="email" value="${esc(v.email||'')}" placeholder="owner@example.com" required></div>
</div>
<div class="fr">
  <div class="form-g"><label class="form-l">Phone</label><input class="form-i" name="phone" value="${esc(v.phone||'')}" placeholder="(713) 555-0100"></div>
  <div class="form-g"><label class="form-l">Niche</label><select class="form-i" name="niche"><option value="">Select niche…</option>${nicheOpts}</select></div>
</div>
<div class="fr">
  <div class="form-g"><label class="form-l">City</label><input class="form-i" name="city" value="${esc(v.city||'')}" placeholder="Houston"></div>
  <div class="form-g"><label class="form-l">State</label><select class="form-i" name="state"><option value="">Select…</option>${stateOpts}</select></div>
</div>
<div class="fr">
  <div class="form-g"><label class="form-l">Acquisition Mode</label><select class="form-i" name="acquisition_mode">${modeOpts}</select></div>
  <div class="form-g"><label class="form-l">Billing Status</label><select class="form-i" name="billing_status">${statusOpts}</select></div>
</div>
<div class="fr">
  <div class="form-g"><label class="form-l">Monthly Retainer ($)</label><input class="form-i" type="number" name="monthly_retainer" value="${v.monthly_retainer||''}" placeholder="leave blank if pay-per-lead" step="0.01" min="0"></div>
  <div class="form-g"><label class="form-l">Lead Price ($)</label><input class="form-i" type="number" name="lead_price" value="${v.lead_price||''}" placeholder="leave blank if on retainer" step="0.01" min="0"></div>
</div>
<div class="form-g"><label class="form-l">Stripe Customer ID</label><input class="form-i" name="stripe_customer_id" value="${esc(v.stripe_customer_id||'')}" placeholder="cus_… (optional, add when billing is set up)"></div>
<div class="form-g"><label class="form-l">Notes</label><textarea class="form-i" name="notes" rows="3" style="resize:vertical">${esc(v.notes||'')}</textarea></div>`;
}

function newVendorHandler(_req, res) {
  const body = `
<div class="ph"><div class="ph-left"><h1>Add <em>vendor.</em></h1></div></div>
<div class="card"><div class="cb">
  <form method="POST" action="/admin/inbound/vendors">${vendorFormHtml()}
    <div style="display:flex;gap:12px;margin-top:8px">
      <a href="/admin/inbound/vendors" class="btn btn-ghost">Cancel</a>
      <button type="submit" class="btn btn-dark">Create Vendor</button>
    </div>
  </form>
</div></div>`;
  res.send(adminShell('Add Vendor', body, '/admin/inbound/vendors'));
}

async function createVendorHandler(req, res) {
  const { name, email, phone, niche, city, state, acquisition_mode, billing_status, monthly_retainer, lead_price, stripe_customer_id, notes } = req.body;
  if (!name?.trim() || !email?.trim() || !niche || !city?.trim() || !state) {
    const body = `<div class="ph"><div class="ph-left"><h1>Add <em>vendor.</em></h1></div></div>
      <div class="card"><div class="cb"><form method="POST" action="/admin/inbound/vendors">
        ${vendorFormHtml(req.body, 'Name, email, niche, city, and state are required.')}
        <button type="submit" class="btn btn-dark" style="margin-top:8px">Create Vendor</button>
      </form></div></div>`;
    return res.send(adminShell('Add Vendor', body, '/admin/inbound/vendors'));
  }
  const { error } = await supabase.from('vendors').insert({
    name: name.trim(), email: email.trim().toLowerCase(), phone: phone?.trim() || null,
    niche, city: city.trim(), state,
    acquisition_mode: acquisition_mode || 'pay_per_lead',
    billing_status: billing_status || 'prospect',
    monthly_retainer: monthly_retainer ? parseFloat(monthly_retainer) : null,
    lead_price:       lead_price       ? parseFloat(lead_price)       : null,
    stripe_customer_id: stripe_customer_id?.trim() || null,
    notes: notes?.trim() || null,
  });
  if (error) {
    const msg = error.code === '23505' ? 'A vendor with that email already exists.' : error.message;
    const body = `<div class="ph"><div class="ph-left"><h1>Add <em>vendor.</em></h1></div></div>
      <div class="card"><div class="cb"><form method="POST" action="/admin/inbound/vendors">
        ${vendorFormHtml(req.body, msg)}
        <button type="submit" class="btn btn-dark" style="margin-top:8px">Create Vendor</button>
      </form></div></div>`;
    return res.send(adminShell('Add Vendor', body, '/admin/inbound/vendors'));
  }
  res.redirect('/admin/inbound/vendors');
}

// ─── Vendor detail + edit ─────────────────────────────────────────────────────

async function vendorDetailHandler(req, res) {
  const { data: v, error } = await supabase.from('vendors').select('*').eq('id', req.params.id).single();
  if (error || !v) return res.status(404).send('Vendor not found.');

  const { data: billing } = await supabase.from('vendor_billing')
    .select('*').eq('vendor_id', v.id).order('created_at', { ascending: false }).limit(20);

  const billingRows = (billing || []).map(b =>
    `<tr><td>${new Date(b.billing_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</td>
     <td>${statusBadge(b.billing_type)}</td>
     <td>$${parseFloat(b.amount).toFixed(2)}</td>
     <td>${statusBadge(b.status)}</td>
     <td style="font-size:12px;color:#bbb">${esc(b.stripe_invoice_id||'—')}</td></tr>`
  ).join('');

  const mailtoLink = `mailto:${esc(v.email)}?subject=Lead%20Generation%20Update%20%E2%80%94%20${encodeURIComponent(v.niche)}%20in%20${encodeURIComponent(v.city)}`;

  const body = `
<div class="ph">
  <div class="ph-left"><h1>${esc(v.name)}</h1>
    <div class="ph-sub">${esc(v.niche)} · ${esc(v.city)}, ${esc(v.state)} · ${statusBadge(v.billing_status)}</div></div>
  <div style="display:flex;gap:10px;flex-wrap:wrap">
    <a href="${mailtoLink}" class="btn btn-ghost">Contact Vendor ✉</a>
    ${!v.monthly_retainer && v.lead_price
      ? `<form method="POST" action="/admin/inbound/vendors/${v.id}/convert-retainer" style="display:inline">
           <input type="number" name="retainer_amount" placeholder="$/mo" class="form-i" style="width:120px;display:inline-block;margin-right:6px" required>
           <button class="btn btn-amber">Convert to Retainer</button></form>`
      : ''}
  </div>
</div>

<div class="card">
  <div class="ch"><span class="ct">Edit Vendor</span></div>
  <div class="cb">
    <form method="POST" action="/admin/inbound/vendors/${v.id}">${vendorFormHtml(v)}
      <button type="submit" class="btn btn-dark" style="margin-top:8px">Save Changes</button>
    </form>
  </div>
</div>

<div class="card">
  <div class="ch">
    <span class="ct">Billing History</span>
    <form method="POST" action="/admin/inbound/vendors/${v.id}/invoice" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select name="billing_type" class="form-i" style="width:auto">
        <option value="retainer">Retainer</option><option value="per_lead">Per Lead</option>
      </select>
      <input type="number" name="amount" class="form-i" placeholder="Amount $" step="0.01" min="0" style="width:130px" required>
      <input type="date" name="billing_date" class="form-i" value="${new Date().toISOString().slice(0,10)}" style="width:160px">
      <button class="btn btn-dark btn-sm">+ Add Invoice</button>
    </form>
  </div>
  <div class="tw"><table>
    <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th><th>Stripe ID</th></tr></thead>
    <tbody>${billingRows || `<tr><td colspan="5" class="empty">No billing records yet.</td></tr>`}</tbody>
  </table></div>
</div>`;

  res.send(adminShell(v.name, body, '/admin/inbound/vendors'));
}

async function updateVendorHandler(req, res) {
  const { name, email, phone, niche, city, state, acquisition_mode, billing_status, monthly_retainer, lead_price, stripe_customer_id, notes } = req.body;
  await supabase.from('vendors').update({
    name: name?.trim(), email: email?.trim().toLowerCase(), phone: phone?.trim() || null,
    niche, city: city?.trim(), state,
    acquisition_mode, billing_status,
    monthly_retainer: monthly_retainer ? parseFloat(monthly_retainer) : null,
    lead_price:       lead_price       ? parseFloat(lead_price)       : null,
    stripe_customer_id: stripe_customer_id?.trim() || null,
    notes: notes?.trim() || null,
  }).eq('id', req.params.id);
  res.redirect(`/admin/inbound/vendors/${req.params.id}`);
}

// ─── Manual invoice ───────────────────────────────────────────────────────────

async function invoiceHandler(req, res) {
  const { id } = req.params;
  const { billing_type, amount, billing_date } = req.body;
  const { data: vendor } = await supabase.from('vendors').select('stripe_customer_id, name').eq('id', id).single();
  let stripe_invoice_id = null;
  if (vendor?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = getStripe();
      const inv = await stripe.invoices.create({
        customer: vendor.stripe_customer_id,
        auto_advance: false,
        description: `${billing_type === 'retainer' ? 'Monthly retainer' : 'Lead generation fee'} — ${new Date(billing_date).toLocaleDateString('en-US',{month:'long',year:'numeric'})}`,
      });
      await stripe.invoiceItems.create({
        customer: vendor.stripe_customer_id,
        amount: Math.round(parseFloat(amount) * 100),
        currency: 'usd',
        invoice: inv.id,
        description: `Suparade inbound leads — ${billing_type}`,
      });
      await stripe.invoices.finalizeInvoice(inv.id);
      stripe_invoice_id = inv.id;
    } catch (err) {
      console.error(`[Admin] Stripe invoice failed for vendor ${id}: ${err.message}`);
    }
  }

  await supabase.from('vendor_billing').insert({
    vendor_id: id, billing_type, amount: parseFloat(amount),
    billing_date: billing_date || new Date().toISOString().slice(0,10),
    status: 'pending', stripe_invoice_id,
  });

  res.redirect(`/admin/inbound/vendors/${id}`);
}

// ─── Convert to retainer ──────────────────────────────────────────────────────

async function convertRetainerHandler(req, res) {
  const { retainer_amount } = req.body;
  await supabase.from('vendors').update({
    monthly_retainer: parseFloat(retainer_amount),
    lead_price: null,
    acquisition_mode: 'build_first',
    billing_status: 'active',
  }).eq('id', req.params.id);
  res.redirect(`/admin/inbound/vendors/${req.params.id}`);
}
