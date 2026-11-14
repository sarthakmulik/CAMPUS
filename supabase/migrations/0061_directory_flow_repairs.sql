-- 0061 - DIRECTORY FLOW REPAIRS + STAFF COLLEGE-REQUEST REVIEW
--
-- APPLY ORDER: 0057 -> 0058 -> 0059 -> 0060 -> 0061.
-- (0060 adds list_institution_campuses; a live probe on 2026-11-14 showed
--  0057/0058/0059 applied and 0060 NOT applied - the wizard's campus step is
--  dead until it is.)
--
-- 1. request_college_suggestion(text, text) from 0001 is DROPPED.
--    0057 added a 5-arg overload sharing the leading parameter names, so
--    PostgREST could not pick a candidate and every "my college is not
--    listed" request failed with PGRST203 (verified against the live project:
--    POST /rest/v1/rpc/request_college_suggestion -> 300 PGRST203). The 5-arg
--    version is the only one the client calls.
--
-- 2. list_group_posts loses its anon grant. It is SECURITY INVOKER (so posts
--    RLS still decides), and anon holds no SELECT on posts since 0046, so the
--    0059 grant produced 42501 "permission denied for table posts" for every
--    signed-out visitor. The group feed is a member surface.
--
-- 3. Staff review for college requests (Phase 6 admin workflow):
--    college_suggestions had no UPDATE policy, so a request could never leave
--    'pending'. Adds a staff-only update policy plus
--    list_college_suggestions() and review_college_suggestion().
--    Approving creates a colleges row with verification_status='pending_review'
--    (never publicly selectable); "publish" promotes it to 'verified'.
--    Existing directory rows are reused, never duplicated.
--
-- Everything here is additive or a privilege correction. No column is dropped,
-- no row is rewritten, no policy is removed. Idempotent.

-- ---------------------------------------------------------------------------
-- 0. colleges.updated_at - the directory is now staff-edited (0045 console,
--    verification flips), but the table never got the timestamp the other
--    directory tables have. Added before anything writes to it.
-- ---------------------------------------------------------------------------
alter table public.colleges add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'touch_updated_at') then
    create function public.touch_updated_at() returns trigger
    language plpgsql as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$;
  end if;
end $$;

drop trigger if exists colleges_touch on public.colleges;
create trigger colleges_touch before update on public.colleges
  for each row execute function public.touch_updated_at();

create index if not exists colleges_verification_idx
  on public.colleges (verification_status);

-- ---------------------------------------------------------------------------
-- 1. drop the ambiguous legacy suggestion overload
-- ---------------------------------------------------------------------------
drop function if exists public.request_college_suggestion(text, text);

-- ---------------------------------------------------------------------------
-- 2. group feed is a member surface (posts RLS + authenticated only)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'list_group_posts') then
    revoke all on function public.list_group_posts(integer, integer) from anon;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'list_group_peers') then
    revoke all on function public.list_group_peers(integer, integer) from anon;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'list_group_posts') then
    grant execute on function public.list_group_posts(integer, integer) to authenticated;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'list_group_peers') then
    grant execute on function public.list_group_peers(integer, integer) to authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. staff review of college requests
-- ---------------------------------------------------------------------------
drop policy if exists "suggestions reviewable by admins" on public.college_suggestions;
create policy "suggestions reviewable by admins" on public.college_suggestions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.list_college_suggestions(
  p_status text default 'pending',
  p_limit  int  default 50
)
returns table (
  id              uuid,
  name            text,
  city            text,
  locality        text,
  official_website text,
  institution_type text,
  status          text,
  status_note     text,
  created_at      timestamptz,
  requester_id    uuid,
  requester_name  text,
  requester_handle text,
  college_id      uuid,
  college_short_name text
)
language sql stable security definer set search_path = ''
as $$
  select
    s.id,
    s.name,
    s.city,
    s.locality,
    s.official_website,
    s.institution_type,
    s.status,
    s.status_note,
    s.created_at,
    s.user_id,
    pr.display_name,
    pr.username,
    c.id,
    c.short_name
  from public.college_suggestions s
  left join public.profiles pr on pr.id = s.user_id
  -- the directory row this request already produced (one name, one row)
  left join lateral (
    select c2.id, c2.short_name
    from public.colleges c2
    where lower(c2.name) = lower(s.name)
    order by c2.created_at
    limit 1
  ) c on true
  where public.is_admin()
    and (p_status is null or s.status = p_status)
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

