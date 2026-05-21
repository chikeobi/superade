# Superade — Operational Reference

**Last updated:** 2026-05-21  
**Author:** Internal — operator only

---

## Overview

Superade has two independent revenue systems running on the same VPS:

| System | What it does | Revenue model |
|--------|-------------|---------------|
| **Outbound** | Sends personalized cold emails on behalf of clients to local service businesses | $499–$1,495/mo recurring client subscriptions |
| **Inbound** | Builds static lead-gen websites that rank on Google; sells the leads those sites generate to local vendors | $30–$500/lead or monthly retainer per vendor |

Both run at `api.suparade.com`. Nginx routes `/admin/inbound`, `/leads`, `/sites` → port 3001 (inbound); everything else → port 3000 (outbound). PM2 manages both: `superade` (outbound) and `suparade-inbound` (inbound).

Admin dashboard: **https://api.suparade.com/admin** — shared login via HMAC cookie, valid across both ports.

---

## OUTBOUND SYSTEM

### What it is

Clients pay a monthly fee for done-for-you cold email prospecting. The system finds businesses in the client's target niche and geography, researches each one, writes a personalized email using the client's style profile, and sends it through Instantly's infrastructure. Replies, bounces, and conversions are tracked automatically.

### How a client enters the system

1. **Stripe checkout** — client pays on suparade.com. Stripe fires a `checkout.session.completed` webhook to `POST /webhooks/stripe`.
2. **Watchdog provisions the client** — `handleStripeEvent()` in `watchdog.js` extracts the customer email from the event and inserts a row into the `clients` table with `tier: 'starter'` and `billing_status: 'active'`.
3. **Client completes onboarding** — directed to `https://api.suparade.com/onboarding`. Two-step form: (1) name + email, (2) target niches (up to 12 options) + target states or ZIP codes with radius. On submit, the form upserts `target_niche`, `target_states`, and `target_cities` into the client's row.
4. **Operator sets tier** — if the client paid for Growth or Scale, manually update `tier` and `monthly_quota` in the admin dashboard (`/admin` → client row → Edit). Starter = 500 prospects/mo, Growth = 1,000, Scale = 2,000.
5. **Operator assigns style profile** — each client needs a JSON file at `engine/profiles/<client-slug>.json` that defines tone, voice, and email formatting preferences. Set `style_profile` on the client row to the profile filename.

### The outbound pipeline (Scout → Brain → Connector)

The pipeline runs in sequence. Each step reads from and writes to Supabase.

#### Step 1 — Scout (`engine/agents/scout.js`)

Scout finds prospects. It runs two sources: **Google Maps** and **Yelp**. For each, it:

- Opens a Playwright Chromium browser (headless on VPS).
- Searches for the client's target niche + each target state/city.
- Scrapes business name, address, phone, and website URL from listing cards.
- For each business with a website, visits the site and extracts any email addresses from the page HTML.
- Writes results to the `prospects` table, deduplicating on `email` (unique constraint — duplicate inserts are silently skipped).
- Target: 50 prospects per source, per search query.

Scout runs once per pipeline invocation. It does not send anything.

#### Step 2 — Brain (`engine/agents/brain.js`)

Brain researches and writes emails. For each unprocessed prospect (status `discovered`):

1. Loads the prospect row from Supabase.
2. Loads the client's style profile JSON from `engine/profiles/`.
3. Opens the business website with Playwright. Captures the first 5,000 characters of page text.
4. Calls **Claude claude-opus-4-7** (Anthropic API) with a prompt that includes the prospect's name, niche, website text, and the client's style profile. The prompt requests a structured XML response with `<subject>` and `<body>` tags.
5. Parses the XML response and saves the email draft to the `emails` table with `status: 'draft'`.

Brain processes in batches of 20. It does not send anything.

#### Step 3 — Connector (`engine/agents/connector.js`)

Connector pushes approved emails into Instantly for sending. For each draft email:

