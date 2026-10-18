-- =====================================================================
-- 0019 — Marketplace
--
-- A student classifieds: sell / free / exchange / wanted listings,
-- college-scoped or cross-college discovery, saved listings, reports.
-- Follows the established CAMPUS architecture:
--   • every write with authority behind it goes through a security-definer
--     RPC (direct INSERT/UPDATE/DELETE are denied — no policies for them),
--   • RLS select policies mirror what the RPCs enforce,
--   • the seller's college affiliation (self-declared profile college) and
--     the listing's audience scope are two independent concepts,
--   • no payment rails, no reviews, no fake popularity — the only real
--     popularity signal used is saved_listings counts.
-- Additive, reversible: everything is created with if-not-exists guards and
-- can be dropped by removing the tables / columns / functions it adds.
-- =====================================================================

create extension if not exists pgcrypto;

/* ------------------------------------------------------------------ */
/* 1. Tables                                                           */
/* ------------------------------------------------------------------ */

create table if not exists public.marketplace_listings (
  id uuid primary key default gen_random_uuid(),
  slug text not null,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text not null,
  category text not null,
  transaction_type text not null default 'for_sale'
    check (transaction_type in ('for_sale', 'free', 'exchange', 'wanted')),
  condition text
    check (condition is null or condition in ('new', 'like_new', 'good', 'fair', 'parts')),
  brand text,
  model text,
  quantity integer not null default 1 check (quantity between 1 and 999),
  price numeric(12, 2) check (price is null or price >= 0),
  negotiable boolean not null default false,
  budget_max numeric(12, 2) check (budget_max is null or budget_max >= 0),
  exchange_for text,
  exchange_cash boolean not null default false,
  images text[] not null default '{}',
  college_id uuid references public.colleges (id) on delete set null,
  audience text not null default 'college' check (audience in ('college', 'global')),
  handover text not null default 'campus_meetup'
    check (handover in ('campus_meetup', 'public_spot', 'pickup', 'mutual')),
  handover_spot text,
  status text not null default 'active'
    check (status in ('draft', 'active', 'reserved', 'sold', 'archived')),
  moderation_status text not null default 'clean' check (moderation_status in ('clean', 'removed')),
  removed_reason text,
  saved_count integer not null default 0,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint marketplace_images_cap check (coalesce(array_length(images, 1), 0) <= 8)
);

create unique index if not exists marketplace_listings_slug_key
  on public.marketplace_listings (slug);

create index if not exists marketplace_owner_idx on public.marketplace_listings (owner_id);
create index if not exists marketplace_category_idx on public.marketplace_listings (category);
create index if not exists marketplace_audience_idx on public.marketplace_listings (audience, college_id);
create index if not exists marketplace_status_idx on public.marketplace_listings (status, moderation_status);
create index if not exists marketplace_created_idx on public.marketplace_listings (created_at desc);

