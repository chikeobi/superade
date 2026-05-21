/**
 * lib/mailer.js — transactional email via Resend API
 *
 * Uses native fetch (Node 18+) — no additional dependency.
 *
 * ENV vars required:
 *   RESEND_API_KEY     — from resend.com
 *   OPERATOR_EMAIL     — where operator lead alerts go
 *   INBOUND_FROM_EMAIL — verified sending address (e.g. leads@yourdomain.com)
 *
 * Exports:
 *   sendOperatorLeadAlert(lead, opp)          → alert operator on every new lead
 *   sendVendorLeadAlert(lead, vendor, opp)    → send lead details to routed vendor
 */

import 'dotenv/config';

const RESEND_API = 'https://api.resend.com/emails';

// ─── Core send ────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from   = process.env.INBOUND_FROM_EMAIL || 'leads@superade.com';

  if (!apiKey) {
    console.warn('[mailer] RESEND_API_KEY not set — skipping email to', to);
    return;
  }

  const res = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[mailer] Send failed (${res.status}):`, body);
  }
}

// ─── Email templates ──────────────────────────────────────────────────────────

function row(label, value) {
  if (!value) return '';
  return `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;font-size:14px;white-space:nowrap">${label}</td><td style="padding:6px 0;font-size:14px;font-weight:600">${value}</td></tr>`;
}

function baseTemplate(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
  <tr><td style="background:#1a2744;padding:24px 32px">
    <p style="margin:0;color:#fff;font-size:20px;font-weight:700">${title}</p>
  </td></tr>
  <tr><td style="padding:28px 32px">${bodyHtml}</td></tr>
  <tr><td style="background:#f9fafb;padding:16px 32px;color:#9ca3af;font-size:12px;border-top:1px solid #e5e7eb">
    Superade Inbound · Automated lead alert
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ─── Operator alert ───────────────────────────────────────────────────────────

export async function sendOperatorLeadAlert(lead, opp) {
  const to      = process.env.OPERATOR_EMAIL;
  const niche   = opp ? `${opp.niche} — ${opp.city}, ${opp.state}` : 'Unknown';
  const subject = `New lead: ${lead.name || lead.phone || lead.email} · ${niche}`;

  const bodyHtml = `
<p style="margin:0 0 20px;font-size:15px;color:#374151">A new lead came in via <strong>${niche}</strong>.</p>
<table cellpadding="0" cellspacing="0" style="width:100%">
  ${row('Name',    lead.name)}
  ${row('Phone',   lead.phone)}
  ${row('Email',   lead.email)}
  ${row('Service', lead.service_requested)}
  ${row('Status',  lead.status)}
  ${row('Vendor',  lead.vendor_name || (lead.vendor_id ? `ID ${lead.vendor_id}` : 'Unrouted'))}
</table>
<p style="margin:24px 0 0">
  <a href="${process.env.ADMIN_URL || 'http://localhost:3001'}/admin/inbound/leads"
     style="display:inline-block;background:#f97316;color:#fff;font-weight:700;padding:11px 22px;border-radius:7px;text-decoration:none;font-size:14px">
    View in Admin →
  </a>
</p>`;

  await sendEmail({ to, subject, html: baseTemplate('New Lead Alert', bodyHtml) });
}

// ─── Vendor alert ─────────────────────────────────────────────────────────────

export async function sendVendorLeadAlert(lead, vendor, opp) {
  if (!vendor?.email) return;

  const niche   = opp ? `${opp.niche} — ${opp.city}, ${opp.state}` : 'Local Service';
  const subject = `New lead for you: ${lead.name || lead.phone} · ${opp?.city || ''}`;

  const bodyHtml = `
<p style="margin:0 0 6px;font-size:15px;color:#374151">You have a new lead from <strong>${niche}</strong>.</p>
<p style="margin:0 0 20px;font-size:14px;color:#6b7280">Reach out promptly — speed-to-contact is everything.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
  <tr style="background:#f9fafb"><td colspan="2" style="padding:10px 16px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Lead Details</td></tr>
  ${row('Name',    lead.name)}
  ${row('Phone',   lead.phone)}
  ${row('Email',   lead.email)}
  ${row('Request', lead.service_requested)}
</table>
<p style="margin:20px 0 0;font-size:13px;color:#9ca3af">
  This lead was sent exclusively to you. Reply to this email with any questions.
</p>`;

  await sendEmail({ to: vendor.email, subject, html: baseTemplate('You Have a New Lead', bodyHtml) });
}
