-- =====================================================================
-- 0007 — Search: find members by name/@username and posts by text
--   search_members(p_query): real profiles (self excluded); includes
--     private profiles — being findable is not the same as being browsable.
--   search_posts(p_query): published posts whose body matches; anonymous
--     confessions keep their author hidden exactly like the feed RPC.
-- Both are SECURITY DEFINER with an explicit search_path and single-column
-- outputs, so nothing here depends on table RLS being looser than intended.
-- =====================================================================

create or replace function public.search_members(
  p_query text,
  p_limit integer default 10
)
returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  college_short_name text,
  is_private boolean
)
language sql stable security definer set search_path = '' as $$
  select
    pr.id,
    pr.username,
    pr.display_name,
    pr.avatar_url,
    c.short_name,
    pr.is_private
  from public.profiles pr
  left join public.colleges c on c.id = pr.college_id
  where btrim(p_query) <> ''
    and (
      pr.display_name ilike '%' || btrim(p_query) || '%'
      or pr.username ilike '%' || btrim(p_query) || '%'
      or pr.first_name ilike '%' || btrim(p_query) || '%'
      or pr.last_name ilike '%' || btrim(p_query) || '%'
    )
    and pr.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  order by pr.display_name asc nulls last
  limit least(greatest(coalesce(p_limit, 10), 1), 25)
$$;

revoke all on function public.search_members(text, integer) from public;
grant execute on function public.search_members(text, integer) to anon, authenticated;

create or replace function public.search_posts(
  p_query text,
  p_limit integer default 10
)
returns table (
  id uuid,
  body text,
  kind public.post_kind,
  media_urls text[],
  is_anonymous boolean,
  created_at timestamptz,
  edited_at timestamptz,
  author_id uuid,
  author_display_name text,
  author_username text,
  author_avatar_url text,
  college_id uuid,
  college_short_name text,
  like_count bigint,
  comment_count bigint,
  liked_by_me boolean
)
language sql stable security definer set search_path = '' as $$
  select
    p.id,
    p.body,
    p.kind,
    p.media_urls,
    p.is_anonymous,
    p.created_at,
    p.edited_at,
    case when p.is_anonymous then null else p.author_id end,
    case when p.is_anonymous then null else pr.display_name end,
    case when p.is_anonymous then null else pr.username end,
    case when p.is_anonymous then null else pr.avatar_url end,
    p.college_id,
    c.short_name,
    (select count(*) from public.post_likes l where l.post_id = p.id),
    (select count(*) from public.post_comments cc where cc.post_id = p.id),
    coalesce(
      (select true from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
      false
    )
  from public.posts p
  left join public.profiles pr on pr.id = p.author_id
  left join public.colleges c on c.id = p.college_id
  where p.is_published = true
    and (
      p.body ilike '%' || btrim(p_query) || '%'
      -- posts revolving around the keyword include named authors' posts
      or (
        btrim(p_query) <> ''
        and p.is_anonymous = false
        and (
          pr.display_name ilike '%' || btrim(p_query) || '%'
          or pr.username ilike '%' || btrim(p_query) || '%'
        )
      )
    )
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 10), 1), 25)
$$;

revoke all on function public.search_posts(text, integer) from public;
grant execute on function public.search_posts(text, integer) to anon, authenticated;
