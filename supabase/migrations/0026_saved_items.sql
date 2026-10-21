-- ============================================================================
-- 0026: SAVED ITEMS (unified Bookmarks/saved surface)
-- ============================================================================
-- CAMPUS already persists saves for two content types with their own tables,
-- RPCs and RLS, all referenced live by their pages:
--
--   posts            -> public.post_bookmarks  (schema.sql, PK post_id+user_id)
--   events           -> public.saved_events    (0018, toggle_saved_event RPC)
--   listings         -> public.saved_listings  (0019, toggle_saved_listing RPC)
--
-- book "saved" actions in Home/Discover feeds were local-only UI state before
-- this migration: nothing was written, nothing was restored, and there was no
-- Bookmarks page at all (the nav item rendered the scaffold placeholder).
--
-- What this migration adds (nothing existing is altered or dropped):
--   1. An index on post_bookmarks(user_id, created_at desc) so a member's
--      bookmark list paginates in reverse-chronological save order.
--   2. public.saved_resources — the missing store, for community resources
--      (files + links). Same shape as saved_events / saved_listings:
--      composite key, FK cascade, owner-row-level RLS.
--   3. public.toggle_saved_resource — writes are membership-checked server
--      side. A bookmark is a reference, never an authorization token: saving
--      can only record content the caller already sees.
--   4. public.list_saved_items — ONE paginated, searchable read over all four
--      stores (saved_at cursor, newest first) that re-derives and re-enforces
--      each content type's existing visibility rules per row. Deleted-ish,
--      cancelled-check rules and community membership are enforced exactly
--      like the feed functions above, so a saved private resource or a sold
--      listing can never leak through the Bookmarks page.
--
-- Idempotent: create-if-not-exists / drop-if-exists + create, safe to re-run.
-- ============================================================================
begin;

/* 1. post_bookmarks: reverse-chronological per-user reads ------------------- */
create index if not exists post_bookmarks_user_idx
  on public.post_bookmarks (user_id, created_at desc);

/* 2. saved_resources ---------------------------------------------------------*/
create table if not exists public.saved_resources (
  resource_id uuid not null references public.community_resources (id) on delete cascade,
  user_id     uuid not null references public.profiles (id)          on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (resource_id, user_id)
);

create index if not exists saved_resources_user_idx
  on public.saved_resources (user_id, created_at desc);

alter table public.saved_resources enable row level security;

drop policy if exists "saved resources are private to their owner" on public.saved_resources;
create policy "saved resources are private to their owner" on public.saved_resources
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/* 3. toggle_saved_resource ----------------------------------------------------
   Same contract as toggle_saved_event: insert-if-absent / delete, idempotent
   by the composite key. Saving enforces the resource's own access rule
   (active membership of the owning community) BEFORE the row exists — so the
   save surface can never widen access, only point at content already seen. */
create or replace function public.toggle_saved_resource(p_resource uuid, p_saved boolean)
returns boolean        -- true = now saved
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_club uuid;
begin
  if v_me is null then
    raise exception 'Sign in to save resources.';
  end if;

  select r.club_id into v_club
    from public.community_resources r
   where r.id = p_resource;

  if v_club is null then
    -- already gone (author deleted it): un-saving must still succeed
    if not p_saved then
      delete from public.saved_resources
       where user_id = v_me and resource_id = p_resource;
      return false;
    end if;
    raise exception 'That resource is no longer available.';
  end if;

  -- pre-0016a lesson: membership checks in definer code must use the helper,
  -- which is the only safe membership read
  if p_saved then
    if not public.is_club_active_member(v_club, v_me) then
      raise exception 'Only members of that community can save its resources.';
    end if;
    insert into public.saved_resources (resource_id, user_id)
    values (p_resource, v_me)
    on conflict (resource_id, user_id) do nothing;
    return true;
  end if;

  delete from public.saved_resources
   where user_id = v_me and resource_id = p_resource;
  return false;
end;
$$;

revoke all on function public.toggle_saved_resource(uuid, boolean) from public, anon;
grant execute on function public.toggle_saved_resource(uuid, boolean) to authenticated;

/* 4. list_saved_items ---------------------------------------------------------
   The Bookmarks page read path. One cursor-paginated query over all four
   per-person stores, merged newest-first, each branch filtered by:
   a) ownership (all four saved tables are owner-private), and
   b) the content type's CURRENT visibility rules — stale bookmarks to content
      the caller can no longer see simply do not come back; they are kept in
      the store in case access returns (never deleted behind the user's back).
   p_kind: all | post | reel | event | listing | resource
   p_query: server-side ilike over the same fields the type's own search uses.
   Keyset pagination: pass p_before = the last row's saved_at AND
   p_after_id = the last row's content_id (tie-breaker), matching the row
   order (saved_at desc, content_id desc) so equal-timestamp saves can
   neither repeat nor skip between pages. */
