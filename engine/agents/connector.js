/**
 * connector.js — Saleshandy Integration Agent
 *
 * Reads 'approved' email drafts from Supabase and pushes them into
 * Saleshandy campaigns via the Saleshandy API. Creates campaigns if
 * they don't exist yet, adds prospects as leads, and assigns email
 * copy to the correct sequence step.
 *
 * Usage:
 *   CLIENT_ID=<uuid> CAMPAIGN_ID=<uuid> node agents/connector.js
 *
 * Saleshandy API docs: https://app.saleshandy.com/api-docs
 */

import axios from 'axios';
import { supabase } from '../lib/supabase.js';
import 'dotenv/config';

// ─── Clients ──────────────────────────────────────────────────────────────────

// Saleshandy base URL and auth header
const SH_BASE = 'https://api.saleshandy.com/api/v1';
const shHeaders = () => ({
  'X-Auth-Token': process.env.SALESHANDY_API_KEY,
  'Content-Type': 'application/json',
});

// How many approved emails to push per run
const BATCH_SIZE = 50;

// Delay between API calls to stay within rate limits
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API_DELAY_MS = 300;


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Push approved emails from one Supabase campaign into Saleshandy.
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

  // Ensure there's a matching Saleshandy campaign — create if needed
  const shCampaignId = await ensureSaleshandyCampaign(campaign);
  console.log(`[Connector] Saleshandy campaign ID: ${shCampaignId}`);

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

  console.log(`[Connector] Pushing ${emails.length} emails to Saleshandy.`);

  let pushed = 0;

  for (const email of emails) {
    try {
      await pushEmail(email, shCampaignId);
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

  console.log(`[Connector] Done. Pushed ${pushed} emails.`);
  return { pushed };
}


// ─── Saleshandy: ensure campaign exists ──────────────────────────────────────

/**
 * Checks if this Supabase campaign already has a Saleshandy campaign ID.
 * If not, creates a new Saleshandy campaign and stores the ID.
 * Returns the Saleshandy campaign ID string.
 */
async function ensureSaleshandyCampaign(campaign) {
  // Already linked — reuse existing Saleshandy campaign
  if (campaign.saleshandy_campaign_id) {
    return campaign.saleshandy_campaign_id;
  }

  // Create a new campaign in Saleshandy
  const response = await shPost('/campaign', {
    name: campaign.name,
    type: 'EMAIL',
    dailySendingLimit: 50,
    trackingEnabled: true,
  });

  const shCampaignId = response.data?.campaign?.id;
  if (!shCampaignId) {
    throw new Error(`[Connector] Saleshandy campaign create returned no ID.`);
  }

  // Save the Saleshandy campaign ID back to Supabase
  await supabase
    .from('campaigns')
    .update({ saleshandy_campaign_id: String(shCampaignId), status: 'active' })
    .eq('id', campaign.id);

  return String(shCampaignId);
}


// ─── Push one email to Saleshandy ─────────────────────────────────────────────

/**
 * Adds a prospect as a lead in Saleshandy and assigns the email copy.
 * Marks the email and prospect as 'sent' in Supabase on success.
 */
async function pushEmail(email, shCampaignId) {
  const prospect = email.prospects;
  if (!prospect?.email) {
    throw new Error('Prospect has no email address.');
  }

  // Step 1: Add the prospect as a lead to the Saleshandy campaign
  const leadResponse = await shPost(`/campaign/${shCampaignId}/lead`, {
    email: prospect.email,
    firstName: prospect.owner_name?.split(' ')[0] || '',
    lastName: prospect.owner_name?.split(' ').slice(1).join(' ') || '',
    phone: prospect.phone || '',
    website: prospect.website || '',
    companyName: prospect.business_name,
    customVariables: {
      business_name: prospect.business_name,
      niche: prospect.niche || '',
      city: prospect.city || '',
      state: prospect.state || '',
    },
    // Attach the email copy for step 0 (initial outreach)
    emailTemplates: [
      {
        step: 1, // Saleshandy uses 1-based step numbers
        subject: email.subject,
        body: email.body,
      },
    ],
  });

  const shEmailId = leadResponse.data?.lead?.id;

  // Step 2: Update the email record in Supabase
  await supabase
    .from('emails')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      saleshandy_email_id: shEmailId ? String(shEmailId) : null,
    })
    .eq('id', email.id);

  // Step 3: Update the prospect status
  await supabase
    .from('prospects')
    .update({ status: 'queued' })
    .eq('id', prospect.id);

  console.log(`[Connector] Pushed: ${prospect.business_name} <${prospect.email}>`);
}


// ─── Saleshandy API helpers ───────────────────────────────────────────────────

/**
 * POST to Saleshandy API. Returns the response data.
 */
async function shPost(path, body) {
  try {
    const response = await axios.post(`${SH_BASE}${path}`, body, {
      headers: shHeaders(),
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`Saleshandy POST ${path} failed: ${detail}`);
  }
}

/**
 * GET from Saleshandy API. Returns the response data.
 */
async function shGet(path) {
  try {
    const response = await axios.get(`${SH_BASE}${path}`, {
      headers: shHeaders(),
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    throw new Error(`Saleshandy GET ${path} failed: ${detail}`);
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
      console.log(`[Connector] Done. ${result.pushed} emails pushed to Saleshandy.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Connector] Fatal:', err.message);
      process.exit(1);
    });
}
