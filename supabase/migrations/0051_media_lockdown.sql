-- ============================================================================
-- 0051 — MEDIA LOCKDOWN (the `media` storage bucket)
--
-- Closes the last documented audience limitation: while the `media` bucket
-- stayed public-read, a college-scoped post's media could technically be
-- fetched by anyone who had (or guessed) the object URL — the record/feed
-- boundary never covered the bytes.
--
-- Model (no signed URLs in the DB, no client URL migrations):
--   1. The bucket flips to PRIVATE, so /object/public/... dies everywhere.
--   2. Storage RLS becomes the gate. Two SELECT policies on storage.objects:
--        - the OWNER of an object (the uploader, i.e. the composer preview
--          before its post is published) always reads their own object;
--        - anyone (authenticated or anon) may read an object that is
--          referenced by a post they can see per the 0049 rule — one index
--          hop through post_media_gate, then the LIVE posts row (so
--          unpublishing/audience changes apply instantly, no staleness).
--   3. The client renders media through SHORT-LIVED SIGNED URLs that the
--     storage API mints per caller — a mint itself requires that the caller
--     passes the same SELECT policy, so "signing" is the authorization act.
--     The DB keeps storing canonical public-shaped URLs; only presentation
--     swaps them. (Verified live during the flip: policy-denied callers fail
--     to mint, so signed URLs can never be used to bypass the audience rule.)
--   4. Other buckets (ad-media, avatars, chat-media, resources, communities)
--     are untouched and stay exactly as they are.
--
-- Safe to re-run. Run in the Supabase SQL editor.
-- ============================================================================

-- 1. gate table: object name -> the posts that reference it ------------------
create table if not exists public.post_media_gate (
  name      text not null,          -- storage.objects.name inside bucket 'media'
  post_id   uuid not null references public.posts(id) on delete cascade,
  audience  text not null default 'public',
  college_id uuid,
  author_id  uuid,
  primary key (name, post_id)
);
alter table public.post_media_gate enable row level security;
-- direct access stays closed; the only reader is the definer wrapper below
revoke all on public.post_media_gate from anon, authenticated;

-- the wrapper the storage policies call: runs as owner, so neither the
-- table grant nor posts RLS play a part — the 0049 rule is the only gate
create or replace function public.can_view_media_object(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.post_media_gate g
    join public.posts p on p.id = g.post_id
    where g.name = p_name
      and p.is_published = true
      and public.post_visible_to(p.audience, p.college_id, p.author_id)
  )
$$;
revoke all on function public.can_view_media_object(text) from public;
grant execute on function public.can_view_media_object(text) to anon, authenticated;

-- 2. trigger: keep the gate in sync with posts.media_urls --------------------
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
    continue when u is null or length(u) = 0;
    insert into public.post_media_gate (name, post_id, audience, college_id, author_id)
    values (u, new.id, new.audience, new.college_id, new.author_id)
    on conflict (name, post_id) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists post_media_gate_bsync on public.posts;
create trigger post_media_gate_bsync
  after insert or update or delete on public.posts
  for each row execute function public.post_media_gate_sync();

-- 3. backfill everything that exists today -----------------------------------
insert into public.post_media_gate (name, post_id, audience, college_id, author_id)
select
  regexp_replace(m.url, '^.*' || '/storage/v1/object/public/media/', ''),
  p.id, p.audience, p.college_id, p.author_id
from public.posts p
cross join unnest(coalesce(p.media_urls, '{}')) as m(url)
where coalesce(p.media_urls, '{}') <> '{}'
  and p.community_id is null   -- community posts keep their own surface semantics
on conflict (name, post_id) do nothing;

-- 4. storage RLS: the gate becomes the bucket's public boundary --------------
-- Drop existing SELECT policies for the media bucket (the permissive ones the
-- dashboard created when the bucket was public). Policies whose USING clause
-- mentions the bucket name are matched; other buckets are untouched.
do $$
declare r record;
begin
  -- idempotency: drop this migration's own policy by exact name (an earlier
  -- run may have left it behind in older shapes), then re-create fresh below
  drop policy if exists "media visible via campaign post" on storage.objects;
  drop policy if exists "media owner reads own on media" on storage.objects;

  for r in
    select policyname from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and cmd = 'SELECT'
      and lower(qual) like '%media%'
  loop
    execute format('drop policy if exists %I on storage.objects', r.policyname);
  end loop;

  -- owner of the object — the storage schema shipped different owner shapes
  -- over its releases (owner_id uuid, owner_id text, owner text). Try each in
  -- turn; the first that parses wins.
  begin
    begin
      execute $p$
        create policy "media owner reads own on media" on storage.objects
          for select to authenticated
          using (bucket_id = 'media' and owner_id = auth.uid())
      $p$;
    exception
      when duplicate_object then null;
      when undefined_function then  -- 42883: wrong operand type → text variant
        execute $p$
          create policy "media owner reads own on media" on storage.objects
            for select to authenticated
            using (bucket_id = 'media' and owner_id = auth.uid()::text)
        $p$;
    end;
  exception
    when undefined_column then   -- no owner_id column at all → legacy `owner`
      begin
        execute $o$
          create policy "media owner reads own on media" on storage.objects
            for select to authenticated
            using (bucket_id = 'media' and owner = auth.uid()::text)
        $o$;
      exception
        when undefined_function then  -- owner is uuid-typed instead of text
          execute $o$
            create policy "media owner reads own on media" on storage.objects
              for select to authenticated
              using (bucket_id = 'media' and owner = auth.uid())
          $o$;
        when duplicate_object then null;
      end;
    when duplicate_object then null;
  end;

  -- anyone: objects referenced by a post the caller may see (live state).
  -- The check runs through the security-definer wrapper: a policy subquery
  -- otherwise evaluates under the caller's role, which has no grant on the
  -- gate table (revoked above on purpose) — the wrapper is the only reader.
  execute $q$
    create policy "media visible via campaign post" on storage.objects
      for select to anon, authenticated
      using (bucket_id = 'media' and public.can_view_media_object(name))
  $q$;
exception
  when duplicate_object then null; -- already applied on an earlier run
end $$;

-- 5. flip the bucket private --------------------------------------------------
update storage.buckets set public = false where id = 'media';
