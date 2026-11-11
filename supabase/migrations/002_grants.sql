-- Newer Supabase projects do not auto-grant table access to service_role.
-- Without this, every server query fails with "permission denied for table ...".
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- anon/authenticated (publishable key) still get nothing: RLS stays on with no policies.

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
