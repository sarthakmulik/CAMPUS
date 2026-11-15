-- ====================================================================
-- 0069 - link scheme hardening (defense in depth)
--
-- Host-entered event URLs (registration/map/online) and member-entered
-- community resource links render as navigable anchors / window.open
-- targets. A javascript: or data: value there would execute script in
-- the app origin on click (stored XSS with the Supabase session in
-- reach). The client now only renders http(s) URLs (safeUrl.ts guard);
-- these CHECK constraints make the database refuse scheme-hostile
-- writes for every future writer too, RPC or not.
--
-- NOT VALID: the constraint applies to new writes immediately without
-- scanning/validating legacy rows (a single legacy row with an odd
-- URL must not block applying this migration).
-- Idempotent; no tables or columns change.
-- Rollback: alter table ... drop constraint <name>.
-- ====================================================================

alter table public.events
  drop constraint if exists events_link_urls_http_only;
alter table public.events
  add constraint events_link_urls_http_only check (
    (registration_url is null or registration_url ~* '^https?://')
    and (map_url is null or map_url ~* '^https?://')
    and (online_url is null or online_url ~* '^https?://')
  ) not valid;

alter table public.community_resources
  drop constraint if exists community_resources_link_http_only;
alter table public.community_resources
  add constraint community_resources_link_http_only check (
    btrim(link_url) = '' or link_url ~* '^https?://'
  ) not valid;
