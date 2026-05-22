-- ============================================================
-- Superade Database Schema
-- Run this in your Supabase SQL editor to initialize the DB.
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";


-- ============================================================
-- CLIENTS
-- One row per paying Superade client.
-- ============================================================
create table clients (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Identity
  name            text not null,
  email           text not null unique,
  company         text,

  -- Billing
  stripe_customer_id  text unique,
  stripe_subscription_id text unique,
  tier            text not null check (tier in ('starter', 'growth', 'scale')),
  -- starter = 500 prospects/mo | growth = 1000 | scale = 2000
  billing_status  text not null default 'active'
                    check (billing_status in ('active', 'past_due', 'cancelled')),

  -- Outreach config
  style_profile   text not null default 'example',
  -- References a file in /profiles/*.json by name (without .json)
  target_niche    text[],       -- e.g. ARRAY['HVAC','plumbing','landscaping']
  target_states   text[],       -- e.g. ARRAY['TX','FL','GA']
  target_cities   jsonb,        -- e.g. [{"zip":"77002","miles":25}] — overrides state targeting when set
  monthly_quota   int not null default 500,
  prospects_sent_this_month int not null default 0,
  quota_reset_at  timestamptz,

  -- Send limits
  daily_send_limit int not null default 100,
  -- Max emails Connector will push per day for this client

  -- Automated scheduler
  schedule_start_date  date,
  -- First day to run the Scout→Brain→Connector pipeline
  schedule_days        int,
  -- How many consecutive days to run
  schedule_run_hour    int not null default 8,
  -- Local hour (0-23) at which the scheduler fires
  schedule_timezone    text not null default 'America/New_York',
  -- IANA timezone string, e.g. "America/Los_Angeles"
  schedule_active      boolean not null default false,
  -- Must be true for the scheduler to fire

  -- Flags
  is_paused       boolean not null default false,
  is_internal     boolean not null default false
  -- is_internal = true for accounts created via admin dashboard (no Stripe)
);

-- ── Run these ALTER TABLE statements in Supabase SQL editor if the table
-- ── already exists (schema was created before this revision):
--
-- ALTER TABLE clients ADD COLUMN daily_send_limit int NOT NULL DEFAULT 100;
-- ALTER TABLE clients ADD COLUMN schedule_start_date date;
-- ALTER TABLE clients ADD COLUMN schedule_days int;
-- ALTER TABLE clients ADD COLUMN schedule_run_hour int NOT NULL DEFAULT 8;
-- ALTER TABLE clients ADD COLUMN schedule_timezone text NOT NULL DEFAULT 'America/New_York';
-- ALTER TABLE clients ADD COLUMN schedule_active boolean NOT NULL DEFAULT false;
-- ALTER TABLE clients ADD COLUMN target_cities jsonb;


-- ============================================================
-- PROSPECTS
-- Every local business contact discovered by Scout.
-- ============================================================
create table prospects (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Client this prospect was sourced for
  client_id       uuid not null references clients(id) on delete cascade,

  -- Business info (scraped)
  business_name   text not null,
  owner_name      text,
  email           text,
  phone           text,
  website         text,
  address         text,
  city            text,
  state           text,
  zip             text,
  niche           text,         -- e.g. "plumbing"
  source          text,         -- e.g. "google_maps", "yelp", "yellowpages"
  source_url      text,         -- original listing URL

  -- Outreach state machine
  status          text not null default 'discovered'
                    check (status in (
                      'discovered',   -- scraped, not yet researched
                      'researched',   -- Brain has run, email drafted
                      'approved',     -- operator approved the draft
                      'queued',       -- pushed to Instantly
                      'sent',         -- first email delivered
                      'replied',      -- positive reply received
                      'converted',    -- Stripe payment detected
                      'bounced',      -- hard bounce from Instantly
                      'unsubscribed', -- unsubscribe request
                      'skipped'       -- operator manually skipped
                    )),

  -- Deduplication
  email_hash      text generated always as (md5(lower(trim(coalesce(email, ''))))) stored,

  constraint prospects_unique_email_per_client unique (client_id, email_hash)
);

create index prospects_client_status on prospects(client_id, status);
create index prospects_email_hash on prospects(email_hash);


-- ============================================================
-- CAMPAIGNS
-- A campaign groups prospects for one client in one month.
-- Maps 1-to-1 with an Instantly campaign.
-- ============================================================
create table campaigns (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  client_id       uuid not null references clients(id) on delete cascade,
  name            text not null,            -- e.g. "Acme HVAC – Apr 2025"
  month           text not null,            -- e.g. "2025-04"
  saleshandy_campaign_id text,              -- ID from Instantly API (column name kept for backwards compat)
  status          text not null default 'building'
                    check (status in ('building', 'active', 'paused', 'completed')),
  follow_up_count int not null default 4    -- number of follow-up steps
);

create index campaigns_client on campaigns(client_id);


-- ============================================================
-- EMAILS
-- Every email draft Brain writes. One per prospect per sequence step.
-- step 0 = initial outreach, steps 1–4 = follow-ups.
-- ============================================================
create table emails (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  prospect_id     uuid not null references prospects(id) on delete cascade,
  campaign_id     uuid not null references campaigns(id) on delete cascade,
  step            int not null default 0,   -- 0=initial, 1-4=follow-ups

  subject         text not null,
  body            text not null,

  -- Approval workflow
  status          text not null default 'draft'
                    check (status in (
                      'draft',      -- written by Brain, awaiting review
                      'approved',   -- operator approved
                      'rejected',   -- operator rejected (Brain will rewrite)
                      'sent',       -- pushed to Instantly and sent
                      'failed'      -- Instantly returned an error
                    )),
  approved_at     timestamptz,
  sent_at         timestamptz,

  -- Instantly lead tracking (column name kept for backwards compat)
  saleshandy_email_id text,

  -- LLM metadata (for debugging + cost tracking)
  model_used      text,
  prompt_tokens   int,
  completion_tokens int
);

create index emails_prospect on emails(prospect_id);
create index emails_campaign_status on emails(campaign_id, status);


-- ============================================================
-- EVENTS
-- Immutable audit log. Every meaningful thing that happens
-- gets written here: scrapes, sends, replies, payments, errors.
-- ============================================================
create table events (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),

  -- Flexible foreign keys — at least one should be set
  client_id       uuid references clients(id) on delete set null,
  prospect_id     uuid references prospects(id) on delete set null,
  campaign_id     uuid references campaigns(id) on delete set null,
  email_id        uuid references emails(id) on delete set null,

  -- What happened
  type            text not null,
  -- Scout events:      'prospect.discovered', 'prospect.duplicate'
  -- Brain events:      'email.drafted', 'email.rewrite'
  -- Connector events:  'email.sent', 'email.failed'
  -- Watchdog events:   'reply.received', 'payment.received', 'outreach.stopped'
  -- Stripe events:     'subscription.created', 'subscription.cancelled', 'payment.failed'
  -- System events:     'quota.reset', 'campaign.created', 'report.generated', 'error'

  payload         jsonb,        -- full raw webhook body or structured metadata
  source          text          -- e.g. 'scout', 'brain', 'stripe', 'instantly'
);

create index events_client on events(client_id, created_at desc);
create index events_type on events(type, created_at desc);
create index events_prospect on events(prospect_id);


-- ============================================================
-- ROW LEVEL SECURITY
-- Enabled with no policies — the service role key bypasses RLS
-- automatically, so the backend is unaffected. This ensures the
-- anon key can never read or write any table even if leaked.
-- ============================================================
alter table clients      enable row level security;
alter table prospects    enable row level security;
alter table campaigns    enable row level security;
alter table emails       enable row level security;
alter table events       enable row level security;


-- ============================================================
-- AGENT STATES
-- One row per agent (outbound + inbound). Tracks schedule,
-- enabled/disabled toggle, and last run status.
-- Seed rows are inserted via the Supabase dashboard or a
-- separate seed script — this table is never auto-created.
-- ============================================================
create table if not exists agent_states (
  id                text primary key,           -- e.g. 'outbound.scout'
  system            text not null               -- 'outbound' | 'inbound'
                      check (system in ('outbound', 'inbound')),
  name              text not null,
  description       text,
  enabled           boolean not null default false,
  always_on         boolean not null default false,
  schedule_type     text not null default 'manual'
                      check (schedule_type in ('manual', 'interval', 'daily')),
  schedule_value    text,                        -- hours for interval; hour-of-day for daily
  last_run_at       timestamptz,
  last_run_status   text check (last_run_status in ('running', 'success', 'failed')),
  last_run_message  text,
  updated_at        timestamptz not null default now()
);

alter table agent_states enable row level security;

create index if not exists agent_states_system on agent_states(system);


-- ============================================================
-- BOOKINGS
-- Call booking requests from prospective clients.
-- ============================================================
create table if not exists bookings (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text not null,
  phone         text,
  business_type text,
  date          date not null,
  time_slot     text not null,   -- e.g. '10:00'
  status        text not null default 'pending'
                  check (status in ('pending', 'confirmed', 'cancelled')),
  notes         text,
  created_at    timestamptz not null default now()
);

alter table bookings enable row level security;
create index if not exists bookings_date      on bookings(date);
create index if not exists bookings_status_ts on bookings(status, created_at desc);


-- ============================================================
-- AVAILABILITY
-- Weekly template of bookable time slots.
-- day_of_week: 0=Sun, 1=Mon … 6=Sat
-- time_slot:   '09:00', '09:30', '10:00' … (ET, 24h format)
-- Seed via the admin Availability page or Supabase dashboard.
-- ============================================================
create table if not exists availability (
  id           serial primary key,
  day_of_week  int not null check (day_of_week between 0 and 6),
  time_slot    text not null,
  enabled      boolean not null default true,
  unique(day_of_week, time_slot)
);

alter table availability enable row level security;


-- ============================================================
-- HELPER: reset monthly quotas
-- Call this with a cron job or from reporter.js at month start.
-- ============================================================
create or replace function reset_monthly_quotas()
returns void language plpgsql
set search_path = ''
as $$
begin
  update public.clients
  set
    prospects_sent_this_month = 0,
    quota_reset_at = now()
  where billing_status = 'active';
end;
$$;


-- ============================================================
-- HELPER: atomically increment prospects_sent_this_month
-- Called by connector.js after each successful Instantly push.
-- ============================================================
create or replace function increment_prospects_sent(p_client_id uuid, p_count int)
returns void language plpgsql
set search_path = ''
as $$
begin
  update public.clients
  set prospects_sent_this_month = prospects_sent_this_month + p_count
  where id = p_client_id;
end;
$$;
