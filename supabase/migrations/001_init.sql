-- Google Ads MCP server schema. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- All tables are locked down with RLS (no policies): only the server's service key can read/write them.

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

alter table users enable row level security;
alter table oauth_clients enable row level security;
alter table oauth_auth_requests enable row level security;
alter table oauth_codes enable row level security;
alter table oauth_tokens enable row level security;
alter table audit_log enable row level security;