1. Finds or creates an **Instantly campaign** for this client + month (one campaign per client per calendar month). Campaign template uses `{{subject}}` and `{{body}}` custom variables per lead.
2. Enforces `daily_send_limit` — if the campaign has already hit its daily cap, Connector waits.
3. Adds the prospect as a lead to the Instantly campaign with the personalized subject and body injected as custom variables.
4. Marks the email `status: 'sent'` in Supabase.
5. Calls the `increment_prospects_sent` RPC to track quota usage.

Connector processes in batches of 50.

### Automatic scheduling

`engine/lib/scheduler.js` runs a cron job every hour (`0 * * * *`). For each client with `schedule_active: true`, it fires `startPipeline(clientId, { autoApprove: true, scheduled: true })`. This runs Scout → Brain → Connector without manual intervention. The job runner (`engine/lib/job-runner.js`) tracks per-client pipeline state in memory and prevents concurrent runs for the same client.

### Watchdog — reply and billing monitoring

`engine/agents/watchdog.js` does two things:

**1. Stripe webhook handler (`handleStripeEvent`)**  
Processes three events:
- `checkout.session.completed` → create client row
- `invoice.payment_succeeded` → set `billing_status: 'active'`
- `customer.subscription.deleted` / `invoice.payment_failed` → set `billing_status: 'cancelled'` or `'past_due'`, set `is_paused: true` to halt prospecting

**2. Instantly poller (`startInstantlyPoller`)**  
Runs every 2 hours (`0 */2 * * *`). Polls Instantly API for:
- **Replies** → marks prospect `status: 'replied'`, stops further outreach to that email
- **Bounces** → marks `status: 'bounced'`, blocks the email address in Instantly
- **Unsubscribes** → marks `status: 'unsubscribed'`, blocks in Instantly

Uses `events` table to track last poll timestamp for deduplication.

### Monthly reports

`engine/scripts/reporter.js` generates a PDF for each active client using **pdf-lib** (US Letter format). Includes:
- KPI summary boxes: prospects found, emails sent, reply count, reply rate, conversions
- Campaign breakdown table (one row per month)

Output: `/engine/reports/<client-slug>-YYYY-MM.pdf`. Run manually or trigger via the admin dashboard.

### Operator controls (admin dashboard — `/admin`)

- **Client list** — overview of all clients with tier, prospects sent this month, reply rate, billing status.
- **Client detail** — edit tier, quota, style profile, target geography; pause/resume pipeline; view email log.
- **Add client manually** — for cases where Stripe doesn't fire or client was added outside normal flow.
- **Agent controls** — toggle Scout, Brain, Connector, Reporter on/off; Run Now; set schedule (interval or daily time); see last run time and status. Watchdog is marked Always On (runs as part of the server process).

---

## INBOUND SYSTEM

### What it is

The inbound system builds static single-page websites that rank on Google for local service searches ("emergency plumber Houston TX"). When a homeowner visits and submits the contact form, the lead is captured, routed to a paying vendor (a local service business), and revenue is recorded. Vendors pay either per lead ($30–$500) or a monthly retainer.

### Niches covered

Emergency Plumber, HVAC, Water Damage Restoration, Tree Removal, Junk Removal, Roofing, Med Spa, Personal Injury Lawyer.

### Seed cities

Houston TX, Dallas TX, Austin TX, Miami FL, Atlanta GA, Phoenix AZ, Chicago IL, Los Angeles CA, New York NY, Charlotte NC. Configured in `inbound/config/niches-cities.json`. After scoring seed combos, Discovery also asks DeepSeek to suggest 8 additional cities.

### Mode control

The system has four operating modes set in the `inbound_mode` table (row id=1):

| Mode | What happens |
|------|-------------|
| `discovery_only` | Discovery scores opportunities. Nothing gets built. |
| `controlled_build` | Sites are built only after manual operator approval. |
| `semi_auto` | Sites are auto-built for opportunities scoring above the threshold. |
| `full_auto` | Fully autonomous — score, build, go live without any manual step. |

