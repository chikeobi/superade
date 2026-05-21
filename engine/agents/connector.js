/**
 * connector.js — Instantly Integration Agent
 *
 * Reads 'approved' email drafts from Supabase and pushes them into
 * Instantly campaigns via the Instantly API v2. Creates campaigns if
 * they don't exist yet, then adds prospects as leads with their
 * Brain-written email copy injected as custom variables.
 *
 * The campaign sequence template uses {{subject}} and {{body}} so each
 * lead receives its own fully personalized email at send time.
 *
 * Usage:
 *   CLIENT_ID=<uuid> CAMPAIGN_ID=<uuid> node agents/connector.js
 */

import axios from 'axios';
import { supabase } from '../lib/supabase.js';
import 'dotenv/config';

// ─── Clients ──────────────────────────────────────────────────────────────────

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';
const iHeaders = () => ({
  Authorization: `Bearer ${process.env.INSTANTLY_API_KEY}`,
  'Content-Type': 'application/json',
});

// How many approved emails to push per run
const BATCH_SIZE = 50;

// Delay between API calls to stay within rate limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API_DELAY_MS = 300;


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Push approved emails from one Supabase campaign into Instantly.
 *
 * @param {string} clientId    - Supabase client UUID
 * @param {string} campaignId  - Supabase campaign UUID
 */
