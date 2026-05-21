-- ============================================================
-- Superade Inbound Schema  (supersedes previous version)
-- Run in Supabase SQL editor AFTER the main supabase-schema.sql.
-- Adds 6 new tables. Does NOT alter any existing tables.
-- ============================================================

create extension if not exists "pgcrypto";


-- ============================================================
-- INBOUND_MODE
-- Single-row config. Always id = 1.
-- ============================================================
create table inbound_mode (
  id                  int primary key default 1 check (id = 1),
  mode                text not null default 'discovery_only'
                        check (mode in (
                          'discovery_only',   -- discovery runs, nothing else
                          'controlled_build', -- site-factory runs on manual approval only
                          'semi_auto',        -- auto-builds on score >= threshold, traffic agent runs
                          'full_auto'         -- everything autonomous, subject to budget_cap_monthly
                        )),
  score_threshold     int not null default 75 check (score_threshold between 0 and 100),
  budget_cap_monthly      numeric(10,2) not null default 0,
  updated_at              timestamptz not null default now(),
  notes                   text,
  last_optimizer_report   jsonb         -- written by agents/optimizer.js
);

insert into inbound_mode (id, mode, score_threshold, budget_cap_monthly)
values (1, 'discovery_only', 75, 0);


-- ============================================================
-- OPPORTUNITIES
-- One row per niche + city combination scored by discovery.js.
-- ============================================================
create table opportunities (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  scored_at             timestamptz,

  niche                 text not null,
  city                  text not null,
  state                 text not null,

  score                 int check (score between 0 and 100),
  scoring_rationale     text,
  score_breakdown       jsonb,
  -- e.g. {"demand": 30, "competition": 25, "viability": 15, "seasonal": 12}

  maps_listing_count    int,
  maps_avg_rating       numeric(3,2),
  serp_has_ads          boolean,
  serp_has_map_pack     boolean,
  serp_aggregator_count int,
  serp_leadgen_count    int,
  serp_snapshot         jsonb,

  is_seed_city          boolean not null default true,
  suggested_by          text,          -- 'seed' | 'claude'

  status                text not null default 'discovered'
                          check (status in (
                            'discovered', 'approved', 'rejected', 'building', 'live', 'paused'
                          )),
  approved_at           timestamptz,
  rejected_reason       text,

  site_id               uuid,          -- FK to generated_sites, added below

  constraint opportunities_unique_niche_city unique (niche, city, state)
);

create index opportunities_score  on opportunities(score desc nulls last);
create index opportunities_status on opportunities(status);
create index opportunities_state  on opportunities(state);
create index opportunities_niche  on opportunities(niche);


-- ============================================================
-- GENERATED_SITES
-- One site per approved opportunity, built by site-factory.js.
-- ============================================================
create table generated_sites (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  opportunity_id    uuid not null references opportunities(id) on delete restrict,

  domain            text,
  site_path         text,
  title             text,
  meta_description  text,
  content           jsonb,

  status            text not null default 'draft'
                      check (status in (
                        'draft', 'pending_approval', 'approved', 'building', 'live', 'paused'
                      )),
  approved_at       timestamptz,
  published_at      timestamptz,
  last_optimized_at timestamptz,

  monthly_visits    int not null default 0,
  total_leads       int not null default 0
);

create index generated_sites_opportunity on generated_sites(opportunity_id);
create index generated_sites_status      on generated_sites(status);

alter table opportunities
  add constraint opportunities_site_fk
  foreign key (site_id) references generated_sites(id);


-- ============================================================
-- VENDORS
-- Local businesses that purchase inbound leads.
-- ============================================================
create table vendors (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Identity
  name                  text not null,
  email                 text not null unique,
  phone                 text,

  -- Niche and service area (single values — one vendor per niche)
  niche                 text not null,
  city                  text not null,
  state                 text not null,

  -- How this vendor relationship was structured
  acquisition_mode      text not null default 'pay_per_lead'
                          check (acquisition_mode in (
                            'build_first',  -- site was built first, vendor pitched after
                            'sell_first',   -- vendor signed first, site built for them
                            'pay_per_lead'  -- ongoing lead sales, no site commitment
                          )),

  -- Billing
  billing_status        text not null default 'prospect'
                          check (billing_status in (
                            'prospect',    -- not yet a paying vendor
                            'active',      -- currently billing
                            'paused',      -- temporarily paused
                            'cancelled'    -- no longer active
                          )),
  monthly_retainer      numeric(10,2),    -- $ per month, null = not on retainer
  lead_price            numeric(10,2),    -- $ per lead, null = not pay-per-lead

  -- Which site feeds them leads (optional — may not be set yet)
  site_id               uuid references generated_sites(id),

  -- Stripe (added when billing is set up)
  stripe_customer_id    text,

  -- Lifetime stats
  total_leads_received  int not null default 0,
  total_revenue         numeric(10,2) not null default 0,

  notes                 text
);