create or replace function public.list_saved_items(
  p_kind   text default 'all',
  p_query  text default null,
  p_before timestamptz default null,
  p_limit  integer default 12,
  p_after_id uuid default null
)
returns table (
  kind       text,        -- post | reel | event | listing | resource
  content_id uuid,
  saved_at   timestamptz,
  payload    jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select w.uid as me_id, p.college_id as my_college
    from (select auth.uid() as uid) w
    left join public.profiles p on p.id = w.uid
  ),
  q as (
    select '%' || replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' as term
    from (select nullif(btrim(coalesce(p_query, '')), '') as t) x
  ),
  m as (
    select w.me_id, w.my_college, coalesce(q.term, '') as term,
           coalesce(p_before, 'infinity'::timestamptz) as cutoff
    from me w cross join q
  ),
  items as (
    /* posts (kind <> 'reel') — same visibility clause as the posts SELECT
       policy (0016a): published, and community posts only when live and
       public-or-membership */
    select
      b.created_at as saved_at,
      'post'::text as kind,
      p.id as content_id,
      jsonb_build_object(
        'body', p.body,
        'kind', p.kind,
        'media', to_jsonb(case when coalesce(array_length(p.media_urls, 1), 0) > 0 then p.media_urls[1] end),
        'anonymous', p.is_anonymous,
        'author_id', case when p.is_anonymous then null else p.author_id end,
        'author_name', case when p.is_anonymous then null else pr.display_name end,
        'author_username', case when p.is_anonymous then null else pr.username end,
        'author_avatar', case when p.is_anonymous then null else pr.avatar_url end,
        'author_verified', case when p.is_anonymous then null else coalesce(pr.is_verified, false) end,
        'college', c.short_name,
        'created_at', p.created_at,
        'like_count', (select count(*) from public.post_likes pl where pl.post_id = p.id),
        'comment_count', (select count(*) from public.post_comments pc where pc.post_id = p.id)
      ) as payload
    from public.post_bookmarks b
    join public.posts p
      on p.id = b.post_id
     and p.is_published = true
     and (p.kind is distinct from 'reel')
     and (p.community_id is null or exists (
           select 1 from public.clubs cxc
           where cxc.id = p.community_id
             and cxc.archived_at is null
             and (cxc.privacy = 'public'
                  or public.is_club_active_member(cxc.id, (select me_id from m))))
         )
    left join public.profiles pr on pr.id = p.author_id
    left join public.colleges c on c.id = p.college_id
    cross join m
    where b.user_id = (select me_id from m)
      and (
        b.created_at < (select cutoff from m)
        or (p_before is not null and b.created_at = p_before
            and (p_after_id is null or b.post_id < p_after_id))
      )
      and ((select term from m) = '' or p.body ilike (select term from m))
      and (p_kind in ('all', 'post'))

    union all

    /* reels — same store, kind = 'reel' */
    select
      b.created_at,
      'reel'::text,
      p.id,
      jsonb_build_object(
        'body', p.body,
        'media', to_jsonb(case when coalesce(array_length(p.media_urls, 1), 0) > 0 then p.media_urls[1] end),
        'author_id', p.author_id,
        'author_name', pr.display_name,
        'author_username', pr.username,
        'author_avatar', pr.avatar_url,
        'author_verified', coalesce(pr.is_verified, false),
        'college', c.short_name,
        'created_at', p.created_at,
        'like_count', (select count(*) from public.post_likes pl where pl.post_id = p.id),
        'comment_count', (select count(*) from public.post_comments pc where pc.post_id = p.id)
      ) as payload
    from public.post_bookmarks b
    join public.posts p
      on p.id = b.post_id
     and p.is_published = true
     and p.kind = 'reel'
     and (p.community_id is null or exists (
           select 1 from public.clubs cxc
           where cxc.id = p.community_id
             and cxc.archived_at is null
             and (cxc.privacy = 'public'
                  or public.is_club_active_member(cxc.id, (select me_id from m))))
         )
    left join public.profiles pr on pr.id = p.author_id
    left join public.colleges c on c.id = p.college_id
    cross join m
    where b.user_id = (select me_id from m)
      and (
        b.created_at < (select cutoff from m)
        or (p_before is not null and b.created_at = p_before
            and (p_after_id is null or b.post_id < p_after_id))
      )
      and ((select term from m) = '' or p.body ilike (select term from m))
      and (p_kind in ('all', 'reel'))

    union all

    /* events — same visibility as list_events' scoped clause; cancelled
       events stay visible on the saved list (matches the 'saved' mode) */
    select
      v.created_at,
      'event'::text,
      e.id,
      jsonb_build_object(
        'title', e.title,
        'slug', e.slug,
        'cover', e.cover_url,
        'category', e.category,
        'format', e.format,
        'venue', e.venue,
        'city', e.city,
        'starts_at', e.starts_at,
        'ends_at', e.ends_at,
        'audience', e.audience,
        'published', e.published,
        'cancelled_at', e.cancelled_at,
        'college_name', cg.name,
        'club_name', cb.name,
        'club_slug', cb.slug,
        'capacity', e.capacity,
        'registered_count', (select count(*) from public.event_rsvps er
                              where er.event_id = e.id and er.status = 'registered')
      ) as payload
    from public.saved_events v
    join public.events e
      on e.id = v.event_id
     and (e.created_by = (select me_id from m)
          or exists (
            select 1 from public.event_rsvps r
            where r.event_id = e.id and r.user_id = (select me_id from m)
              and r.status = any (array['registered', 'waitlisted', 'going', 'interested'])
          )
          or (e.published and (
            e.audience = 'public'
            or ((select me_id from m) is not null and (
              (e.audience = 'college' and e.college_id = (select my_college from m))
              or (e.audience = 'community' and e.club_id is not null
                  and public.is_club_active_member(e.club_id, (select me_id from m)))
            ))
          )))     -- no cancel filter: 0018's saved mode keeps cancelled events
    left join public.colleges cg on cg.id = e.college_id
    left join public.clubs cb on cb.id = e.club_id
    cross join m
    where v.user_id = (select me_id from m)
      and (
        v.created_at < (select cutoff from m)
        or (p_before is not null and v.created_at = p_before
            and (p_after_id is null or v.event_id < p_after_id))
      )
      and ((select term from m) = ''
           or e.title ilike (select term from m)
           or coalesce(e.venue, '') ilike (select term from m))
      and (p_kind in ('all', 'event'))

    union all

    /* listings — same visibility as the marketplace list function: live
       (active or sold), moderation-clean, inside the caller's audience
       scope. A sold listing deliberately keeps showing with its state. */
    select
      v.created_at,
      'listing'::text,
      l.id,
      jsonb_build_object(
        'title', l.title,
        'slug', l.slug,
        'price', l.price,
        'transaction_type', l.transaction_type,
        'category', l.category,
        'condition', l.condition,
        'image', to_jsonb(case when coalesce(array_length(l.images, 1), 0) > 0 then l.images[1] end),
        'status', l.status,
        'audience', l.audience,
        'college_name', (select name from public.colleges c where c.id = l.college_id),
        'owner_name', op.display_name,
        'owner_id', l.owner_id,
        'created_at', l.created_at
      ) as payload
    from public.saved_listings v
    join public.marketplace_listings l
      on l.id = v.listing_id
     and l.moderation_status = 'clean'
     and l.status in ('active', 'sold')
     and (l.audience = 'global'
          or (l.audience = 'college' and l.college_id = (select my_college from m)))
    left join public.profiles op on op.id = l.owner_id
    cross join m
    where v.user_id = (select me_id from m)
      and (
        v.created_at < (select cutoff from m)
        or (p_before is not null and v.created_at = p_before
            and (p_after_id is null or v.listing_id < p_after_id))
      )
      and ((select term from m) = '' or l.title ilike (select term from m))
      and (p_kind in ('all', 'listing'))

    union all

    /* community resources — membership-gated exactly like
       list_club_resources; leaving the community hides the row again */
    select
      v.created_at,
      'resource'::text,
      r.id,
      jsonb_build_object(
        'title', r.title,
        'description', r.description,
        'link_url', r.link_url,
        'file_name', r.file_name,
        'mime_type', r.mime_type,
        'file_size', r.file_size,
        'storage_path', r.storage_path,
        'has_file', r.storage_path is not null,
        'uploader_name', ru.display_name,
        'uploader_id', r.uploader_id,
        'club_id', r.club_id,
        'club_name', c.name,
        'club_slug', c.slug,
        'created_at', r.created_at
      ) as payload
    from public.saved_resources v
    join public.community_resources r
      on r.id = v.resource_id
     and public.is_club_active_member(r.club_id, (select me_id from m))
     and exists (
       select 1 from public.clubs c
       where c.id = r.club_id and c.archived_at is null
     )
    left join public.profiles ru on ru.id = r.uploader_id
    left join public.clubs c on c.id = r.club_id
    cross join m
    where v.user_id = (select me_id from m)
      and (
        v.created_at < (select cutoff from m)
        or (p_before is not null and v.created_at = p_before
            and (p_after_id is null or v.resource_id < p_after_id))
      )
      and ((select term from m) = ''
           or r.title ilike (select term from m)
           or coalesce(r.file_name, '') ilike (select term from m))
      and (p_kind in ('all', 'resource'))
  )
  select i.kind, i.content_id, i.saved_at, i.payload
    from items i
   order by i.saved_at desc, i.content_id desc
   limit least(greatest(coalesce(p_limit, 12), 1), 48);
$$;

revoke all on function public.list_saved_items(text, text, timestamptz, integer, uuid) from public, anon;
grant execute on function public.list_saved_items(text, text, timestamptz, integer, uuid) to authenticated;

commit;

-- ============================================================================
-- Verification queries (run by hand in the SQL editor after applying):
--   select * from public.list_saved_items('all', null, null, 5);
--   -- the same call with anon role must return nothing (revoked → error):
--   set local role anon; select * from public.list_saved_items(); reset role;
--   select * from public.list_saved_items('resource');  -- membership-gated
-- ============================================================================