-- Saved listings: private to each user, one saved record per user+listing.
create table if not exists public.saved_listings (
  user_id uuid not null references public.profiles (id) on delete cascade,
  listing_id uuid not null references public.marketplace_listings (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

/* ------------------------------------------------------------------ */
/* 2. RLS                                                              */
/* ------------------------------------------------------------------ */

alter table public.marketplace_listings enable row level security;
alter table public.saved_listings enable row level security;

-- Reads: owners see their own listings in every state (drafts, sold,
-- removed-for-moderation). Everyone signed-in sees listings that are
-- currently active, not removed, and open to their audience scope.
-- Public browsing is deliberately NOT granted — listing RPCs are granted to
-- authenticated only, so anonymous traffic cannot scrape student listings.
drop policy if exists "marketplace listings readable by scope" on public.marketplace_listings;
create policy "marketplace listings readable by scope" on public.marketplace_listings
  for select to authenticated
  using (
    owner_id = auth.uid()
    or (
      status = 'active'
      and moderation_status = 'clean'
      and (
        audience = 'global'
        or (
          audience = 'college'
          and college_id = (select college_id from public.profiles where id = auth.uid())
        )
      )
    )
  );

-- Writes are RPC-only: no insert/update/delete policies exist, so direct
-- REST mutations (including forged owner_id) are refused with 403, same as
-- the events hardening in 0018a.

drop policy if exists "saved listings are private to their owner" on public.saved_listings;
create policy "saved listings are private to their owner" on public.saved_listings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

/* ------------------------------------------------------------------ */
/* 3. Reports gain listings                                            */
/* ------------------------------------------------------------------ */

alter table public.reports add column if not exists listing_id uuid;

alter table public.reports drop constraint if exists reports_listing_fk;
alter table public.reports
  add constraint reports_listing_fk
  foreign key (listing_id) references public.marketplace_listings (id) on delete cascade;

alter table public.reports drop constraint if exists reports_check;
alter table public.reports add constraint reports_check
  check (post_id is not null or reported_user_id is not null
         or club_id is not null or event_id is not null or listing_id is not null);

create index if not exists reports_listing_idx on public.reports (listing_id);

/* ------------------------------------------------------------------ */
/* 4. Validation (shared by create + update)                           */
/* ------------------------------------------------------------------ */

create or replace function public.assert_listing_payload(
  p_title text,
  p_description text,
  p_category text,
  p_tx_type text,
  p_condition text,
  p_brand text,
  p_model text,
  p_quantity integer,
  p_price numeric,
  p_negotiable boolean,
  p_budget_max numeric,
  p_exchange_for text,
  p_images text[],
  p_audience text,
  p_handover text,
  p_handover_spot text,
  p_college_id uuid,
  p_status text
)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to list an item.';
  end if;
  if p_title is null or length(btrim(p_title)) < 3 or length(btrim(p_title)) > 120 then
    raise exception 'Add a title between 3 and 120 characters.';
  end if;
  if p_description is null or length(btrim(p_description)) < 10 or length(btrim(p_description)) > 4000 then
    raise exception 'Add a full description (10–4000 characters) so buyers know what to expect.';
  end if;
  if p_category is null or p_category not in (
    'Books & Study Materials', 'Electronics', 'Engineering & Lab Equipment',
    'Hostel & Room Essentials', 'Cycles & Mobility', 'Fashion & Accessories',
    'Sports & Fitness', 'Art & Creativity', 'Furniture', 'Free & Exchange', 'Other'
  ) then
    raise exception 'Pick a marketplace category for this item.';
  end if;
  if p_tx_type not in ('for_sale', 'free', 'exchange', 'wanted') then
    raise exception 'Choose what kind of listing this is.';
  end if;
  -- Condition is meaningful for physical items; wanted requests have no item yet.
  if p_tx_type = 'wanted' then
    if p_condition is not null then
      raise exception 'Wanted requests do not have a condition yet.';
    end if;
  else
    if p_condition is null or p_condition not in ('new', 'like_new', 'good', 'fair', 'parts') then
      raise exception 'Pick the item condition.';
    end if;
  end if;
  if p_brand is not null and length(p_brand) > 60 then
    raise exception 'Brand names are at most 60 characters.';
  end if;
  if p_model is not null and length(p_model) > 60 then
    raise exception 'Model names are at most 60 characters.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 999 then
    raise exception 'Quantity must be between 1 and 999.';
  end if;

  if p_tx_type = 'for_sale' then
    if p_price is null or p_price < 0 then
      raise exception 'For-sale listings need an asking price of 0 or more.';
    end if;
  elsif p_tx_type = 'free' then
    if p_price is not null then
      raise exception 'Free listings cannot carry a price.';
    end if;
  elsif p_tx_type = 'exchange' then
    if p_exchange_for is null or length(btrim(p_exchange_for)) < 3 then
      raise exception 'Describe what you would accept in exchange.';
    end if;
    if length(btrim(p_exchange_for)) > 500 then
      raise exception 'Keep the exchange note under 500 characters.';
    end if;
    if p_price is not null then
      raise exception 'Exchange listings cannot carry an asking price.';
    end if;
  else -- wanted
    if p_budget_max is not null and p_budget_max < 0 then
      raise exception 'Budgets cannot be negative.';
    end if;
  end if;

  if p_images is not null and array_length(p_images, 1) > 8 then
    raise exception 'A listing can hold at most 8 images.';
  end if;
  if p_images is not null then
    if exists (
      select 1 from unnest(p_images) as u(img)
      where u.img is null or u.img = '' or length(u.img) > 512
        or u.img !~ '^https?://'
    ) then
      raise exception 'Listing images must be uploaded through CAMPUS.';
    end if;
  end if;

  if p_audience not in ('college', 'global') then
    raise exception 'Choose who this listing reaches.';
  end if;
  if p_handover not in ('campus_meetup', 'public_spot', 'pickup', 'mutual') then
    raise exception 'Choose how the item changes hands.';
  end if;
  if p_handover_spot is not null and length(p_handover_spot) > 160 then
    raise exception 'Keep the meetup hint under 160 characters — never share your home address.';
  end if;

  if p_status not in ('draft', 'active') then
    raise exception 'A new listing starts as a draft or goes live.';
  end if;
end $$;

revoke all on function public.assert_listing_payload from public, anon;
grant execute on function public.assert_listing_payload to authenticated;

/* ------------------------------------------------------------------ */
/* 5. Write RPCs                                                       */
/* ------------------------------------------------------------------ */

-- Create listing (RPC-only write). college_id must be the seller's own
-- self-declared college — the seller can pick the audience, not their
-- college affiliation.
create or replace function public.create_listing(
  p_title text,
  p_description text,
  p_category text,
  p_tx_type text,
  p_condition text default null,
  p_brand text default null,
  p_model text default null,
  p_quantity integer default 1,
  p_price numeric default null,
  p_negotiable boolean default false,
  p_budget_max numeric default null,
  p_exchange_for text default null,
  p_exchange_cash boolean default false,
  p_images text[] default '{}',
  p_audience text default 'college',
  p_handover text default 'campus_meetup',
  p_handover_spot text default null,
  p_status text default 'active'
)
returns text                     -- slug
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_my_college uuid;
  v_slug text;
  v_recent integer;
begin
  perform public.assert_listing_payload(
    p_title, p_description, p_category, p_tx_type, p_condition,
    p_brand, p_model, p_quantity, p_price, p_negotiable,
    p_budget_max, p_exchange_for, p_images, p_audience,
    p_handover, p_handover_spot, null, p_status);

  -- gentle anti-spam: no more than 8 listings in any 10 minute window
  select count(*) into v_recent
    from public.marketplace_listings
    where owner_id = v_me and created_at > now() - interval '10 minutes';
  if v_recent >= 8 then
    raise exception 'You are listing items very quickly — take a short break and try again soon.';
  end if;

  -- duplicate guard: same owner, same title, still live
  if p_status = 'active' and exists (
    select 1 from public.marketplace_listings
    where owner_id = v_me
      and lower(btrim(p_title)) = lower(title)
      and status in ('active', 'reserved', 'draft')
  ) then
    raise exception 'You already have a live listing with this exact title.';
  end if;

  select college_id into v_my_college from public.profiles where id = v_me;
  if p_audience = 'college' and v_my_college is null then
    raise exception 'Set your college on your profile first so classmates can find this listing.';
  end if;

  v_slug := lower(regexp_replace(btrim(p_title), '[^a-z0-9]+', '-', 'gi'));
  v_slug := regexp_replace(v_slug, '^-+|-+$', '', 'g');
  if v_slug = '' or v_slug is null then v_slug := 'listing'; end if;
  v_slug := left(v_slug, 60) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.marketplace_listings (
    slug, owner_id, title, description, category, transaction_type,
    condition, brand, model, quantity, price, negotiable,
    budget_max, exchange_for, exchange_cash, images,
    college_id, audience, handover, handover_spot, status,
    published_at
  ) values (
    v_slug, v_me, btrim(p_title), btrim(p_description), p_category, p_tx_type,
    p_condition, p_brand, p_model, p_quantity,
    case when p_tx_type = 'for_sale' then p_price else null end,
    coalesce(p_negotiable, false),
    case when p_tx_type = 'wanted' then p_budget_max else null end,
    case when p_tx_type = 'exchange' then btrim(p_exchange_for) else null end,
    coalesce(p_exchange_cash, false), coalesce(p_images, '{}'),
    v_my_college, p_audience, p_handover, p_handover_spot, p_status,
    case when p_status = 'active' then now() else null end
  );

  return v_slug;
end $$;

revoke all on function public.create_listing from public, anon;
grant execute on function public.create_listing to authenticated;

-- Edit listing — owner only, never moderation-blocked fields.
create or replace function public.update_listing(
  p_id uuid,
  p_title text,
  p_description text,
  p_category text,
  p_tx_type text,
  p_condition text default null,
  p_brand text default null,
  p_model text default null,
  p_quantity integer default 1,
  p_price numeric default null,
  p_negotiable boolean default false,
  p_budget_max numeric default null,
  p_exchange_for text default null,
  p_exchange_cash boolean default false,
  p_images text[] default '{}',
  p_audience text default 'college',
  p_handover text default 'campus_meetup',
  p_handover_spot text default null
)
returns text                    -- (possibly unchanged) slug
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_row public.marketplace_listings;
  v_my_college uuid;
begin
  if v_me is null then raise exception 'Sign in to edit your listings.'; end if;
  if p_id is null then raise exception 'Choose a listing to edit.'; end if;

  select * into v_row from public.marketplace_listings
    where id = p_id and owner_id = v_me;
  if v_row.id is null then raise exception 'You can only edit your own listings.'; end if;
  if v_row.status in ('sold', 'archived') then
    raise exception 'Reopen this listing before editing it.';
  end if;

  perform public.assert_listing_payload(
    p_title, p_description, p_category, p_tx_type, p_condition,
    p_brand, p_model, p_quantity, p_price, p_negotiable,
    p_budget_max, p_exchange_for, p_images, p_audience,
    p_handover, p_handover_spot, null, 'active');

  select college_id into v_my_college from public.profiles where id = v_me;
  if p_audience = 'college' and v_my_college is null then
    raise exception 'Set your college on your profile first so classmates can find this listing.';
  end if;

  update public.marketplace_listings set
    title = btrim(p_title),
    description = btrim(p_description),
    category = p_category,
    transaction_type = p_tx_type,
    condition = p_condition,
    brand = p_brand,
    model = p_model,
    quantity = p_quantity,
    price = case when p_tx_type = 'for_sale' then p_price else null end,
    negotiable = coalesce(p_negotiable, false),
    budget_max = case when p_tx_type = 'wanted' then p_budget_max else null end,
    exchange_for = case when p_tx_type = 'exchange' then btrim(p_exchange_for) else null end,
    exchange_cash = coalesce(p_exchange_cash, false),
    images = coalesce(p_images, '{}'),
    audience = p_audience,
    handover = p_handover,
    handover_spot = p_handover_spot,
    updated_at = now()
  where id = v_row.id;

  return v_row.slug;
end $$;

revoke all on function public.update_listing from public, anon;
grant execute on function public.update_listing to authenticated;

-- Lifecycle transitions — owner only. Keeps a single controlled status enum
-- (draft → active ⇄ reserved → sold, plus archive anywhere) and never mixes
-- moderation state into it.
create or replace function public.set_listing_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.marketplace_listings;
begin
  if auth.uid() is null then raise exception 'Sign in to manage your listings.'; end if;
  if p_id is null then raise exception 'Choose a listing to update.'; end if;

  select * into v_row from public.marketplace_listings where id = p_id and owner_id = auth.uid();
  if v_row.id is null then raise exception 'You can only manage your own listings.'; end if;
  if v_row.moderation_status = 'removed' then
    raise exception 'This listing was removed by moderation and cannot be changed.';
  end if;

  if v_row.status = 'draft' and p_status = 'active' then
    update public.marketplace_listings
      set status = 'active', published_at = now(), updated_at = now()
      where id = v_row.id;
  elsif v_row.status = 'active' and p_status in ('reserved', 'sold', 'archived', 'draft') then
    update public.marketplace_listings
      set status = p_status, updated_at = now() where id = v_row.id;
  elsif v_row.status = 'reserved' and p_status in ('active', 'sold', 'archived') then
    update public.marketplace_listings set status = p_status, updated_at = now()
      where id = v_row.id;
  elsif v_row.status = 'sold' and p_status in ('active', 'archived') then
    update public.marketplace_listings set status = p_status, updated_at = now()
      where id = v_row.id;
  elsif v_row.status = 'archived' and p_status = 'active' then
    update public.marketplace_listings set status = 'active', updated_at = now()
      where id = v_row.id;
  else
    raise exception 'That status change is not allowed (from % to %).', v_row.status, p_status;
  end if;
end $$;

revoke all on function public.set_listing_status from public, anon;
grant execute on function public.set_listing_status to authenticated;

-- Owner deletes a listing permanently (saves + reports cascade with it;
-- uploaded media files stay in the media bucket, as with every other
-- CAMPUS feature that embeds public media URLs).
create or replace function public.delete_listing(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in to manage your listings.'; end if;
  delete from public.marketplace_listings
    where id = p_id and owner_id = auth.uid() and moderation_status = 'clean';
  if not found then
    raise exception 'This listing cannot be deleted (it may belong to someone else or was removed by moderation).';
  end if;
end $$;

revoke all on function public.delete_listing from public, anon;
grant execute on function public.delete_listing to authenticated;

-- Toggle a save. server-side saved_count stays truthful.
create or replace function public.toggle_saved_listing(p_listing uuid)
returns boolean                  -- true = now saved
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Sign in to save listings.'; end if;
  if p_listing is null then raise exception 'Choose a listing to save.'; end if;

  delete from public.saved_listings where user_id = v_me and listing_id = p_listing;
  if found then return false; end if;

  if not exists (
    select 1 from public.marketplace_listings l
    where l.id = p_listing
      and l.moderation_status = 'clean'
      and (l.owner_id = v_me or (
        l.status in ('active', 'sold')
        and (l.audience = 'global'
             or (l.audience = 'college'
                 and l.college_id = (select college_id from public.profiles where id = v_me))))
  )) then
    raise exception 'That listing is not available to save.';
  end if;

  insert into public.saved_listings (user_id, listing_id) values (v_me, p_listing);
  return true;
end $$;

revoke all on function public.toggle_saved_listing from public, anon;
grant execute on function public.toggle_saved_listing to authenticated;

-- Report a listing (same reports table as posts/communities/events).
create or replace function public.report_listing(
  p_listing uuid,
  p_reason text,
  p_details text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'Sign in to report a listing.'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Pick a reason for the report.';
  end if;
  insert into public.reports (reporter_id, listing_id, reason, details)
    values (v_me, p_listing, btrim(p_reason), nullif(btrim(coalesce(p_details, '')), ''));
end $$;

revoke all on function public.report_listing from public, anon;
grant execute on function public.report_listing to authenticated;

-- Platform moderation (profiles.role = 'admin' via existing is_admin()).
create or replace function public.set_listing_moderation(
  p_listing uuid,
  p_removed boolean,
  p_reason text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  if not public.is_admin() then
    raise exception 'Only CAMPUS moderators can do that.';
  end if;
  if p_listing is null then raise exception 'Choose a listing.'; end if;

  select owner_id into v_owner from public.marketplace_listings where id = p_listing;
  if v_owner is null then raise exception 'That listing does not exist.'; end if;

  if p_removed then
    if p_reason is null or length(btrim(p_reason)) < 3 then
      raise exception 'Tell the seller why this listing was removed.';
    end if;
    update public.marketplace_listings
      set moderation_status = 'removed',
          removed_reason = btrim(p_reason),
          status = case when status = 'active' then 'archived' else status end,
          updated_at = now()
      where id = p_listing;
    perform public.notify_member(v_owner, auth.uid(), 'listing_removed', 'listing', p_listing);
  else
    update public.marketplace_listings
      set moderation_status = 'clean',
          removed_reason = null,
          status = case when status = 'archived' then 'active' else status end,
          updated_at = now()
      where id = p_listing;
    perform public.notify_member(v_owner, auth.uid(), 'listing_restored', 'listing', p_listing);
  end if;
end $$;

revoke all on function public.set_listing_moderation from public, anon;
grant execute on function public.set_listing_moderation to authenticated;

/* ------------------------------------------------------------------ */
/* 6. Discovery RPCs                                                   */
/* ------------------------------------------------------------------ */

-- saved_count is a truthful, trigger-maintained mirror of saved_listings;
-- it is the ONLY real popularity metric marketplace uses.
create or replace function public.refresh_saved_count()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_listing uuid := coalesce(new.listing_id, old.listing_id);
begin
  update public.marketplace_listings
    set saved_count = (select count(*) from public.saved_listings where listing_id = v_listing)
    where id = v_listing;
  return null;
end $$;

drop trigger if exists saved_listings_count_trigger on public.saved_listings;
create trigger saved_listings_count_trigger
  after insert or delete on public.saved_listings
  for each row execute function public.refresh_saved_count();

-- list_listings — the single discovery RPC for every marketplace tab:
--   p_mode   discover | global | mycollege | mine | saved
--   p_sort   recommended (newest live) | new | price_asc | price_desc | saved
--   p_scope  (discover only) all | mine_only | beyond
--   p_status (mine only)     all | active | draft | reserved | sold | archived
-- "Popular" is sort=saved on the one real popularity metric there is —
-- saved_listings counts. "Nearby" is intentionally omitted (CAMPUS has no
-- reliable location feature); college-scoped discovery carries the location
-- meaning instead.
create or replace function public.list_listings(
  p_mode text default 'discover',
  p_query text default null,
  p_category text default null,
  p_tx_type text default null,
  p_condition text default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_college uuid default null,
  p_scope text default 'all',
  p_sort text default 'recommended',
  p_status text default 'all',
  p_limit integer default 24,
  p_offset integer default 0
)
returns table (
  id uuid,
  slug text,
  title text,
  description_lead text,
  category text,
  transaction_type text,
  condition text,
  brand text,
  model text,
  quantity integer,
  price numeric,
  negotiable boolean,
  budget_max numeric,
  exchange_for text,
  images text[],
  college_name text,
  audience text,
  handover text,
  status text,
  moderation_status text,
  saved_count integer,
  saved_by_me boolean,
  is_mine boolean,
  owner_id uuid,
  owner_name text,
  owner_username text,
  owner_avatar text,
  owner_verified boolean,
  owner_college text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql security definer set search_path = public stable as $$
  with me as (
    select id, college_id as my_college from public.profiles where id = auth.uid()
  ),
  base as (
    select
      l.*,
      co.name as college_name,
      me.my_college,
      me.id as me_id,
      exists (
        select 1 from public.saved_listings s
        where s.listing_id = l.id and s.user_id = auth.uid()
      ) as saved_by_me,
      p.display_name as owner_name,
      coalesce(p.username, '') as owner_username,
      p.avatar_url as owner_avatar,
      coalesce(p.is_verified, false) as owner_verified,
      oc.name as owner_college
    from public.marketplace_listings l
    left join public.colleges co on co.id = l.college_id
    left join public.profiles p on p.id = l.owner_id
    left join public.colleges oc on oc.id = p.college_id
    cross join me
  ),
  visible as (
    select * from base
    where
      -- visibility mirrors the RLS select policy (owners see everything of
      -- their own ONLY in mine mode; signed-in users see live, un-removed
      -- listings inside their audience scope)
      (
        (p_mode = 'mine' and owner_id = me_id)
        or (
          p_mode <> 'mine'
          and moderation_status = 'clean'
          and status in ('active', 'sold')
          and (audience = 'global'
               or (audience = 'college' and college_id = my_college))
        )
      )
      -- mode filters
      and (
        case p_mode
          when 'mycollege' then audience = 'college' and college_id = my_college
          when 'global'    then audience = 'global'
          when 'saved'     then saved_by_me
          else true -- discover
        end
      )
      and (p_mode <> 'discover'
           or case p_scope
                when 'mine_only' then (audience = 'college' and college_id = my_college)
                when 'beyond'    then audience = 'global'
                else true
              end)
      and (p_mode <> 'mine' or p_status = 'all' or status = p_status)
      -- search across title, description, brand/model, category, exchange
      -- note and seller name (sellers are public profiles here)
      and (p_query is null or p_query = '' or (
        title ilike '%' || p_query || '%'
        or description ilike '%' || p_query || '%'
        or coalesce(brand, '')   ilike '%' || p_query || '%'
        or coalesce(model, '')   ilike '%' || p_query || '%'
        or category              ilike '%' || p_query || '%'
        or coalesce(exchange_for, '') ilike '%' || p_query || '%'
        or coalesce(owner_name, '')   ilike '%' || p_query || '%'
      ))
      -- "free" collects both tx=free posts and the Free & Exchange category
      and (
        case
          when p_tx_type = 'free'
            then (transaction_type = 'free' or category = 'Free & Exchange')
          when p_tx_type is not null and p_tx_type <> ''
            then transaction_type = p_tx_type
          else true
        end
      )
      and (p_category is null or p_category = '' or category = p_category)
      and (p_condition is null or p_condition = '' or condition = p_condition)
      and (p_college is null or college_id = p_college)
      and (p_min_price is null or (price is not null and price >= p_min_price))
      and (p_max_price is null or (price is not null and price <= p_max_price))
  )
  select
    v.id, v.slug, v.title,
    left(v.description, 140),
    v.category, v.transaction_type, v.condition, v.brand, v.model, v.quantity,
    v.price, v.negotiable, v.budget_max, v.exchange_for, v.images,
    coalesce(v.college_name, case when v.audience = 'global' then 'All colleges' end),
    v.audience, v.handover, v.status, v.moderation_status, v.saved_count,
    v.saved_by_me, (v.owner_id = v.me_id),
    v.owner_id, v.owner_name, v.owner_username, v.owner_avatar,
    v.owner_verified, v.owner_college,
    v.created_at, v.updated_at
  from visible v
  order by
    case when p_sort = 'price_asc'  then v.price end asc nulls last,
    case when p_sort = 'price_desc' then v.price end desc nulls last,
    case when p_sort = 'saved'      then v.saved_count end desc,
    v.created_at desc              -- recommended + new: newest live first
  limit least(coalesce(p_limit, 24), 48)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_listings from public, anon;
grant execute on function public.list_listings to authenticated;

-- listing_detail: full row + owner card + my relation + manage permission.
-- Ownership also resolves moderation notices for the owner.
create or replace function public.listing_detail(p_slug text)
returns table (
  id uuid,
  slug text,
  owner_id uuid,
  title text,
  description text,
  category text,
  transaction_type text,
  condition text,
  brand text,
  model text,
  quantity integer,
  price numeric,
  negotiable boolean,
  budget_max numeric,
  exchange_for text,
  exchange_cash boolean,
  images text[],
  college_id uuid,
  college_name text,
  audience text,
  handover text,
  handover_spot text,
  status text,
  moderation_status text,
  removed_reason text,
  saved_count integer,
  saved_by_me boolean,
  is_mine boolean,
  owner_name text,
  owner_username text,
  owner_avatar text,
  owner_verified boolean,
  owner_college text,
  created_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz
)
language sql security definer set search_path = public stable as $$
  select
    l.id, l.slug, l.owner_id, l.title, l.description, l.category,
    l.transaction_type, l.condition, l.brand, l.model, l.quantity,
    l.price, l.negotiable, l.budget_max, l.exchange_for, l.exchange_cash,
    l.images, l.college_id, co.name as college_name, l.audience, l.handover,
    l.handover_spot, l.status, l.moderation_status, l.removed_reason,
    l.saved_count,
    exists (select 1 from public.saved_listings s
              where s.listing_id = l.id and s.user_id = auth.uid()),
    (l.owner_id = auth.uid()),
    p.display_name, coalesce(p.username, ''), p.avatar_url,
    coalesce(p.is_verified, false), poc.name,
    l.created_at, l.published_at, l.updated_at
  from public.marketplace_listings l
  left join public.profiles p on p.id = l.owner_id
  left join public.colleges co on co.id = l.college_id
  left join public.colleges poc on poc.id = p.college_id
  where l.slug = p_slug
    and auth.uid() is not null
    and (
      l.owner_id = auth.uid()
      or (l.moderation_status = 'clean' and l.status in ('active', 'sold')
          and (l.audience = 'global'
               or (l.audience = 'college'
                   and l.college_id = (select college_id from public.profiles where id = auth.uid()))))
    );
$$;

revoke all on function public.listing_detail from public, anon;
grant execute on function public.listing_detail to authenticated;
