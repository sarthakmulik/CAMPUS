-- 0055 - R2 MEDIA GATE (dark phase: zero behavior change until the client
-- switches its upload routing constant; nothing here touches Supabase Storage
-- policies, buckets or RLS for existing media).
--
-- Purpose (R2-STORAGE-PLAN.md §3/§5): when bulk uploads move to Cloudflare R2,
-- the authorization act still happens in Supabase. The `r2-sign` edge function
-- verifies the caller's JWT, then asks THIS database "may this viewer see this
-- object" before presigning. These two functions are that question:
--
--   can_view_media_source(ns, key)   - GET entitlement (mirrors today's
--                                      storage SELECT policies exactly)
--   can_write_media_source(ns, key)  - PUT entitlement (mirrors today's
--                                      storage INSERT policies exactly)
--
-- Namespaces and their parity source (no weakening, no strengthening):
--   ns='media'    post images + reels: the 0051/0053 gate wrapper
--                 can_view_media_object(name) - unchanged, staff allowance and
--                 community-post branches included. Uploads: own folder only
--                 (0002 "members upload campus media").
--   ns='chat'     chat-media objects: first path segment is the conversation
--                 id; membership via is_conversation_member - byte-for-byte
--                 the same check as the 0020 storage policy
--                 "chat media members read".
--   ns='resource' community resource files: <club>/<uploader>/<file>;
--                 active club membership via is_club_active_member - the same
--                 helper the 0016a resources policies use. Uploads additionally
--                 require the second segment to be the caller's own folder.
--
-- Also extends post_media_gate_sync() (0051 trigger) so posts whose media_urls
-- carry canonical R2 URIs ("r2://<bucket>/<key>") sync into the same gate
-- table - one gate, one more key-space, exactly as planned.
--
-- Idempotent: create-or-replace only. Safe to run again.

-- ------------------------------------------------------------------ --
-- 1. GET entitlement: the wrapper the r2-sign edge function calls     --
-- ------------------------------------------------------------------ --
create or replace function public.can_view_media_source(p_ns text, p_key text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_scope uuid;
begin
  if p_key is null or length(p_key) = 0 or position('../' in p_key) > 0 then
    return false;
  end if;

  case p_ns
    when 'media' then
      -- unchanged 0051/0053 semantics (gate + posts visibility + staff +
      -- community branches). Drafts (no post row) stay invisible to
      -- everyone but the object owner via the owner policy on Supabase;
      -- on R2 the edge function adds the same own-folder owner rule.
      return public.can_view_media_object(p_key);

    when 'chat' then
      v_scope := public.uuid_or_null(split_part(p_key, '/', 1));
      return v_scope is not null
        and public.is_conversation_member(v_scope);

    when 'resource' then
      v_scope := public.uuid_or_null(split_part(p_key, '/', 1));
      return v_scope is not null
        and public.is_club_active_member(v_scope, auth.uid());

    else
      return false;
  end case;
end;
$$;

revoke all on function public.can_view_media_source(text, text) from public;
grant execute on function public.can_view_media_source(text, text) to anon, authenticated, service_role;

-- ------------------------------------------------------------------ --
-- 2. PUT entitlement: presign uploads only where storage RLS would    --
-- ------------------------------------------------------------------ --
create or replace function public.can_write_media_source(p_ns text, p_key text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_scope uuid;
begin
  if p_key is null or length(p_key) = 0 or position('../' in p_key) > 0 then
    return false;
  end if;

  case p_ns
    when 'media' then
      -- own folder only: <uid>/<ts>.<ext> (0002 upload policy parity)
      return split_part(p_key, '/', 1) = auth.uid()::text
        and split_part(p_key, '/', 2) is not null
        and length(split_part(p_key, '/', 2)) > 0;

    when 'chat' then
      -- conversation membership parity (0020 upload policy); the 25 MB
      -- ceiling lives in the edge function where the size is known
      v_scope := public.uuid_or_null(split_part(p_key, '/', 1));
      return v_scope is not null
        and public.is_conversation_member(v_scope);

    when 'resource' then
      -- active member AND writing into their own uploader folder
      -- (<club>/<uid>/<file>, uploadResourceFile parity)
      v_scope := public.uuid_or_null(split_part(p_key, '/', 1));
      return v_scope is not null
        and public.is_club_active_member(v_scope, auth.uid())
        and split_part(p_key, '/', 2) = auth.uid()::text;

    else
      return false;
  end case;
end;
$$;

revoke all on function public.can_write_media_source(text, text) from public, anon;
grant execute on function public.can_write_media_source(text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ --
-- 3. Gate sync learns the R2 URI scheme                               --
--    posts.media_urls may now hold "r2://campus-media/<key>"; the same --
--    canonical key lands in post_media_gate, so staff allowance and    --
--    community-post semantics flow through unchanged.                  --
-- ------------------------------------------------------------------ --
create or replace function public.post_media_gate_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u text;
begin
  if TG_OP = 'DELETE' then
    delete from public.post_media_gate where post_id = old.id;
    return old;
  end if;

  -- any update refreshes the mapping for this post (audit fields may change
  -- too; a full re-sync is cheap and can never go stale)
  delete from public.post_media_gate where post_id = new.id;
  for u in select unnest(coalesce(new.media_urls, '{}'))
  loop
    -- uploads are stored as absolute public-shaped URLs; accept bare paths too
    u := regexp_replace(u, '^.*' || '/storage/v1/object/public/media/', '');
    u := regexp_replace(u, '^.*' || '/storage/v1/object/authenticated/media/', '');
    -- 0055: canonical R2 URIs - "r2://<bucket>/<key>" reduces to <key>
    u := regexp_replace(u, '^r2://[^/]+/', '');
    continue when u is null or length(u) = 0;
    insert into public.post_media_gate (name, post_id, audience, college_id, author_id)
    values (u, new.id, new.audience, new.college_id, new.author_id)
    on conflict (name, post_id) do nothing;
  end loop;
  return new;
end;
$$;

-- trigger itself already exists (0051) - it re-fires on every posts write, so
-- nothing to recreate. Backfill is not needed: no r2:// URIs exist yet (dark
-- phase), and future rows sync on write.
