/**
 * lib/site-content.js — DeepSeek API content generation for lead-gen sites
 *
 * Exports:
 *   generateSiteContent(opportunity) → structured content JSON for html-builder
 */

import 'dotenv/config';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

// ─── System prompt (cached across all site builds in a run) ──────────────────

const SYSTEM_PROMPT = `You are an expert copywriter for local lead-generation websites. Your job is to write conversion-optimized content for single-page websites that rank on Google for local service searches and capture leads from homeowners.

BUSINESS CONTEXT:
These sites appear for searches like "emergency plumber Houston TX" or "HVAC repair Phoenix AZ". A visitor lands because they need a service urgently. Your content must immediately convince them to submit a contact form. The site collects their name, phone, email, and service description, then connects them with a local service provider.

WRITING PRINCIPLES:
- Headline: Direct, benefit-focused, includes the city name. Not clever. Not cute. Clear.
- Trust signals: 4 short phrases (3-5 words each). Focus on licensing, speed, availability, local expertise.
- Services: 4-6 specific services for this niche. Each service gets a 1-sentence description.
- About paragraph: 2-3 sentences. Local focus. Establish trust. Include city name.
- FAQ: 4-5 questions. Real questions a customer would ask before submitting. Short, helpful answers.
- CTA text: Action verb + clear benefit. E.g. "Get a Free Quote Now" or "Connect With a Local Pro".
- Form headline: One line that frames the form as a help, not a trap. E.g. "Tell us what you need — we'll find you a pro."
- Thank you page: Warm, sets expectations. Tell them what happens next.
- Tone: Professional but approachable. Competent. Locally rooted.
- Never use the words "best", "top-rated", "premier", "world-class", or "industry-leading".
- Always include the city name naturally in the headline and about paragraph.

SEASONAL AWARENESS:
Adjust the copy emphasis for the time of year you are told. Summer HVAC sites should emphasize AC failure and heat urgency. Winter plumber sites should reference frozen pipes. Pre-summer med spa sites should mention summer prep. Match the urgency to the current season.

OUTPUT FORMAT:
Respond ONLY with valid JSON. No prose before or after. No markdown code fences.

{
  "headline": "<h1 text — includes niche + city, 8-12 words>",
  "metaDescription": "<SEO meta description — 150-160 chars, includes niche + city, with CTA>",
  "subheadline": "<hero subheadline — benefit + differentiator, 10-16 words>",
  "tagline": "<3-5 word trust tagline shown below hero CTA>",
  "trust_signals": ["<3-5 word phrase>", "<phrase>", "<phrase>", "<phrase>"],
  "services": [
    {"name": "<service name>", "description": "<1-sentence description>"},
    {"name": "<service name>", "description": "<1-sentence description>"},
    {"name": "<service name>", "description": "<1-sentence description>"},
    {"name": "<service name>", "description": "<1-sentence description>"}
  ],
  "about_paragraph": "<2-3 sentences. Local focus. Trust. City name included.>",
  "faq": [
    {"question": "<customer question>", "answer": "<short helpful answer, 1-3 sentences>"},
    {"question": "<question>", "answer": "<answer>"},
    {"question": "<question>", "answer": "<answer>"},
    {"question": "<question>", "answer": "<answer>"}
  ],
  "cta_text": "<4-7 word CTA button text>",
  "form_headline": "<1-line form section headline>",
  "thank_you_headline": "<thank you page h1>",
  "thank_you_body": "<1-2 sentences about what happens next>",
  "schema_service_type": "<schema.org service type, e.g. Plumber, HVACBusiness, LegalService>",
  "footer_tagline": "<1 sentence. Local focus. Reinforces trust.>"
}`;


// ─── Generate content for one opportunity ─────────────────────────────────────

/**
 * Calls Claude to generate structured site content for a lead-gen page.
 * @param {object} opp — row from the opportunities table
 * @returns {object} — parsed JSON content for html-builder
 */
export async function generateSiteContent(opp) {
  const currentDate = new Date().toISOString().slice(0, 10);
  const currentMonth = new Date().getMonth() + 1;

  const userMessage = `Generate lead-gen website content for this opportunity:

Niche: ${opp.niche}
City: ${opp.city}, ${opp.state}
Today's date: ${currentDate} (month ${currentMonth} of 12)

Additional context from our scoring:
- Google Ads active for this query: ${opp.serp_has_ads ?? 'unknown'}
- Google Maps listing count: ${opp.maps_listing_count ?? 'unknown'}
- Score breakdown: ${JSON.stringify(opp.score_breakdown || {})}

Generate the complete site content JSON now.`;

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';

  try {
    return JSON.parse(raw);
  } catch {
    // Strip any ``` fences if model ignores json_object mode
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`DeepSeek returned non-JSON: ${raw.slice(0, 200)}`);
  }
}
