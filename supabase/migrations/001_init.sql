-- ============================================================================
-- Google Ads MCP server: complete database setup (one file, run it once)
--
-- How to run: Supabase dashboard -> SQL Editor -> New query -> paste this whole
-- file -> Run. It is safe to run again: nothing is dropped or overwritten.
--
-- Part 1: tables
-- Part 2: row level security (RLS) so only the server's secret key can read/write
-- Part 3: permissions for that secret key (service_role)
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Part 1: tables
-- ---------------------------------------------------------------------------

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  google_refresh_token_enc text,           -- AES-256-GCM encrypted
  login_customer_id text,                  -- auto-detected manager (MCC) account
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists oauth_clients (   -- Claude registers itself here (dynamic client registration)
  client_id text primary key,
  client_name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists oauth_auth_requests ( -- in-flight sign-ins (10 minutes)
  id text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  client_state text,
  code_challenge text not null,
  expires_at timestamptz not null
);

create table if not exists oauth_codes (     -- one-time authorization codes (hashed)
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used boolean not null default false
);

create table if not exists oauth_tokens (    -- access + refresh tokens issued to Claude (hashed)
  token_hash text primary key,
  kind text not null check (kind in ('access', 'refresh')),
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists oauth_tokens_user_idx on oauth_tokens(user_id);

create table if not exists audit_log (       -- every executed (or previewed) Google Ads change
  id bigint generated always as identity primary key,
  user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  entry jsonb not null
);


-- ---------------------------------------------------------------------------
-- Part 2: lock the tables down
-- RLS is on and there are deliberately no policies, so the public/publishable
-- key can never read or write anything. Only the server's secret key can.
-- ---------------------------------------------------------------------------

alter table users enable row level security;
alter table oauth_clients enable row level security;
alter table oauth_auth_requests enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;
alter table audit_log enable row level security;


-- ---------------------------------------------------------------------------
-- Part 3: let the server's secret key (service_role) use the tables
-- Newer Supabase projects do not auto-grant table access to service_role.
-- Without this, every server query fails with "permission denied for table ...".
-- anon/authenticated (the publishable key) still get nothing.
-- ---------------------------------------------------------------------------

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
