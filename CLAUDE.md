# Superade — Agent Engine Instructions

## What This Is
Superade is an agentic outreach agency. Clients pay $499/$899/$1,495/mo for done-for-you cold email lead generation targeting US local service businesses. I am the sole operator. Clients never see the backend.

## Stack
- Saleshandy Pro ($69/mo) — sending via API, warmup, inbox rotation
- Claude API — prospect research + personalized email copywriting
- Playwright — live web scraping for prospect discovery
- Supabase — PostgreSQL database, auth, real-time webhooks
- Stripe — client billing + conversion detection

## Project Structure
All engine code lives in /engine. Do not touch /site (marketing website).

## Build Order
1. supabase-schema.sql — tables: clients, prospects, campaigns, emails, events
2. agents/scout.js — Playwright scraper
3. agents/brain.js — Claude API research + copywriting
4. agents/connector.js — Saleshandy API push
5. agents/watchdog.js — Stripe + reply webhook listener
6. api/stripe-webhook.js
7. api/saleshandy-webhook.js
8. scripts/reporter.js — monthly PDF generation
9. profiles/*.json — style profile templates

## Rules
- Build one file at a time. Finish and test before moving to next.
- Use .env for ALL API keys. Never hardcode secrets.
- Every agent reads from and writes to Supabase. Supabase is the spine.
- Keep each file under 300 lines. Split if longer.
- Use ESM imports (import/export), not CommonJS (require).
- Add clear comments explaining what each function does.
- Ask me before making architectural decisions not covered here.
- Do not refactor working code unless I ask.
- Do not build the operator dashboard yet.

## Client Tiers
- Starter ($499): 500 prospects/mo, 4 follow-ups each
- Growth ($899): 1,000 prospects/mo, 4 follow-ups each
- Scale ($1,495): 2,000 prospects/mo, 4 follow-ups each

## Agent Behaviors
- Scout: Crawls Google Maps, Yelp, industry directories for local businesses. Extracts name, email, phone, website, address. Writes to Supabase prospects table.
- Brain: Reads prospect from Supabase, fetches their website, uses Claude API to research and write a unique personalized email using the client's style profile JSON. Saves draft to Supabase.
- Connector: Reads approved emails from Supabase, pushes to Saleshandy via API, creates/updates campaigns.
- Watchdog: Listens for Stripe payment webhooks and Saleshandy reply webhooks. Marks prospects as converted/replied in Supabase. Stops further outreach to them.
