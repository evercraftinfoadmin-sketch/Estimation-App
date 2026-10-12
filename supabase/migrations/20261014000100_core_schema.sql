-- EverCraft Estimator: shared team database (core tables)
-- Mirrors the app's existing localStorage data model 1:1 (see docs/SUPABASE_SETUP.md).
-- Existing record ids ("est-…", "crm-…", "svc-…", "cat-…", "ph-…", "other") are kept as text keys,
-- so estimate ↔ CRM links, service ↔ category links and line-item references survive the import.
-- Every table is scoped by org_id; keys are (org_id, id).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- organizations & team
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now()
);

create table public.team_members (
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('owner','admin','member')),
  display_name  text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index team_members_user_idx on public.team_members(user_id);

-- ---------------------------------------------------------------- shared business settings
-- = SETTINGS in js/settings.js, except googleMapsApiKey (stays in each browser by design).
create table public.org_settings (
  org_id                uuid primary key references public.organizations(id) on delete cascade,
  company_name          text not null default '',
  company_email         text not null default '',
  company_phone         text not null default '',
  company_address       text not null default '',
  license_number        text not null default '',
  estimate_footer       text not null default '',
  terms                 text not null default '',
  markup                numeric(12,4) not null default 25 check (markup >= 0),
  sales_tax             numeric(12,4) not null default 0  check (sales_tax >= 0),
  tax_mode              text not null default 'all' check (tax_mode in ('all','subtotal')),
  next_estimate_number  integer not null default 1001 check (next_estimate_number >= 1),
  extra                 jsonb not null default '{}'::jsonb,   -- any other stored settings keys, kept as-is
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users(id) on delete set null
);

-- ---------------------------------------------------------------- custom service categories
-- Drywall / Stucco / Painting are fixed in the app code (keys 'drywall','stucco','painting').
create table public.categories (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  id          text not null check (id not in ('drywall','stucco','painting')),
  name        text not null check (length(trim(name)) between 1 and 40),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  deleted_at  timestamptz,
  deleted_by  uuid references auth.users(id) on delete set null,
  primary key (org_id, id)
);
create unique index categories_name_uq on public.categories(org_id, lower(name)) where deleted_at is null;

-- ---------------------------------------------------------------- services
create table public.services (
  org_id         uuid not null references public.organizations(id) on delete cascade,
  id             text not null,
  category       text not null,          -- 'drywall' | 'stucco' | 'painting' | categories.id
  name           text not null check (length(trim(name)) > 0),
  default_price  numeric(14,2) not null default 0 check (default_price >= 0),
  description    text not null default '',
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id) on delete set null,
  updated_by     uuid references auth.users(id) on delete set null,
  deleted_at     timestamptz,
  deleted_by     uuid references auth.users(id) on delete set null,
  primary key (org_id, id)
);
-- Not a foreign key on purpose: the app keeps services whose custom category was removed.
create index services_category_idx on public.services(org_id, category);
create unique index services_name_uq on public.services(org_id, category, lower(name)) where deleted_at is null;

-- ---------------------------------------------------------------- estimates
create table public.estimates (
  org_id                    uuid not null references public.organizations(id) on delete cascade,
  id                        text not null,
  estimate_number           text not null check (length(trim(estimate_number)) > 0),
  date                      date,
  client_name               text not null default '',
  client_email              text not null default '',
  client_phone              text not null default '',
  -- address (js/address.js)
  address                   text not null default '',
  address_status            text not null default 'unverified' check (address_status in ('verified','unverified','needs_review')),
  address_street_number     text not null default '',
  address_route             text not null default '',
  address_unit              text not null default '',
  address_city              text not null default '',
  address_state             text not null default '',
  address_postal_code       text not null default '',
  address_country           text not null default '',
  address_latitude          double precision check (address_latitude between -90 and 90),
  address_longitude         double precision check (address_longitude between -180 and 180),
  address_place_id          text not null default '',
  address_last_verified_at  timestamptz,
  -- line items: [{id, category, categoryName, serviceId, name, description, quantity, price, total}]
  items                     jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  custom_categories         jsonb not null default '[]'::jsonb check (jsonb_typeof(custom_categories) = 'array'),
  category_totals           jsonb not null default '{}'::jsonb check (jsonb_typeof(category_totals) = 'object'),
  drywall_total             numeric(14,2) not null default 0,
  stucco_total              numeric(14,2) not null default 0,
  painting_total            numeric(14,2) not null default 0,
  other_total               numeric(14,2) not null default 0,
  subtotal                  numeric(14,2) not null default 0,
  markup                    numeric(12,4) not null default 0,
  markup_amount             numeric(14,2) not null default 0,
  tax_rate                  numeric(12,4) not null default 0,
  tax_mode                  text not null default 'all' check (tax_mode in ('all','subtotal')),
  tax_amount                numeric(14,2) not null default 0,
  customer_total            numeric(14,2) not null default 0,
  status                    text not null default 'draft' check (status in ('draft','sent','accepted','rejected','completed')),
  crm_project_id            text,
  extra                     jsonb not null default '{}'::jsonb,   -- other stored keys (old calculator fields, "imported", …)
  version                   integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references auth.users(id) on delete set null,
  updated_by                uuid references auth.users(id) on delete set null,
  deleted_at                timestamptz,
  deleted_by                uuid references auth.users(id) on delete set null,
  primary key (org_id, id),
  -- estimate numbers are never reused, also not by deleted estimates
  unique (org_id, estimate_number)
);
create index estimates_updated_idx on public.estimates(org_id, updated_at desc);