export async function runConnector(clientId, campaignId) {
  console.log(`[Connector] Starting — client=${clientId} campaign=${campaignId}`);

  // Load the campaign record
  const { data: campaign, error: campErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (campErr || !campaign) throw new Error(`[Connector] Campaign not found: ${campaignId}`);

  // Ensure there's a matching Instantly campaign — create if needed.
  // saleshandy_campaign_id column is reused to store the Instantly campaign ID
  // without requiring a schema migration.
  const instantlyCampaignId = await ensureInstantlyCampaign(campaign);
  console.log(`[Connector] Instantly campaign ID: ${instantlyCampaignId}`);

  // Fetch approved emails for this campaign
  const { data: emails, error: emailErr } = await supabase
    .from('emails')
    .select('*, prospects(*)')
    .eq('campaign_id', campaignId)
    .eq('status', 'approved')
    .limit(BATCH_SIZE);

  if (emailErr) throw new Error(`[Connector] DB error: ${emailErr.message}`);
  if (!emails || emails.length === 0) {
    console.log('[Connector] No approved emails to push. Done.');
    return { pushed: 0 };
  }

  console.log(`[Connector] Pushing ${emails.length} emails to Instantly.`);

  let pushed = 0;

  for (const email of emails) {
    try {
      await pushEmail(email, instantlyCampaignId);
      pushed++;
    } catch (err) {
      console.error(`[Connector] Failed on email ${email.id}: ${err.message}`);
      await logEvent(clientId, email.prospect_id, 'email.failed', {
        email_id: email.id,
        error: err.message,
      });
    }
    await sleep(API_DELAY_MS);
  }

  // Update the client's monthly send counter so Scout's quota check stays accurate
  if (pushed > 0) {
    await supabase.rpc('increment_prospects_sent', {
      p_client_id: clientId,
      p_count: pushed,
    });
  }

  console.log(`[Connector] Done. Pushed ${pushed} emails.`);
  return { pushed };
}


// ─── Instantly: ensure campaign exists ────────────────────────────────────────

/**
 * Checks if this Supabase campaign already has an Instantly campaign ID.
 * If not, creates a new Instantly campaign with a sequence template that
 * accepts {{subject}} and {{body}} custom variables per lead.
 * Returns the Instantly campaign ID string.
 */
async function ensureInstantlyCampaign(campaign) {
  // Already linked — reuse existing Instantly campaign
  if (campaign.saleshandy_campaign_id) {
    return campaign.saleshandy_campaign_id;
  }

  // Create the campaign. The sequence template uses {{subject}}/{{body}} so
  // Brain's fully personalized copy is injected per-lead at send time.
  const data = await iPost('/campaigns', {
    name: campaign.name,
    sequences: [
      {
        steps: [
          {
            type: 'email',
            delay: 0,
            variants: [
              {
                subject: '{{subject}}',
                body: '{{body}}',
              },
            ],
          },
        ],
      },
    ],
    campaign_schedule: {
      schedules: [
        {
          name: 'Business Hours',
          timing: { from: '08:00', to: '17:00' },
          days: {
            sun: false,
            mon: true,
            tue: true,
            wed: true,
            thu: true,
            fri: true,
            sat: false,
          },
          timezone: 'America/New_York',
        },
      ],
    },
  });

  const instantlyId = data?.id;
  if (!instantlyId) {
    throw new Error('[Connector] Instantly campaign create returned no ID.');
  }

  // Persist the Instantly campaign ID so future runs skip creation
  await supabase
    .from('campaigns')
    .update({ saleshandy_campaign_id: String(instantlyId), status: 'active' })
    .eq('id', campaign.id);

  console.log(`[Connector] Created Instantly campaign: ${campaign.name}`);
  return String(instantlyId);
}


// ─── Push one email to Instantly ─────────────────────────────────────────────

/**
 * Adds a prospect as a lead in the Instantly campaign, injecting the
 * Brain-written subject and body as custom variables.
 * Marks the email and prospect as 'queued' in Supabase on success.
 */
async function pushEmail(email, instantlyCampaignId) {
  const prospect = email.prospects;
  if (!prospect?.email) {
    throw new Error('Prospect has no email address.');
  }

  const [firstName = '', ...lastParts] = (prospect.owner_name || '').split(' ');
  const lastName = lastParts.join(' ');

  const data = await iPost('/leads/add-leads-in-bulk', {
    campaign_id: instantlyCampaignId,
    leads: [
      {
        email: prospect.email,
        first_name: firstName,
        last_name: lastName,
        company_name: prospect.business_name,
        custom_variables: {
          subject: email.subject,
          body: email.body,
          business_name: prospect.business_name,
          niche: prospect.niche || '',
          city: prospect.city || '',
          state: prospect.state || '',
        },
      },
    ],
  });

  // Store the Instantly lead ID for cross-reference (column repurposed from Saleshandy)
  const instantlyLeadId =
    data?.leads?.[0]?.id ?? data?.results?.[0]?.id ?? null;

  // Mark the email as sent
  await supabase
    .from('emails')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      saleshandy_email_id: instantlyLeadId ? String(instantlyLeadId) : null,
    })
    .eq('id', email.id);

  // Advance the prospect to 'queued' (in Instantly's send queue)
  await supabase
    .from('prospects')
    .update({ status: 'queued' })
    .eq('id', prospect.id);

  console.log(`[Connector] Pushed: ${prospect.business_name} <${prospect.email}>`);
}


// ─── Instantly API helpers ────────────────────────────────────────────────────

/**
 * POST to Instantly API v2. Returns the response data.
 */
async function iPost(path, body) {
  try {
    const response = await axios.post(`${INSTANTLY_BASE}${path}`, body, {
      headers: iHeaders(),
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    const detail =
      err.response?.data?.message ||
      err.response?.data?.error ||
      err.message;
    throw new Error(`Instantly POST ${path} failed: ${detail}`);
  }
}


// ─── Event Logger ─────────────────────────────────────────────────────────────

async function logEvent(clientId, prospectId, type, payload) {
  await supabase.from('events').insert({
    client_id: clientId,
    prospect_id: prospectId,
    type,
    payload,
    source: 'connector',
  });
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('connector.js')) {
  const clientId = process.env.CLIENT_ID;
  const campaignId = process.env.CAMPAIGN_ID;

  if (!clientId || !campaignId) {
    console.error('Usage: CLIENT_ID=<uuid> CAMPAIGN_ID=<uuid> node agents/connector.js');
    process.exit(1);
  }

  runConnector(clientId, campaignId)
    .then((result) => {
      console.log(`[Connector] Done. ${result.pushed} emails pushed to Instantly.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Connector] Fatal:', err.message);
      process.exit(1);
    });
}
