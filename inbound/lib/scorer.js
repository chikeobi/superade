/**
 * lib/scorer.js — DeepSeek API scoring for the discovery agent
 *
 * Exports:
 *   scoreOpportunity(params)        — scores one niche+city combo (0-100)
 *   suggestAdditionalCities(results, date) — expands beyond seed cities
 */

import 'dotenv/config';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';

async function callDeepSeek({ system, user, maxTokens = 600, json = true }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const body = { model: MODEL, max_tokens: maxTokens, messages };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ─── Scoring system prompt (cached) ──────────────────────────────────────────
// Must stay above 1024 tokens to qualify for Anthropic prompt caching.
// Do not trim this prompt — length is intentional.

const SCORING_SYSTEM_PROMPT = `You are an expert lead-generation opportunity analyst. Your job is to score niche + city combinations for a lead-gen website business.

BUSINESS MODEL:
We build local lead-generation websites that rank on Google for searches like "emergency plumber Houston TX" or "HVAC repair Phoenix AZ". When homeowners visit and submit a contact form, we sell those leads to local service businesses (vendors) who pay $30-$500 per lead depending on the niche. We need to identify the highest-ROI markets to enter first.

YOUR TASK:
Score the provided niche + city combination on a scale of 0-100 based on the four dimensions below. You will be given scraped data from Google SERP and Google Maps to inform your scoring. Use both the data and your general knowledge of the market, city, and niche to produce an accurate score.

════════════════════════════════════════════════════════════════
SCORING RUBRIC — 100 POINTS TOTAL
════════════════════════════════════════════════════════════════

1. DEMAND SIGNALS — 35 points maximum
─────────────────────────────────────
This dimension measures whether there is proven, high-value commercial demand for the niche in this city.

Points breakdown:
• Google Ads present for this query: +10 pts
  Rationale: Businesses bid on keywords only when the ROI is positive. If advertisers are spending money, it proves the traffic converts into paying customers. Absence of ads in a niche that should have them is a yellow flag.

• Google Map Pack (local results panel) appears: +5 pts
  Rationale: Google only shows the map pack when its algorithm detects high local intent and sufficient business supply. Map pack presence confirms this is a legitimate high-volume local query.

• Google Maps listing count (nearby businesses):
  - 20+ businesses: +10 pts (very active market)
  - 10–19 businesses: +7 pts (healthy market)
  - 5–9 businesses: +4 pts (moderate market)
  - 0–4 businesses: +1 pt (thin market, low demand signal)

• Niche average job ticket:
  - $5,000+: +10 pts (roofing, water damage, PI lawyer)
  - $1,000–$4,999: +8 pts (tree removal, HVAC)
  - $300–$999: +5 pts (emergency plumber, med spa, junk removal)
  - Under $300: +2 pts


2. COMPETITION SIGNALS — 30 points maximum
──────────────────────────────────────────
This dimension measures how open the organic search real estate is for a new lead-gen website. More open = easier to rank = faster ROI.

Points breakdown:
• Dedicated lead-gen sites in top 10 organic results:
  - 0 dedicated lead-gen sites: +15 pts (wide open)
  - 1 dedicated lead-gen site: +10 pts (beatable)
  - 2+ dedicated lead-gen sites: +5 pts (harder but not impossible)

  NOTE: "Dedicated lead-gen sites" means sites whose sole purpose is capturing and reselling leads in this niche — e.g., houstonplumber247.com, dallasdraincleaning.net. This does NOT include aggregators like Angi, HomeAdvisor, or Thumbtack (those are scored separately below).

• Aggregator presence in top 10 (Angi, HomeAdvisor, Thumbtack, Yelp, Bark, Porch, etc.):
  - 0–1 aggregators: +10 pts (thin competition from middlemen)
  - 2–3 aggregators: +7 pts (moderate competition, still beatable with local SEO)
  - 4+ aggregators: +3 pts (heavy aggregator presence, harder but aggregators signal high value)

  NOTE: Aggregator presence is a DUAL signal — they validate demand (worth points in demand), but they are competition. Adjust competition score accordingly. Aggregators CAN be beaten with strong local content and schema markup.

• Organic result quality (your assessment based on URL patterns):
  If most results are generic national chains or irrelevant pages with no local optimization, that's an opportunity gap. If results show well-optimized local sites, that's a tougher market.
  - Poor local optimization visible: +5 pts bonus
  - Average local optimization: +0 pts
  - Strong local optimization: -5 pts penalty


3. CITY VIABILITY — 20 points maximum
──────────────────────────────────────
This dimension measures whether the city has enough homeowners with enough money to generate consistent lead volume.

Points breakdown:
• Population of the city (NOT metro MSA — the city itself):
  - 2M+: +8 pts
  - 500k–2M: +7 pts
  - 200k–500k: +5 pts
  - 100k–200k: +3 pts
  - Under 100k: +1 pt

• Growth rate:
  - Very high (5%+ annual growth): +6 pts
  - High (2–5% annual growth): +5 pts
  - Moderate (0–2% growth): +3 pts
  - Flat or declining: +0 pts

• Income and homeownership:
  - High income, high homeownership: +6 pts
  - Moderate income, moderate homeownership: +3 pts
  - Low income or mostly renters: +0 pts

  NOTE: For niches like Med Spa or Personal Injury Lawyer, income level matters more. For plumbing and HVAC, homeownership matters more than income.


4. SEASONAL RELEVANCE — 15 points maximum
──────────────────────────────────────────
This dimension measures whether THIS IS THE RIGHT TIME to build and rank a site for this niche in this city. A site that ranks during peak season generates immediate ROI.

Points breakdown:
• Current month vs. niche peak months AND city climate:
  - Active peak season RIGHT NOW: +15 pts (build immediately — traffic coming in)
  - Approaching peak within 60 days: +12 pts (build now, rank by peak)
  - Approaching peak within 90 days: +9 pts (good lead time to rank)
  - Off-peak but niche has year-round demand: +5 pts
  - Deep off-season for this niche in this climate: +2 pts

CRITICAL CLIMATE ADJUSTMENTS:
• Phoenix AZ: HVAC peak is extreme — 115°F summer heat. Winter "peak" for heating is minor (50°F low). Weight summer heavily.
• Miami FL / Houston TX: No real winter freeze. Emergency plumber "winter peak" applies minimally here. Hurricane/flood season (June-October) dominates water damage and roofing.
• Chicago IL / New York NY: Real winters — emergency plumber and HVAC winter peaks matter fully.
• Austin TX: Bi-modal HVAC — hot summers AND real freeze risk (2021 freeze showed this).
• Charlotte NC: Mix of real seasons — all seasonal signals apply at moderate weight.

════════════════════════════════════════════════════════════════
OUTPUT FORMAT — JSON ONLY
════════════════════════════════════════════════════════════════

Respond ONLY with valid JSON. No prose before or after. No markdown code fences.

{
  "score": <integer 0-100, sum of all four breakdown values>,
  "breakdown": {
    "demand": <integer 0-35>,
    "competition": <integer 0-30>,
    "viability": <integer 0-20>,
    "seasonal": <integer 0-15>
  },
  "rationale": "<2-3 sentences explaining the score, citing the most important factors that drove it up or down>",
  "green_flags": ["<specific positive signal>", "..."],
  "red_flags": ["<specific risk or concern>", "..."]
}

Verify: score must equal breakdown.demand + breakdown.competition + breakdown.viability + breakdown.seasonal.`;


// ─── Score one opportunity ────────────────────────────────────────────────────

/** Calls Claude to score one niche+city opportunity. Returns { score, breakdown, rationale, greenFlags, redFlags }. */
export async function scoreOpportunity({ niche, city, state, serpData, mapsData, nicheConfig, cityConfig, currentDate }) {
  const currentMonth = new Date(currentDate).getMonth() + 1;

  const userMessage = `Score this lead-gen opportunity:

NICHE: ${niche}
CITY: ${city}, ${state}
TODAY'S DATE: ${currentDate} (current month: ${currentMonth})

NICHE DETAILS:
- Average job ticket: $${nicheConfig.avg_ticket_usd.toLocaleString()}
- Seasonal peak months: [${nicheConfig.seasonal_peaks.join(', ')}]
- Off-peak months: [${(nicheConfig.off_peak_months || []).join(', ')}]
- Seasonal notes: ${nicheConfig.seasonal_notes}

CITY DETAILS:
- Estimated population: ${cityConfig.estimated_population?.toLocaleString() || 'unknown'}
- Climate zone: ${cityConfig.climate_zone || 'unknown'}
- Growth rate: ${cityConfig.growth_rate || 'unknown'}
- Income level: ${cityConfig.income_level || 'unknown'}
- Context: ${cityConfig.notes || 'none'}

SCRAPED SIGNALS:
Google SERP ("${niche} ${city} ${state}"):
- Google Ads present: ${serpData.hasAds}
- Local Map Pack present: ${serpData.hasMapPack}
- Known aggregators in top 10: ${serpData.aggregatorCount} (Angi, HomeAdvisor, Thumbtack, etc.)
- Dedicated lead-gen sites in top 10: ${serpData.leadGenCount}
- Organic URLs found: ${serpData.organicUrls.length > 0 ? serpData.organicUrls.join(', ') : 'none scraped'}

Google Maps ("${niche} near ${city}, ${state}"):
- Visible business listings: ${mapsData.listingCount}
- Average rating of visible listings: ${mapsData.avgRating !== null ? mapsData.avgRating : 'not captured'}

Score this opportunity now.`;

  try {
    const raw = await callDeepSeek({ system: SCORING_SYSTEM_PROMPT, user: userMessage, maxTokens: 600 });
    const parsed = JSON.parse(raw);

    return {
      score:      parsed.score,
      breakdown:  parsed.breakdown,
      rationale:  parsed.rationale,
      greenFlags: parsed.green_flags || [],
      redFlags:   parsed.red_flags  || [],
    };
  } catch (err) {
    console.error(`[Scorer] Failed for ${niche} — ${city}: ${err.message}`);
    return { score: null, breakdown: null, rationale: `Scoring failed: ${err.message}`, greenFlags: [], redFlags: [] };
  }
}


// ─── Dynamic city expansion ───────────────────────────────────────────────────

/** After scoring seed combos, asks Claude for additional high-opportunity cities. Returns array of city objects. */
export async function suggestAdditionalCities(scoredResults, currentDate) {
  const cityAverages = {};
  for (const r of scoredResults) {
    if (r.score === null) continue;
    const key = `${r.city}, ${r.state}`;
    if (!cityAverages[key]) cityAverages[key] = { scores: [], state: r.state };
    cityAverages[key].scores.push(r.score);
  }

  const citySummary = Object.entries(cityAverages)
    .map(([key, v]) => {
      const avg = Math.round(v.scores.reduce((a, b) => a + b, 0) / v.scores.length);
      return `${key}: avg score ${avg}/100`;
    })
    .sort((a, b) => {
      const scoreA = parseInt(a.match(/(\d+)\/100/)[1]);
      const scoreB = parseInt(b.match(/(\d+)\/100/)[1]);
      return scoreB - scoreA;
    })
    .join('\n');

  const prompt = `You are helping expand a lead-generation website business into new US cities.

We have scored the following seed cities for lead-gen opportunity (higher = better):
${citySummary}

Today's date: ${currentDate}

Based on these results, suggest 8 additional US cities we have NOT yet scored that would likely score well.
Focus on:
1. Large or fast-growing cities in states that are already performing well
2. Mid-size metros (200k-800k population) that are underserved by existing lead-gen sites
3. Cities with the right climate for our highest-scoring niches (HVAC, water damage, emergency plumber, roofing)
4. Avoid cities already in our seed list: Houston TX, Dallas TX, Austin TX, Miami FL, Atlanta GA, Phoenix AZ, Chicago IL, Los Angeles CA, New York NY, Charlotte NC

Respond ONLY with valid JSON. No prose before or after.

{
  "cities": [
    {
      "city": "<city name>",
      "state": "<2-letter state code>",
      "estimated_population": <integer>,
      "climate_zone": "<brief description>",
      "growth_rate": "<very high|high|moderate|flat>",
      "income_level": "<high|moderate-high|moderate|low>",
      "reason": "<1-2 sentence explanation of why this city was selected>"
    }
  ]
}`;

  try {
    const raw = await callDeepSeek({ user: prompt, maxTokens: 1500 });
    const parsed = JSON.parse(raw);
    return parsed.cities || [];
  } catch (err) {
    console.error(`[Scorer] City expansion failed: ${err.message}`);
    return [];
  }
}