Change mode at `/admin/inbound` → Mode Control. Also set the **score threshold** (default 75) used by semi_auto and full_auto.

### Discovery agent (`inbound/agents/discovery.js`)

Runs regardless of mode — always safe to run. Two phases:

**Phase 1 — Seed scoring**  
For every niche × seed city combination (8 niches × 10 cities = 80 combos):
1. `scraper.js` opens a Playwright browser and scrapes Google SERP for the query `"<niche> <city> <state>"`: detects Google Ads, Map Pack presence, organic URLs, aggregator count, lead-gen site count.
2. Same browser scrapes Google Maps for `"<niche> near <city>, <state>"`: counts visible business listing cards, averages their star ratings.
3. `scorer.js` calls **DeepSeek** (`deepseek-chat`) with the scraped signals + niche metadata + city metadata and the 4-dimension scoring rubric (demand 35pts / competition 30pts / viability 20pts / seasonal 15pts = 100pts max).
4. Result is upserted to the `opportunities` table. Existing records with `status: 'approved'` or `'rejected'` keep their status — rescoring never resets a decision. Combos scored within the last 30 days are skipped.

4-second delay between each combo to avoid Google rate limiting.

**Phase 2 — City expansion**  
After all seed combos are scored, sends the scored results to DeepSeek and asks it to suggest 8 additional cities that would likely score well. Scores all niches for those cities too.

### Reviewing and approving opportunities (`/admin/inbound/opportunities`)

Every scored combo appears in the Opportunities table with: score, breakdown (D/C/V/S), SERP signals (Ads ✓, Map ✓), Maps listing count, and scored date.

- **Approve** → sets `status: 'approved'`. Site Factory will pick it up next run.
- **Reject** → sets `status: 'rejected'`. Won't be built.
- In `semi_auto` or `full_auto` mode, approvals can happen automatically based on the score threshold.

### Site Factory (`inbound/agents/site-factory.js`)

Blocked in `discovery_only` mode. For each approved opportunity with no site linked:

1. Generates a slug: `<niche>-<city>-<state>` (lowercased, spaces → hyphens).
2. Calls **DeepSeek** (`site-content.js`) with the full `SYSTEM_PROMPT` (copywriting instructions) and the opportunity details (niche, city, state, date, SERP signals). Returns structured JSON: headline, meta description, subheadline, tagline, trust signals, 4–6 services with descriptions, about paragraph, 4–5 FAQs, CTA text, form headline, thank you page text, schema type, footer tagline.
3. `html-builder.js` renders the content into a full static HTML page and writes it to `inbound/sites/<slug>/index.html` (and a thank-you page).
4. Inserts a row into `generated_sites` with `status: 'live'` and the full content JSON.
5. Updates the opportunity: `status: 'live'`, `site_id: <new site id>`.

3-second delay between each site build (to pace DeepSeek calls).

### Traffic agent (`inbound/agents/traffic.js`)

Run after sites are built to submit them to search engines. For each live site:

1. Writes a `sitemap.xml` to the site directory listing the site's public URL.
2. Pings Google (`/ping?sitemap=...`) and Bing (`/ping?sitemap=...`) with the sitemap URL.
3. Prints step-by-step **Google Business Profile setup instructions** to the console. GBP requires phone/postcard verification and cannot be automated — must be done manually per site.

### Optimizer (`inbound/agents/optimizer.js`)

Analyzes all live sites. Produces a report saved to `inbound_mode.last_optimizer_report`:

- **Stale sites** — live for 30+ days with zero leads → flagged for rebuild or investigation.
- **Niche rankings** — sorted by leads/site. Top niche is highlighted for city expansion.
- **City rankings** — sorted by leads/site. Top city is highlighted for niche expansion.
- **Recommendations** — high/medium/low priority action items based on the above.

No changes are made to any site. It is a read-only diagnostic.

### Lead capture