-- ---------------------------------------------------------------- CRM projects
-- Stage values are exactly the ones the app stores (js/crm.js CRM_STAGES).
create table public.crm_projects (
  org_id                    uuid not null references public.organizations(id) on delete cascade,
  id                        text not null,
  client_name               text not null default '',
  client_email              text not null default '',
  client_phone              text not null default '',
  address                   text not null default '',
  address_status            text not null default 'unverified' check (address_status in ('verified','unverified','needs_review')),
  address_street_number     text not null default '',
  address_route             text not null default '',
  address_unit              text not null default '',
  address_city              text not null default '',
  address_state             text not null default '',
  address_postal_code       text not null default '',
  address_country           text not null default '',
  address_latitude          double precision check (address_latitude between -90 and 90),
  address_longitude         double precision check (address_longitude between -180 and 180),
  address_place_id          text not null default '',
  address_last_verified_at  timestamptz,
  estimate_id               text,
  estimate_number           text not null default '',
  estimate_total            numeric(14,2) not null default 0,
  stage                     text not null default 'lead'
                            check (stage in ('lead','prospect','job','started','completed','followup')),
  prospect_status           text not null default 'needs_action'
                            check (prospect_status in ('quote_sent','quote_accepted','needs_action')),
  scheduled_date            date,
  assigned_technician       text not null default '',
  notes                     text not null default '',
  -- checklist: [{key, group, label, done}]
  tasks                     jsonb not null default '[]'::jsonb check (jsonb_typeof(tasks) = 'array'),
  follow_up_date            date,
  follow_up_type            text not null default 'client' check (follow_up_type in ('client','personal')),
  follow_up_notes           text not null default '',
  follow_up_completed       boolean not null default false,
  extra                     jsonb not null default '{}'::jsonb,
  version                   integer not null default 1,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid references auth.users(id) on delete set null,
  updated_by                uuid references auth.users(id) on delete set null,
  deleted_at                timestamptz,
  deleted_by                uuid references auth.users(id) on delete set null,
  primary key (org_id, id)
);
-- one CRM project per estimate (same rule as the app)
create unique index crm_projects_estimate_uq on public.crm_projects(org_id, estimate_id)
  where estimate_id is not null and deleted_at is null;
create index crm_projects_stage_idx on public.crm_projects(org_id, stage);

-- estimate ↔ project links; deferrable so linked pairs can be imported in any order
alter table public.estimates
  add constraint estimates_crm_project_fk foreign key (org_id, crm_project_id)
  references public.crm_projects(org_id, id) on delete set null (crm_project_id)
  deferrable initially deferred;
alter table public.crm_projects
  add constraint crm_projects_estimate_fk foreign key (org_id, estimate_id)
  references public.estimates(org_id, id) on delete set null (estimate_id)
  deferrable initially deferred;

-- ---------------------------------------------------------------- project photos
-- Files live in the private Storage bucket "crm-photos" at <org_id>/<project_id>/<photo_id>.jpg
create table public.project_photos (
  org_id        uuid not null references public.organizations(id) on delete cascade,
  id            text not null,
  project_id    text not null,
  storage_path  text not null,
  name          text not null default '',
  caption       text not null default '' check (length(caption) <= 120),
  width         integer,
  height        integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  deleted_by    uuid references auth.users(id) on delete set null,
  primary key (org_id, id),
  foreign key (org_id, project_id) references public.crm_projects(org_id, id) on delete cascade,
  unique (storage_path)
);
create index project_photos_project_idx on public.project_photos(org_id, project_id);