revoke all on function public.list_college_suggestions(text, int) from public;
grant execute on function public.list_college_suggestions(text, int) to authenticated;

create or replace function public.review_college_suggestion(
  p_id       uuid,
  p_decision text,
  p_publish  boolean default false,
  p_note     text    default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_suggestion   public.college_suggestions%rowtype;
  v_existing     public.colleges%rowtype;
  v_college_id   uuid;
  v_short        text;
  v_slug         text;
  v_suffix       int := 1;
  v_type         text;
  v_note         text;
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS staff can review college requests.';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'Decision must be approved or rejected.';
  end if;

  select * into v_suggestion from public.college_suggestions where id = p_id for update;
  if not found then
    raise exception 'That college request no longer exists.';
  end if;

  if p_decision = 'rejected' then
    update public.college_suggestions
       set status = 'rejected',
           status_note = nullif(trim(coalesce(p_note, '')), '')
     where id = p_id;
    perform public.log_staff_action('college_request.rejected', 'college_suggestion', p_id,
      jsonb_build_object('name', v_suggestion.name));
    return null;
  end if;

  -- already in the directory? reuse the row, never duplicate it
  select * into v_existing
  from public.colleges
  where lower(name) = lower(v_suggestion.name)
  order by created_at
  limit 1;

  if v_existing.id is null then
    -- short name: initials, then a name fragment, then a numeric tail until
    -- (short_name, city) is free - the base table's unique key.
    v_short := upper(coalesce(array_to_string(array(
      select left(trim(regexp_replace(part.word, '[^a-zA-Z0-9]', '', 'g')), 1)
      from unnest(string_to_array(v_suggestion.name, ' ')) as part(word)
      where length(trim(regexp_replace(part.word, '[^a-zA-Z0-9]', '', 'g'))) > 0
    ), ''), ''));

    if length(v_short) < 3 then
      v_short := upper(left(regexp_replace(v_suggestion.name, '[^a-zA-Z0-9]', '', 'g'), 6));
    end if;
    v_short := left(coalesce(nullif(v_short, ''), 'COL'), 8);

    while exists (
      select 1 from public.colleges c
      where c.short_name = v_short
        and c.city = coalesce(nullif(trim(v_suggestion.city), ''), 'Pune')
    ) loop
      v_suffix := v_suffix + 1;
      v_short := left(v_short, 6) || v_suffix::text;
    end loop;

    -- slug: readable, unique, nullable-safe
    v_slug := left(btrim(
      regexp_replace(lower(v_suggestion.name), '[^a-z0-9]+', '-', 'g'), '-'), 60);
    if v_slug = '' then
      v_slug := 'college';
    end if;
    while exists (select 1 from public.colleges c where c.slug = v_slug) loop
      v_suffix := v_suffix + 1;
      v_slug := left(v_slug, 54) || '-' || v_suffix::text;
    end loop;

    v_type := nullif(trim(coalesce(v_suggestion.institution_type, '')), '');
    if v_type is not null and v_type not in
       ('university','engineering','polytechnic','pharmacy','management',
        'arts_science','law','design','medical','education','other') then
      v_type := null;
    end if;

    insert into public.colleges (
      name, short_name, city, verified,
      official_name, slug, institution_type, locality, official_website,
      verification_status
    ) values (
      v_suggestion.name,
      v_short,
      coalesce(nullif(trim(v_suggestion.city), ''), 'Pune'),
      coalesce(p_publish, false),
      v_suggestion.name,
      v_slug,
      v_type,
      nullif(trim(coalesce(v_suggestion.locality, '')), ''),
      nullif(trim(coalesce(v_suggestion.official_website, '')), ''),
      case when coalesce(p_publish, false) then 'verified' else 'pending_review' end
    )
    returning * into v_existing;

    v_note := coalesce(nullif(trim(coalesce(p_note, '')), ''), nullif(trim(coalesce(v_suggestion.status_note, '')), ''));
    if v_note is null then
      v_note := case when coalesce(p_publish, false)
        then 'Added from a student request and published.'
        else 'Added from a student request - awaiting verification.' end;
    end if;
  else
    -- reuse path: publishing here promotes the existing row explicitly
    if coalesce(p_publish, false) and v_existing.verification_status <> 'verified' then
      update public.colleges
         set verification_status = 'verified',
             verified = true,
             updated_at = now()
       where id = v_existing.id
       returning * into v_existing;
    end if;
    v_note := coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Matched the existing directory row.');
  end if;

  v_college_id := v_existing.id;

  update public.college_suggestions
     set status = 'approved',
         status_note = v_note
   where id = p_id;

  perform public.log_staff_action('college_request.approved', 'college', v_college_id,
    jsonb_build_object(
      'suggestion_id', p_id,
      'name', v_suggestion.name,
      'short_name', v_existing.short_name,
      'published', coalesce(p_publish, false)
    ));

  return v_college_id;
end;
$$;

revoke all on function public.review_college_suggestion(uuid, text, boolean, text) from public, anon;
grant execute on function public.review_college_suggestion(uuid, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. staff directory counts (the console snapshot was a hand-count of a
--    500-row client read; these are exact, and cheap)
-- ---------------------------------------------------------------------------
create or replace function public.institution_directory_stats()
returns table (
  colleges_total  bigint,
  verified        bigint,
  pending_review  bigint,
  groups          bigint,
  campuses        bigint,
  departments     bigint,
  programs        bigint,
  pending_requests bigint
)
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*) from public.colleges),
    (select count(*) from public.colleges where verification_status = 'verified'),
    (select count(*) from public.colleges where verification_status = 'pending_review'),
    (select count(*) from public.institution_groups),
    (select count(*) from public.campuses),
    (select count(*) from public.departments),
    (select count(*) from public.academic_programs),
    (select count(*) from public.college_suggestions where status = 'pending');