create index vendors_niche        on vendors(niche);
create index vendors_city_state   on vendors(city, state);
create index vendors_status       on vendors(billing_status);
create index vendors_site         on vendors(site_id);


-- ============================================================
-- VENDOR_BILLING
-- Invoice log for each vendor. One row per billing event.
-- ============================================================
create table vendor_billing (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  vendor_id         uuid not null references vendors(id) on delete cascade,

  billing_type      text not null
                      check (billing_type in ('retainer', 'per_lead')),
  amount            numeric(10,2) not null,
  billing_date      date not null default current_date,

  status            text not null default 'pending'
                      check (status in ('pending', 'paid', 'failed')),

  stripe_invoice_id text,   -- Stripe invoice ID once created
  notes             text
);

create index vendor_billing_vendor on vendor_billing(vendor_id, created_at desc);
create index vendor_billing_status on vendor_billing(status);


-- ============================================================
-- INBOUND_LEADS
-- Form submissions captured from generated sites.
-- ============================================================
create table inbound_leads (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  site_id           uuid not null references generated_sites(id) on delete restrict,

  name              text,
  email             text,
  phone             text,
  message           text,
  service_requested text,
  city              text,
  state             text,

  status            text not null default 'new'
                      check (status in ('new', 'routed', 'sold', 'rejected')),
  vendor_id         uuid references vendors(id),
  routed_at         timestamptz,
  sold_at           timestamptz,
  revenue           numeric(10,2),

  referrer          text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,

  raw_payload       jsonb
);

create index inbound_leads_site    on inbound_leads(site_id);
create index inbound_leads_status  on inbound_leads(status);
create index inbound_leads_vendor  on inbound_leads(vendor_id);
create index inbound_leads_created on inbound_leads(created_at desc);


-- ============================================================
-- DISABLE RLS — service role only
-- ============================================================
alter table inbound_mode     disable row level security;
alter table opportunities    disable row level security;
alter table generated_sites  disable row level security;
alter table vendors          disable row level security;
alter table vendor_billing   disable row level security;
alter table inbound_leads    disable row level security;


-- ============================================================
-- HELPER: update vendors.updated_at automatically
-- ============================================================
create or replace function touch_vendor_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger vendors_updated_at
  before update on vendors
  for each row execute function touch_vendor_updated_at();

-- ============================================================
-- AGENT_STATES
-- One row per agent. Persists enable/disable, schedule,
-- last run time, and run status across server restarts.
-- Covers both outbound and inbound agents.
-- ============================================================
create table if not exists agent_states (
  id                text primary key,
  system            text not null check (system in ('outbound','inbound')),
  name              text not null,
  description       text,
  always_on         boolean not null default false,
  enabled           boolean not null default true,
  schedule_type     text not null default 'manual'
                      check (schedule_type in ('manual','interval','daily')),
  schedule_value    text,
  last_run_at       timestamptz,
  last_run_status   text check (last_run_status in ('success','failed','running')),
  last_run_message  text,
  updated_at        timestamptz not null default now()
);

alter table agent_states disable row level security;

insert into agent_states (id, system, name, description, always_on, enabled, schedule_type, schedule_value) values
  ('outbound.scout',      'outbound', 'Scout',       'Finds prospects on Google Maps, Yelp, and directories',         false, true, 'interval', '24'),
  ('outbound.brain',      'outbound', 'Brain',       'Researches prospects and writes personalized emails',           false, true, 'interval', '6'),
  ('outbound.connector',  'outbound', 'Connector',   'Pushes approved emails to Saleshandy and manages campaigns',   false, true, 'interval', '6'),
  ('outbound.watchdog',   'outbound', 'Watchdog',    'Monitors Stripe payments and Saleshandy reply webhooks',        true,  true, 'manual',   null),
  ('outbound.reporter',   'outbound', 'Reporter',    'Generates monthly PDF performance reports',                    false, true, 'manual',   null),
  ('inbound.discovery',   'inbound',  'Discovery',   'Scores niche + city opportunity combinations with Claude',     false, true, 'interval', '24'),
  ('inbound.site_factory','inbound',  'Site Factory','Builds lead gen sites for approved opportunities',             false, true, 'interval', '12'),
  ('inbound.traffic',     'inbound',  'Traffic',     'SEO optimization — sitemaps, search engine pings, GBP steps', false, true, 'interval', '24'),
  ('inbound.lead_router', 'inbound',  'Lead Router', 'Captures form submissions and routes leads to vendors',         true,  true, 'manual',   null),
  ('inbound.optimizer',   'inbound',  'Optimizer',   'Monitors site performance and generates recommendations',      false, true, 'interval', '24')
on conflict (id) do nothing;


-- ─── Migrations (run if schema was already applied) ───────────────────────────
-- alter table inbound_mode add column if not exists last_optimizer_report jsonb;
-- Run to add agent_states if schema already applied:
-- (copy the create table + insert block above and run in Supabase SQL editor)
