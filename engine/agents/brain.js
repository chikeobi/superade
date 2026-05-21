/**
 * brain.js — Research & Copywriting Agent
 *
 * Reads 'discovered' prospects from Supabase, fetches their website,
 * uses Claude API to research the business and write a personalized
 * cold email using the client's style profile JSON.
 *
 * Saves the drafted email to the emails table with status='draft'.
 * Updates the prospect status to 'researched'.
 *
 * Usage:
 *   CLIENT_ID=<uuid> CAMPAIGN_ID=<uuid> node agents/brain.js
 *
 * Or import and call runBrain() programmatically.
 */

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { readFile } from 'fs/promises';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Clients ──────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// How many prospects to process in one run
const BATCH_SIZE = 20;

// Claude model to use for email writing
const MODEL = 'claude-opus-4-7';


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the Brain agent for one client campaign.
 * Processes up to BATCH_SIZE 'discovered' prospects.
 *
 * @param {string} clientId    - Supabase client UUID
 * @param {string} campaignId  - Supabase campaign UUID
 */
export async function runBrain(clientId, campaignId) {
  console.log(`[Brain] Starting — client=${clientId} campaign=${campaignId}`);

  // Load the client and their style profile
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, name, style_profile, target_niche, billing_status, is_paused')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) throw new Error(`[Brain] Client not found: ${clientId}`);
  if (client.billing_status !== 'active') {
    throw new Error(`[Brain] Client billing is ${client.billing_status} — aborting.`);
  }
  if (client.is_paused) {
    console.log('[Brain] Client is paused — skipping.');
    return;
  }

  // Load the style profile JSON from /profiles/<name>.json
  const profile = await loadStyleProfile(client.style_profile);
  console.log(`[Brain] Loaded style profile: ${client.style_profile}`);

  // Fetch a batch of prospects that need emails written
  const { data: prospects, error: prospectsErr } = await supabase
    .from('prospects')
    .select('*')
    .eq('client_id', clientId)
    .eq('status', 'discovered')
    .not('email', 'is', null)
    .limit(BATCH_SIZE);

  if (prospectsErr) throw new Error(`[Brain] DB error: ${prospectsErr.message}`);
  if (!prospects || prospects.length === 0) {
    console.log('[Brain] No prospects ready to research. Done.');
    return { drafted: 0 };
  }

  console.log(`[Brain] Processing ${prospects.length} prospects.`);

  const browser = await chromium.launch({ headless: true });
  let drafted = 0;

  try {
    for (const prospect of prospects) {
      try {
        await processProspect(prospect, client, profile, campaignId, browser);
        drafted++;
      } catch (err) {
        console.error(`[Brain] Failed on prospect ${prospect.id}: ${err.message}`);
        await logEvent(clientId, prospect.id, 'error', {
          step: 'brain.process_prospect',
          message: err.message,
        });
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`[Brain] Done. Drafted ${drafted} emails.`);
  return { drafted };
}


// ─── Core: process one prospect ───────────────────────────────────────────────

/**
 * Researches one prospect and writes their personalized email.
 */
async function processProspect(prospect, client, profile, campaignId, browser) {
  console.log(`[Brain] Researching: ${prospect.business_name}`);

  // Step 1: Fetch the prospect's website content
  const websiteContent = await fetchWebsiteText(browser, prospect.website);

  // Step 2: Ask Claude to research the business and write the email
  const { subject, body, tokens } = await writeEmail(
    prospect,
    client,
    profile,
    websiteContent
  );

  // Step 3: Save the draft email to Supabase
  const { error: emailErr } = await supabase.from('emails').insert({
    prospect_id: prospect.id,
    campaign_id: campaignId,
    step: 0,
    subject,
    body,
    status: 'draft',
    model_used: MODEL,
    prompt_tokens: tokens.input,
    completion_tokens: tokens.output,
  });

  if (emailErr) throw new Error(`DB insert failed: ${emailErr.message}`);

  // Step 4: Mark the prospect as researched
  await supabase
    .from('prospects')
    .update({ status: 'researched' })
    .eq('id', prospect.id);

  // Log the event
  await logEvent(client.id, prospect.id, 'email.drafted', {
    campaign_id: campaignId,
    tokens,
  });

  console.log(`[Brain] Email drafted for: ${prospect.business_name}`);
}


// ─── Claude API: write the email ─────────────────────────────────────────────

/**
 * Calls Claude API to research the prospect and write a personalized email.
 * Returns { subject, body, tokens }.
 */
async function writeEmail(prospect, client, profile, websiteContent) {
  const systemPrompt = buildSystemPrompt(profile);
  const userPrompt = buildUserPrompt(prospect, client, profile, websiteContent);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
    system: systemPrompt,
  });

  const rawText = response.content[0].text.trim();

  // Parse subject and body from Claude's structured response
  const subject = extractTag(rawText, 'subject');
  const body = extractTag(rawText, 'body');

  if (!subject || !body) {
    throw new Error(`Claude response missing subject or body:\n${rawText}`);
  }

  return {
    subject,
    body,
    tokens: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

/**
 * Builds the system prompt from the client's style profile.
 */
function buildSystemPrompt(profile) {
  return `You are an expert cold email copywriter specializing in B2B outreach to local service businesses.

Your writing style:
- Tone: ${profile.tone}
- Voice: ${profile.voice}
- Sentence length: ${profile.sentence_length}
- CTA style: ${profile.cta_style}
- Things to avoid: ${profile.avoid?.join(', ') || 'none'}

You write emails that feel personal, not like mass blasts. You reference specific details about the business.
You never use generic openers like "I hope this email finds you well."
You always write from the perspective of ${profile.sender_persona}.

Respond ONLY with this exact format — no other text:
<subject>Email subject line here</subject>
<body>
Full email body here, including sign-off.
</body>`;
}

/**
 * Builds the user prompt with prospect-specific details.
 */
function buildUserPrompt(prospect, client, profile, websiteContent) {
  const websiteSection = websiteContent
    ? `\n\nWebsite content (summarized):\n"""\n${websiteContent.slice(0, 2000)}\n"""`
    : '\n\n(No website content available.)';

  return `Write a cold outreach email to this local business:

Business name: ${prospect.business_name}
Owner name: ${prospect.owner_name || 'unknown'}
Niche: ${prospect.niche || client.target_niche}
Location: ${[prospect.city, prospect.state].filter(Boolean).join(', ') || 'US'}
Website: ${prospect.website || 'none'}
${websiteSection}

Campaign context:
- You are reaching out on behalf of: ${profile.sender_name} at ${profile.sender_company}
- The service being offered: ${profile.service_description}
- Target pain point to address: ${profile.pain_point}
- Desired CTA: ${profile.cta_text}

Write the email now.`;
}


// ─── Website Fetcher ──────────────────────────────────────────────────────────

/**
 * Fetches visible text content from a URL using Playwright.
 * Returns plain text (stripped of HTML/scripts).
 */
async function fetchWebsiteText(browser, url) {
  if (!url) return null;

  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Extract text from the body, stripping script/style tags
    const text = await page.evaluate(() => {
      const remove = document.querySelectorAll('script, style, nav, footer, header');
      remove.forEach((el) => el.remove());
      return document.body?.innerText?.replace(/\s+/g, ' ')?.trim() || '';
    });

    return text.slice(0, 5000); // Cap at 5000 chars to control token usage
  } catch (err) {
    console.warn(`[Brain] Failed to fetch website ${url}: ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}


// ─── Style Profile Loader ─────────────────────────────────────────────────────

/**
 * Loads a JSON style profile from /profiles/<name>.json.
 */
async function loadStyleProfile(profileName) {
  const profilePath = join(__dirname, '..', 'profiles', `${profileName}.json`);
  try {
    const raw = await readFile(profilePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`[Brain] Could not load profile "${profileName}": ${err.message}`);
  }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract content between XML-style tags from a string. */
function extractTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : null;
}

async function logEvent(clientId, prospectId, type, payload) {
  await supabase.from('events').insert({
    client_id: clientId,
    prospect_id: prospectId,
    type,
    payload,
    source: 'brain',
  });
}


// ─── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1].endsWith('brain.js')) {
  const clientId = process.env.CLIENT_ID;
  const campaignId = process.env.CAMPAIGN_ID;

  if (!clientId || !campaignId) {
    console.error('Usage: CLIENT_ID=<uuid> CAMPAIGN_ID=<uuid> node agents/brain.js');
    process.exit(1);
  }

  runBrain(clientId, campaignId)
    .then((result) => {
      console.log(`[Brain] Done. ${result.drafted} emails drafted.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Brain] Fatal:', err.message);
      process.exit(1);
    });
}
