/**
 * api/lead-capture.js — receives form submissions from generated lead-gen sites
 *
 * Routes:
 *   POST /leads/capture — accept form data, save to inbound_leads, redirect to /thanks
 *
 * The generated index.html POSTs to /leads/capture with:
 *   site_slug, name, phone, email, service_requested
 *
 * On success → redirect to /<site_slug>/thanks.html
 * On error   → redirect back with ?error=1 (fail open, never lose a lead)
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';
import { sendOperatorLeadAlert, sendVendorLeadAlert } from '../lib/mailer.js';

const up = express.urlencoded({ extended: false, limit: '10kb' });

export function registerCaptureRoutes(router) {
  router.post('/capture', up, captureHandler);
}

// ─── Sanitize input ───────────────────────────────────────────────────────────

function sanitize(val, maxLen = 500) {
  if (!val || typeof val !== 'string') return null;
  return val.trim().slice(0, maxLen) || null;
}

function sanitizeEmail(val) {
  const s = sanitize(val, 254);
  return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

function sanitizePhone(val) {
  const s = sanitize(val, 30);
  return s && /[\d\-\+\(\) ]{7,}/.test(s) ? s : null;
}

// ─── Resolve site_id from slug ────────────────────────────────────────────────

async function resolveSiteId(slug) {
  if (!slug) return null;
  const { data } = await supabase
    .from('generated_sites')
    .select('id')
    .eq('site_path', slug)
    .single();
  return data?.id || null;
}

// ─── Auto-route to first active vendor for this niche+city ───────────────────

async function tryAutoRoute(siteId) {
  if (!siteId) return null;

  const { data: site } = await supabase
    .from('generated_sites')
    .select('opportunity_id, opportunities(niche, city, state)')
    .eq('id', siteId)
    .single();

  if (!site?.opportunities) return null;
  const { niche, city, state } = site.opportunities;

  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, email, name, lead_price, acquisition_mode')
    .eq('billing_status', 'active')
    .eq('niche', niche)
    .eq('city', city)
    .eq('state', state)
    .eq('acquisition_mode', 'pay_per_lead')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  return vendor || null;
}

// ─── Fetch opp for email context ──────────────────────────────────────────────

async function fetchOppForSite(siteId) {
  if (!siteId) return null;
  const { data } = await supabase
    .from('generated_sites')
    .select('opportunities(niche, city, state)')
    .eq('id', siteId)
    .single();
  return data?.opportunities || null;
}


// ─── Handler ──────────────────────────────────────────────────────────────────

async function captureHandler(req, res) {
  const slug         = sanitize(req.body.site_slug, 120);
  const name         = sanitize(req.body.name, 120);
  const phone        = sanitizePhone(req.body.phone);
  const email        = sanitizeEmail(req.body.email);
  const service      = sanitize(req.body.service_requested, 1000);

  // Need at minimum a slug and one contact method
  if (!slug || (!phone && !email)) {
    return res.redirect(`/${slug || ''}?error=1`);
  }

  let siteId = null;
  let vendorId = null;
  let revenue = null;
  let status = 'new';

  try {
    siteId = await resolveSiteId(slug);

    // Attempt auto-routing to a pay-per-lead vendor
    const vendor = await tryAutoRoute(siteId);
    if (vendor) {
      vendorId = vendor.id;
      revenue  = vendor.lead_price;
      status   = 'routed';
    }

    const leadPayload = {
      site_id: siteId,
      name,
      phone,
      email,
      service_requested: service,
      status,
      vendor_id: vendorId,
      routed_at: vendorId ? new Date().toISOString() : null,
      revenue,
      utm_source:   sanitize(req.query.utm_source),
      utm_medium:   sanitize(req.query.utm_medium),
      utm_campaign: sanitize(req.query.utm_campaign),
      raw_payload: {
        body: req.body,
        ip: req.ip,
        ua: req.headers['user-agent'],
      },
    };

    const { error } = await supabase.from('inbound_leads').insert(leadPayload);
    if (error) console.error('[lead-capture] Insert error:', error.message);

    console.log(`[lead-capture] NEW LEAD — site: ${slug} | name: ${name} | phone: ${phone} | email: ${email}`);

    // Fire emails without blocking the redirect
    const opp = await fetchOppForSite(siteId);
    const lead = { name, phone, email, service_requested: service, status, vendor_id: vendorId };
    sendOperatorLeadAlert(lead, opp).catch(e => console.error('[mailer] operator alert failed:', e.message));
    if (vendor) {
      sendVendorLeadAlert(lead, vendor, opp).catch(e => console.error('[mailer] vendor alert failed:', e.message));
    }
  } catch (err) {
    // Fail open — always redirect to thanks, never show an error to a real lead
    console.error('[lead-capture] Unexpected error:', err.message);
  }

  // Redirect to site-specific thanks page
  res.redirect(`/sites/${slug}/thanks.html`);
}