$$;

revoke all on function public.institution_directory_stats() from public;
grant execute on function public.institution_directory_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. search_institutions: multi-word queries (Phase 9 requirement)
--
--    0057 matched the WHOLE query as one substring, so "jspm hadapsar" and
--    "jayawantrao sawant" returned nothing (verified live: both were 0 rows)
--    even though every word exists in the directory. The query is now
--    tokenised: a row matches when EVERY token appears in its searchable text
--    (name, official name, short name, aliases, group, campus name, campus
--    locality, locality), and ranks higher when the full phrase also matches.
--    Single-word behaviour, ranking order, verification rules and the
--    Hadapsar launch boost are unchanged; signature and return shape are
--    identical, so no client change is needed.
-- ---------------------------------------------------------------------------
create or replace function public.search_institutions(p_query text, p_limit int default 25)
returns table (
  id uuid,
  campus_id uuid,
  name text,
  short_name text,
  institution_type text,
  locality text,
  campus_name text,
  campus_locality text,
  group_name text,
  verified boolean,
  rank numeric
)
language sql stable security definer set search_path = ''
as $$
  with q as (
    select
      nullif(trim(coalesce(p_query, '')), '') as raw,
      -- punctuation-stripped form (lowercase FIRST, otherwise the pattern
      -- would eat every capital letter); a query with no latin characters (a
      -- name typed in another script) falls back to its plain lowercase text
      -- so it still searches instead of matching everything
      case
        when regexp_replace(lower(trim(coalesce(p_query, ''))), '[^a-z0-9]+', ' ', 'g') = ''
          then lower(trim(coalesce(p_query, '')))
        else regexp_replace(lower(trim(coalesce(p_query, ''))), '[^a-z0-9]+', ' ', 'g')
      end as term
  ),
  t as (
    select
      q.raw,
      q.term,
      array(select w.word from unnest(string_to_array(q.term, ' ')) as w(word) where length(w.word) > 0) as toks
    from q
  ),
  base as (
    select
      c.id,
      cam.id as campus_id,
      coalesce(c.official_name, c.name) as name,
      c.short_name,
      c.institution_type,
      coalesce(cam.locality, c.locality) as locality,
      cam.name as campus_name,
      cam.locality as campus_locality,
      g.name as group_name,
      (c.verification_status = 'verified')::boolean as verified,
      -- one searchable text per institution: what a student would type,
      -- including that institution's own department names ("computer
      -- engineering hadapsar" must find the Hadapsar engineering college)
      lower(
        coalesce(c.name, '') || ' ' || coalesce(c.short_name, '') || ' '
        || coalesce(c.official_name, '') || ' '
        || coalesce(array_to_string(c.aliases, ' '), '') || ' '
        || coalesce(g.name, '') || ' '
        || coalesce(cam.name, '') || ' ' || coalesce(cam.locality, '') || ' '
        || coalesce(c.locality, '') || ' '
        || coalesce((select string_agg(lower(d.name), ' ') from public.departments d where d.college_id = c.id), '')
      ) as hay
    from t
    join public.colleges c on (
      c.verification_status = 'verified'
      or (t.raw is not null and public.is_admin() and c.verification_status = 'pending_review')
    )
    left join public.campuses cam on cam.id = c.campus_id
    left join public.institution_groups g on g.id = c.institution_group_id
  )
  select
    base.id,
    base.campus_id,
    base.name,
    base.short_name,
    base.institution_type,
    base.locality,
    base.campus_name,
    base.campus_locality,
    base.group_name,
    base.verified,
    (
      case when t.term = '' and base.campus_locality = 'Hadapsar' then 6 else 0 end
      + case when t.term <> '' and lower(base.short_name) = t.term then 100 else 0 end
      + case when t.term <> '' and lower(base.name) = t.term then 100 else 0 end
      + case when t.term <> '' and lower(base.short_name) like t.term || '%' then 60 else 0 end
      + case when t.term <> '' and lower(base.name) like t.term || '%' then 55 else 0 end
      + case when t.term <> '' and base.hay like '%' || t.term || '%' then 50 else 0 end
      + case when t.term <> '' and base.hay like t.term || '%' then 45 else 0 end
      + case when t.term <> '' and coalesce(base.group_name, '') <> ''
              and lower(base.group_name) like '%' || t.term || '%' then 35 else 0 end
      + case when t.term <> '' and coalesce(base.campus_locality, base.locality, '') <> ''
              and lower(coalesce(base.campus_locality, base.locality, '')) like t.term || '%' then 40 else 0 end
      -- every extra word that matches is a better answer than one that does not
      + case when t.term <> '' then (
          select 5 * count(*) from unnest(t.toks) as tok(word) where base.hay like '%' || tok.word || '%'
        ) else 0 end
    )::numeric as rank
  from base cross join t
  where t.term = ''
     or base.hay like '%' || t.term || '%'
     or not exists (
          select 1 from unnest(t.toks) as tok(word) where base.hay not like '%' || tok.word || '%'
        )
  order by rank desc, lower(base.name) asc
  limit coalesce(greatest(p_limit, 1), 25);
$$;

revoke all on function public.search_institutions(text, int) from public;
grant execute on function public.search_institutions(text, int) to anon, authenticated;