When a visitor submits the form on a live site, the POST goes to the inbound server's `/leads` endpoint. The lead is written to `inbound_leads` with `status: 'new'`, linked to the site via `site_id`.

### Lead routing (`/admin/inbound/leads`)

Leads appear in the Leads admin table. For each new lead, the operator selects an active vendor from a dropdown and clicks Route. This:

1. Sets `status: 'routed'`, records `vendor_id` and `routed_at`, and sets `revenue` to the vendor's `lead_price`.
2. Sends a **vendor email alert** via Resend containing the lead's name, phone, email, and service request.
3. Sends an **operator alert** via Resend confirming the routing.

### Vendors (`/admin/inbound/vendors`)

Each vendor has:
- **Niche + city/state** — defines which leads they receive.
- **Acquisition mode** — `pay_per_lead` (charged per lead routed), `build_first` (site built before pitching), or `sell_first` (pitch vendor before building).
- **Billing** — either `monthly_retainer` (fixed $/mo) or `lead_price` ($/lead). Retainer vendors can have Stripe invoices created from the admin. Pay-per-lead vendors can be converted to retainer using the "Convert to Retainer" button on the vendor detail page.
- **Billing history** — `vendor_billing` table tracks every invoice with type, amount, status, and Stripe invoice ID.

---

## HOW THE TWO SYSTEMS WORK TOGETHER

The systems are architecturally independent but share the same commercial universe.

**Inbound vendors are the outbound client's target market.** Local service businesses (plumbers, HVAC, roofers) are exactly the businesses the outbound system targets for lead-gen pitches. The logical flow:

1. **Outbound Scout** finds plumbers, HVAC companies, and roofers in target cities.
2. **Outbound Brain** writes a cold email pitching them on Superade's inbound lead service.
3. A business replies and becomes a vendor prospect.
4. **Inbound builds a site** in their niche + city. Leads start coming in.
5. **The vendor pays** per lead or converts to a retainer.

This makes the outbound pipeline a vendor acquisition channel for the inbound system, not just a general B2B tool.

**Shared infrastructure:**  
- Same VPS, same `.env` file (inbound `.env` is a symlink to the engine `.env`).
- Same Supabase project — only the tables differ (outbound: `clients`, `prospects`, `campaigns`, `emails`, `events`; inbound: `opportunities`, `generated_sites`, `inbound_leads`, `vendors`, `vendor_billing`, `inbound_mode`).
- Same admin login cookie — session valid across both ports.
- Same Stripe account — client subscriptions (outbound) and vendor invoices (inbound) both use `STRIPE_SECRET_KEY`.

---

## TOOLS REFERENCE

| Tool / Service | Used by | Purpose |
|---------------|---------|---------|
| **Supabase** | Everything | PostgreSQL database — every agent reads/writes here. The system's spine. |
| **Playwright** | Scout (outbound), Brain (outbound), Discovery scraper (inbound) | Headless Chromium. Outbound: scrape business listings + fetch prospect websites. Inbound: scrape Google SERP + Google Maps for scoring signals. |
| **Claude API** (`claude-opus-4-7`) | Brain (`engine/agents/brain.js`) only | Personalized cold email writing. Uses client style profiles. |
| **DeepSeek API** (`deepseek-chat`) | Inbound scorer (`lib/scorer.js`), inbound site content (`lib/site-content.js`) | Opportunity scoring (0–100 across 4 dimensions) + full site copy generation (headline, services, FAQ, etc.). |
| **Instantly API v2** | Connector (push leads), Watchdog (poll replies/bounces) | Cold email sending infrastructure. One campaign per client per month. Tracks replies, bounces, unsubscribes. |
| **Stripe** | Watchdog (webhook handler), Vendors admin (invoice creation) | Client subscription billing + vendor invoice creation. Webhooks at `POST /webhooks/stripe`. |
| **Resend** | `inbound/lib/mailer.js` | Transactional email. Two templates: operator lead alert + vendor lead alert. |
| **PM2** | VPS process management | Keeps both servers alive. `superade` (port 3000), `suparade-inbound` (port 3001). Restart with `pm2 restart --update-env` after `.env` changes. |
| **Nginx** | VPS reverse proxy | TLS termination at `api.suparade.com`. Routes by path prefix to port 3000 or 3001. |
| **pdf-lib** | `engine/scripts/reporter.js` | Generates monthly PDF reports for outbound clients. |
| **node-cron** | `engine/lib/scheduler.js` (hourly), `engine/agents/watchdog.js` (2h) | Scheduled jobs — auto-run client pipelines and poll Instantly. |
| **agent_states table** | Both admin dashboards | Persists on/off toggle, schedule, last run time, last run status for all agents. Scheduler reads this before firing. |

