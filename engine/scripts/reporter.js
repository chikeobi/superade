/**
 * reporter.js — Monthly Performance Report Generator
 *
 * Generates a PDF performance report for each active client.
 * Shows prospects contacted, emails sent, reply rate, conversions,
 * and a per-campaign breakdown.
 *
 * Usage:
 *   node scripts/reporter.js              # generates for ALL active clients
 *   CLIENT_ID=<uuid> node scripts/reporter.js  # generates for one client
 *
 * Output: /reports/<client-name>-<month>.pdf
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { supabase } from '../lib/supabase.js';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '..', 'reports');

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runReporter(targetClientId = null) {
  await mkdir(REPORTS_DIR, { recursive: true });

  // Fetch active clients (or just the one specified)
  let query = supabase.from('clients').select('*').eq('billing_status', 'active');
  if (targetClientId) query = query.eq('id', targetClientId);

  const { data: clients, error } = await query;
  if (error) throw new Error(`[Reporter] DB error: ${error.message}`);
  if (!clients?.length) {
    console.log('[Reporter] No active clients found.');
    return;
  }

  const month = currentMonthLabel();

  for (const client of clients) {
    try {
      const stats = await gatherStats(client.id, month);
      const pdfBytes = await buildPdf(client, stats, month);
      const filename = `${slugify(client.name)}-${month}.pdf`;
      const filepath = join(REPORTS_DIR, filename);
      await writeFile(filepath, pdfBytes);
      console.log(`[Reporter] Generated: ${filename}`);

      await logEvent(client.id, 'report.generated', { month, filename });
    } catch (err) {
      console.error(`[Reporter] Failed for client ${client.name}: ${err.message}`);
    }
  }
}


// ─── Stats gathering ──────────────────────────────────────────────────────────

/**
 * Pulls all the numbers needed for a client's monthly report.
 */
async function gatherStats(clientId, month) {
  // Date range for this month
  const start = `${month}-01T00:00:00Z`;
  const end = new Date(
    new Date(start).getFullYear(),
    new Date(start).getMonth() + 1,
    1
  ).toISOString();

  // Prospects discovered this month
  const { count: prospectCount } = await supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('created_at', start)
    .lt('created_at', end);

  // Emails sent
  const { count: sentCount } = await supabase
    .from('emails')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'sent')
    .gte('sent_at', start)
    .lt('sent_at', end);

  // Replies received
  const { count: replyCount } = await supabase
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('type', 'reply.received')
    .gte('created_at', start)
    .lt('created_at', end);

  // Conversions (Stripe payments tied to this client's prospects)
  const { count: conversionCount } = await supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('status', 'converted');

  // Campaign breakdown
  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, status')
    .eq('client_id', clientId)
    .eq('month', month);

  const replyRate =
    sentCount > 0 ? ((replyCount / sentCount) * 100).toFixed(1) : '0.0';

  return {
    prospects: prospectCount || 0,
    sent: sentCount || 0,
    replies: replyCount || 0,
    conversions: conversionCount || 0,
    replyRate,
    campaigns: campaigns || [],
  };
}


// ─── PDF builder ──────────────────────────────────────────────────────────────

/**
 * Builds and returns a PDF as a Uint8Array.
 */
async function buildPdf(client, stats, month) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter

  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await doc.embedFont(StandardFonts.Helvetica);

  const black = rgb(0.1, 0.1, 0.1);
  const accent = rgb(0.13, 0.46, 0.82); // blue
  const lightGray = rgb(0.9, 0.9, 0.9);

  let y = 740;
  const left = 60;
  const right = 552;

  // ── Header bar ──────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 760, width: 612, height: 32, color: accent });
  page.drawText('SUPERADE', {
    x: left,
    y: 769,
    size: 14,
    font: boldFont,
    color: rgb(1, 1, 1),
  });
  page.drawText('Monthly Performance Report', {
    x: 200,
    y: 769,
    size: 12,
    font: regularFont,
    color: rgb(1, 1, 1),
  });

  // ── Client header ────────────────────────────────────────
  page.drawText(client.name, { x: left, y, size: 22, font: boldFont, color: black });
  y -= 22;
  page.drawText(`${formatMonth(month)}  ·  ${client.tier.toUpperCase()} Plan`, {
    x: left, y, size: 11, font: regularFont, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 30;

  // ── Divider ──────────────────────────────────────────────
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: lightGray });
  y -= 24;

  // ── KPI boxes ───────────────────────────────────────────
  const kpis = [
    { label: 'Prospects Found', value: stats.prospects },
    { label: 'Emails Sent', value: stats.sent },
    { label: 'Replies', value: stats.replies },
    { label: 'Reply Rate', value: `${stats.replyRate}%` },
    { label: 'Conversions', value: stats.conversions },
  ];

  const boxW = 96;
  const boxH = 60;
  const boxGap = 9;
  let bx = left;

  for (const kpi of kpis) {
    page.drawRectangle({
      x: bx, y: y - boxH, width: boxW, height: boxH,
      color: rgb(0.96, 0.97, 1),
      borderColor: accent,
      borderWidth: 1,
    });
    page.drawText(String(kpi.value), {
      x: bx + 12, y: y - 28, size: 20, font: boldFont, color: accent,
    });
    page.drawText(kpi.label, {
      x: bx + 8, y: y - 46, size: 8, font: regularFont, color: black,
    });
    bx += boxW + boxGap;
  }

  y -= boxH + 30;

  // ── Campaign breakdown ───────────────────────────────────
  page.drawText('Campaigns This Month', {
    x: left, y, size: 13, font: boldFont, color: black,
  });
  y -= 18;

  if (stats.campaigns.length === 0) {
    page.drawText('No campaigns ran this month.', {
      x: left, y, size: 10, font: regularFont, color: rgb(0.5, 0.5, 0.5),
    });
    y -= 16;
  } else {
    // Table header
    page.drawRectangle({
      x: left, y: y - 16, width: right - left, height: 18, color: lightGray,
    });
    page.drawText('Campaign Name', { x: left + 8, y: y - 12, size: 9, font: boldFont, color: black });
    page.drawText('Status', { x: 420, y: y - 12, size: 9, font: boldFont, color: black });
    y -= 16;

    for (const camp of stats.campaigns) {
      page.drawText(camp.name, { x: left + 8, y: y - 12, size: 9, font: regularFont, color: black });
      page.drawText(camp.status, { x: 420, y: y - 12, size: 9, font: regularFont, color: black });
      y -= 16;
      page.drawLine({
        start: { x: left, y },
        end: { x: right, y },
        thickness: 0.5,
        color: lightGray,
      });
    }
  }

  y -= 30;

  // ── Footer ───────────────────────────────────────────────
  page.drawLine({ start: { x: left, y: 40 }, end: { x: right, y: 40 }, thickness: 1, color: lightGray });
  page.drawText(
    `Generated by Superade Engine · ${new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}`,
    { x: left, y: 25, size: 8, font: regularFont, color: rgb(0.6, 0.6, 0.6) }
  );

  return doc.save();
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns current month as "YYYY-MM" */
function currentMonthLabel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Formats "2025-04" → "April 2025" */
function formatMonth(label) {
  const [year, month] = label.split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** Converts a name to a URL-safe slug */
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function logEvent(clientId, type, payload) {
  await supabase.from('events').insert({
    client_id: clientId,
    type,
    payload,
    source: 'reporter',
  });
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('reporter.js')) {
  const clientId = process.env.CLIENT_ID || null;

  runReporter(clientId)
    .then(() => {
      console.log('[Reporter] All reports generated.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Reporter] Fatal:', err.message);
      process.exit(1);
    });
}