---

## DEPLOYMENT REFERENCE

**VPS:** `root@187.77.192.9` — connect with `ssh -i ~/.ssh/superade_deploy root@187.77.192.9`

**File locations:**
- Outbound: `/root/superade/engine/`
- Inbound: `/root/superade/inbound/`
- Shared .env: `/root/superade/engine/.env` (inbound symlinks here)

**Deploy changes:**
```bash
# From local machine — deploy outbound
rsync -avz --exclude node_modules -e "ssh -i ~/.ssh/superade_deploy" \
  /Users/chike/Superade-agent/engine/ root@187.77.192.9:/root/superade/engine/

# Deploy inbound
rsync -avz --exclude node_modules -e "ssh -i ~/.ssh/superade_deploy" \
  /Users/chike/Superade-agent/inbound/ root@187.77.192.9:/root/superade/inbound/

# Restart both processes
ssh -i ~/.ssh/superade_deploy root@187.77.192.9 "pm2 restart all --update-env"
```

**Key .env vars:**
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY          — Brain only
DEEPSEEK_API_KEY           — Inbound scorer + site-content
INSTANTLY_API_KEY          — Connector + Watchdog
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
RESEND_API_KEY, OPERATOR_EMAIL, INBOUND_FROM_EMAIL
ADMIN_PASSWORD             — shared admin session cookie
SITE_BASE_URL              — public URL for inbound sites (e.g. https://api.suparade.com)
```

**Health check:** `GET https://api.suparade.com/health` → `{ "status": "ok" }`

---

## STANDARD OPERATING PROCEDURES

### Launch a new outbound client
1. Client pays via Stripe → system auto-creates client row (starter tier).
2. Client completes onboarding form at `/onboarding`.
3. Create style profile JSON in `engine/profiles/`.
4. Update `style_profile` + `tier` + `monthly_quota` in `/admin` → client → Edit.
5. Set `schedule_active: true` if client should run on the hourly cron; otherwise trigger manually via "Run Now" in agent controls.

### Add a new inbound vendor
1. Go to `/admin/inbound/vendors` → Add Vendor.
2. Fill niche, city, state, acquisition mode, billing model (retainer $/mo or lead price $/lead).
3. Set `billing_status: active` when the vendor has agreed to pay.
4. If they have a Stripe account, add their `stripe_customer_id` so invoices can be created from the admin.

### Build a new inbound site
1. Run Discovery (agent controls → Discovery → Run Now). Wait for scores.
2. Review `/admin/inbound/opportunities`. Approve combos worth building.
3. Set mode to `controlled_build` (or higher). Run Site Factory → Run Now.
4. Run Traffic → Run Now to submit sitemaps.
5. Manually create GBP listing for the site (console instructions printed by Traffic agent).

### Respond to a new lead
1. New leads appear at `/admin/inbound/leads` with status `new`.
2. Select the matching vendor from the dropdown → Route.
3. System emails the lead to the vendor and sends you (operator) an alert.
4. If no vendor exists for that niche/city, go to Vendors → Add Vendor first.
5. If it's a pay-per-lead vendor, create an invoice from the vendor detail page after routing.
