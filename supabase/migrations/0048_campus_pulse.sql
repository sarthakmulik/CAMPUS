-- =============================================================================
-- 0048 — CAMPUS PULSE
-- A campus-wide daily check-in + relatable statements + personality quizzes,
-- driven by a deterministic local engine (no external AI APIs, no fake data).
--
-- Design contracts baked into this migration:
--   · NOTHING is client-writable except through RPCs. Direct table access is
--     read-gated (content) or fully closed (participation); every write path
--     validates, scopes and normalizes server-side in SECURITY DEFINER code.
--   · One daily question per scope per day is enforced by a UNIQUE EXPRESSION
--     index ((coalesce(college_id,'platform-uuid'), publish_date)) — the
--     idempotency key that makes publication race-free without a scheduler.
--   · One vote per user per instance = UNIQUE(instance_id, user_id).
--   · Reaction changes happen in place = PRIMARY KEY(statement_id, user_id).
--   · Private responses are never readable by other members: pulse_responses
--     has NO select policy for anyone (even self reads through RPCs only).
--   · Aggregates are threshold-gated (min 10 responses by default, from
--     pulse_config) and can never be forged — clients only see RPC output.
--   · Campus day = Asia/Kolkata (the app's home timezone, SPPU/Pune based).
--   · Staff administration gates on public.has_op('pulse.admin') (0043) and
--     writes staff audit trails through log_staff_action() (0043).
--
-- All functions are idempotent-safe to re-run (drop-if-exists / create).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Content library (questions + statements + quizzes, admin-approved only)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_items (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('question','statement','quiz')),
  category     text not null,                 -- rotation axis (campus_life, exams, food, hostel, commute, fests)
  body         text not null check (char_length(btrim(body)) between 6 and 300),
  options      jsonb,                         -- questions: [{emoji,label}] in order; null for statements/quiz titles
  version      smallint not null default 1,   -- quiz version bump = historical attempt results stay valid
  status       text not null default 'draft' check (status in ('draft','approved','paused','rejected')),
  evergreen    boolean not null default false,
  valid_until  timestamptz,                   -- optional retirement / expiry
  created_by   uuid references public.profiles(id) on delete set null,
  approved_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists pulse_items_kind_status_idx on public.pulse_items (kind, status);

alter table public.pulse_items enable row level security;

-- Content is public once approved; staff also see drafts for administration.
-- No insert/update/delete policies exist: content enters ONLY through admin RPCs.
drop policy if exists pulse_items_select on public.pulse_items;
create policy pulse_items_select on public.pulse_items
  for select using (status = 'approved' or public.is_staff());

-- ---------------------------------------------------------------------------
-- 1b. Statement reporting — reuses the platform reports queue, following the
-- exact precedent of events (0018) and listings (0019): a dedicated nullable
-- target column, an updated reports_check constraint, an index, and a
-- rate-limited RPC. The staff Moderation tab already renders reports.
-- ---------------------------------------------------------------------------
alter table public.reports add column if not exists pulse_item_id
  uuid references public.pulse_items(id) on delete cascade;
create index if not exists reports_pulse_item_idx on public.reports (pulse_item_id);

alter table public.reports drop constraint if exists reports_check;
alter table public.reports add constraint reports_check
  check (post_id is not null or reported_user_id is not null
         or club_id is not null or event_id is not null
         or listing_id is not null or pulse_item_id is not null);

create or replace function public.pulse_report_statement(
  p_statement uuid, p_reason text, p_details text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_recent integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to report content.';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'Please choose a reason.';
  end if;
  if not exists (select 1 from public.pulse_items t
                  where t.id = p_statement and t.kind = 'statement') then
    raise exception 'That statement is not available.';
  end if;

  select count(*) into v_recent
    from public.reports
   where reporter_id = auth.uid()
     and created_at > now() - interval '24 hours';
  if v_recent >= 20 then
    raise exception 'You have reached today''s report limit. Thanks for helping keep CAMPUS safe.';
  end if;

  insert into public.reports (reporter_id, pulse_item_id, reason, details)
  values (auth.uid(), p_statement, trim(p_reason), nullif(trim(coalesce(p_details, '')), ''))
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Quiz structure (questions + deterministic result space)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_quiz_questions (
  id       uuid primary key default gen_random_uuid(),
  quiz_id  uuid not null references public.pulse_items(id) on delete cascade,
  position smallint not null check (position between 1 and 12),
  prompt   text not null,
  options  jsonb not null,     -- [{text, trait}] trait = index into the quiz result space
  unique (quiz_id, position)
);

create table if not exists public.pulse_quiz_results (
  quiz_id    uuid not null references public.pulse_items(id) on delete cascade,
  result_key smallint not null check (result_key >= 0),
  label      text not null,
  emoji      text not null,
  blurb      text not null,
  primary key (quiz_id, result_key)
);

alter table public.pulse_quiz_questions enable row level security;
alter table public.pulse_quiz_results   enable row level security;

drop policy if exists pulse_quiz_q_select on public.pulse_quiz_questions;
create policy pulse_quiz_q_select on public.pulse_quiz_questions
  for select using (
    exists (select 1 from public.pulse_items i
             where i.id = quiz_id and (i.status = 'approved' or public.is_staff()))
  );
drop policy if exists pulse_quiz_r_select on public.pulse_quiz_results;
create policy pulse_quiz_r_select on public.pulse_quiz_results
  for select using (
    exists (select 1 from public.pulse_items i
             where i.id = quiz_id and (i.status = 'approved' or public.is_staff()))
  );

-- ---------------------------------------------------------------------------
-- 3. Daily instances (published questions per scope per day)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_instances (
  id           uuid primary key default gen_random_uuid(),
  college_id   uuid references public.colleges(id) on delete cascade, -- null = platform-wide
  publish_date date not null,
  content_id   uuid not null references public.pulse_items(id) on delete restrict,
  status       text not null default 'published' check (status in ('published','closed','archived')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

-- The publication idempotency key: platform (null college) uses a sentinel uuid
-- so expression coverage is identical for every row (version-proof unique).
create unique index if not exists pulse_instances_scope_day_uq
  on public.pulse_instances (coalesce(college_id, '00000000-0000-0000-0000-000000000000'::uuid), publish_date);
create index if not exists pulse_instances_content_idx on public.pulse_instances (content_id);
create index if not exists pulse_instances_recent_idx on public.pulse_instances
  (coalesce(college_id, '00000000-0000-0000-0000-000000000000'::uuid), publish_date desc);

alter table public.pulse_instances enable row level security;

-- Members see today's published instance only through the RPC; direct access
-- stays staff-only (drafts/schedule inspection).
drop policy if exists pulse_instances_staff_select on public.pulse_instances;
create policy pulse_instances_staff_select on public.pulse_instances
  for select using (public.is_staff());

-- ---------------------------------------------------------------------------
-- 4. Participation (private)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_responses (
  id           uuid primary key default gen_random_uuid(),
  instance_id  uuid not null references public.pulse_instances(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  option_index smallint not null check (option_index >= 0),
  created_at   timestamptz not null default now(),
  unique (instance_id, user_id)  -- DB-enforced duplicate-vote protection
);
create index if not exists pulse_responses_user_idx on public.pulse_responses (user_id, created_at desc);
create index if not exists pulse_responses_instance_idx on public.pulse_responses (instance_id, option_index);

create table if not exists public.pulse_skips (
  instance_id uuid not null references public.pulse_instances(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (instance_id, user_id)   -- one skip vote per user per question
);

alter table public.pulse_responses enable row level security;
alter table public.pulse_skips     enable row level security;

-- NO select policies on purpose: responses/skips belong exclusively to the
-- RPC layer. A member can WRITE their own row and never read anyone's,
-- including their own raw rows outside the product surfaces.
drop policy if exists pulse_responses_own_insert on public.pulse_responses;
create policy pulse_responses_own_insert on public.pulse_responses
  for insert with check (user_id = auth.uid());
-- Note: writes still only happen inside the gated RPC (pulse_vote) to keep
-- validity checks server-side; this policy is the backstop, not the door.

drop policy if exists pulse_skips_own_insert on public.pulse_skips;
create policy pulse_skips_own_insert on public.pulse_skips
  for insert with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. Statement reactions (changeable, one per user per statement)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_reactions (
  statement_id uuid not null references public.pulse_items(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  reaction     smallint not null check (reaction between 0 and 2), -- 0 same · 1 too_real · 2 not_me
  college_id   uuid references public.colleges(id) on delete set null, -- set server-side for scoped insights
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (statement_id, user_id)   -- upsert = reaction changes, never duplicates
);
create index if not exists pulse_reactions_recent_idx on public.pulse_reactions (statement_id, updated_at desc);

alter table public.pulse_reactions enable row level security;

drop policy if exists pulse_reactions_own_insert on public.pulse_reactions;
create policy pulse_reactions_own_insert on public.pulse_reactions
  for insert with check (user_id = auth.uid());
drop policy if exists pulse_reactions_own_update on public.pulse_reactions;
create policy pulse_reactions_own_update on public.pulse_reactions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists pulse_reactions_own_delete on public.pulse_reactions;
create policy pulse_reactions_own_delete on public.pulse_reactions
  for delete using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 6. Quiz attempts (versioned, historical results stay meaningful)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_attempts (
  id         uuid primary key default gen_random_uuid(),
  quiz_id    uuid not null references public.pulse_items(id) on delete cascade,
  version    smallint not null,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  answers    jsonb not null,               -- array of chosen option indices, validated server-side
  result_key smallint not null,
  created_at timestamptz not null default now(),
  unique (user_id, quiz_id, version)       -- retakes replace the result for the same version
);

alter table public.pulse_attempts enable row level security;
drop policy if exists pulse_attempts_own_select on public.pulse_attempts;
create policy pulse_attempts_own_select on public.pulse_attempts
  for select using (user_id = auth.uid());
-- (writes go through pulse_quiz_submit, which re-scores server-side — clients
--  can never store an unearned result key)

-- ---------------------------------------------------------------------------
-- 7. Engine configuration (versioned, admin-adjustable, mirrored in TS)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.pulse_config enable row level security;
drop policy if exists pulse_config_staff_select on public.pulse_config;
create policy pulse_config_staff_select on public.pulse_config
  for select using (public.is_staff());

-- eslint-style guard: numeric + jsonb config accessors (safe defaults inside)
create or replace function public.pulse_cfg(p_key text, p_default numeric)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select coalesce((select (c.value #>> '{}')::numeric
                     from public.pulse_config c
                    where c.key = p_key), p_default);
$$;

create or replace function public.pulse_cfg_json(p_key text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select (select c.value from public.pulse_config c where c.key = p_key);
$$;

-- ---------------------------------------------------------------------------
-- 8. Timezone + statistics helpers
-- ---------------------------------------------------------------------------

-- The campus day and its end-of-day moment (the daily question's expiry).
create or replace function public.pulse_campus_day()
returns date
language sql stable security definer set search_path = ''
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

create or replace function public.pulse_campus_day_end(p_date date default public.pulse_campus_day())
returns timestamptz
language sql stable security definer set search_path = ''
as $$ select (p_date + 1)::timestamp at time zone 'Asia/Kolkata' $$;

-- Wilson score LOWER bound (documented uncertainty method for proportions).
-- z = 1.645 → one-sided 95%. Used where insight copy claims "at least X%".
create or replace function public.pulse_wilson_lb(p_success numeric, p_total numeric, p_z numeric default 1.645)
returns numeric
language sql immutable
as $$
  with s as (select p_success, p_total, p_z,
                    case when p_total <= 0 then 0 else (p_success / p_total) end as phat)
  select case
           when p_total <= 0 or s.p_z is null or s.p_z <= 0 then 0
           else greatest(0, (s.phat + s.p_z * s.p_z / (2 * s.p_total)
             - s.p_z * sqrt((s.phat * (1 - s.phat) + s.p_z * s.p_z / (4 * s.p_total)) / s.p_total))
             / (1 + s.p_z * s.p_z / s.p_total))
         end
  from s;
$$;

-- ---------------------------------------------------------------------------
-- 9. Milestones (server-verified, never client-awarded)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_milestones (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  milestone_key text not null check (milestone_key in
    ('first_pulse','streak_3','campus_voice','challenge_participant')),
  awarded_at    timestamptz not null default now(),
  primary key (user_id, milestone_key)
);
alter table public.pulse_milestones enable row level security;
drop policy if exists pulse_milestones_own_select on public.pulse_milestones;
create policy pulse_milestones_own_select on public.pulse_milestones
  for select using (user_id = auth.uid());
-- (inserts happen only inside the definer RPCs after the qualifying action)

-- ---------------------------------------------------------------------------
-- 10. Insight snapshots (cached aggregates) + job runs (operational log)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_insights (
  id          uuid primary key default gen_random_uuid(),
  college_id  uuid references public.colleges(id) on delete cascade, -- null = platform
  insight_key text not null,
  scope_date  date not null,
  payload     jsonb not null,
  sample_size integer not null check (sample_size >= 0),
  valid_until timestamptz not null,
  computed_at timestamptz not null default now()
);
-- the snapshot idempotency key (one payload per scope/day/insight key) —
-- expression form, same pattern as pulse_instances_scope_day_uq above
alter table public.pulse_insights drop constraint if exists pulse_insights_snapshot_uq;
create unique index if not exists pulse_insights_snapshot_uq
  on public.pulse_insights (coalesce(college_id, '00000000-0000-0000-0000-000000000000'::uuid), insight_key, scope_date);
alter table public.pulse_insights enable row level security;
drop policy if exists pulse_insights_select on public.pulse_insights;
create policy pulse_insights_select on public.pulse_insights
  for select using (true);
-- (writing happens only inside pulse_insights_refresh — PostgREST callers
--  bypass nothing: no insert/update policy exists)

create table if not exists public.pulse_job_runs (
  id        uuid primary key default gen_random_uuid(),
  job_key   text not null,
  idem_key  text not null,                     -- the idempotency key (job + scope + date)
  ok        boolean not null,
  detail    jsonb not null default '{}'::jsonb,
  ran_at    timestamptz not null default now(),
  unique (job_key, idem_key)
);
alter table public.pulse_job_runs enable row level security;
drop policy if exists pulse_job_runs_staff_select on public.pulse_job_runs;
create policy pulse_job_runs_staff_select on public.pulse_job_runs
  for select using (public.is_staff());

-- Job-run logger (used by the lazy publisher + the cron companion).
create or replace function public.pulse_log_job(p_job text, p_idem text, p_ok boolean, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.pulse_job_runs (job_key, idem_key, ok, detail)
  values (p_job, p_idem, p_ok, p_detail)
  on conflict (job_key, idem_key) do nothing;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Scope resolution (server-side; clients cannot spoof college scope)
-- ---------------------------------------------------------------------------
create or replace function public.pulse_scope_of(p_college uuid default null)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_college uuid;
begin
  select pr.college_id into v_college
    from public.profiles pr
   where pr.id = auth.uid();
  if v_college is not null then
    return v_college;               -- members are ALWAYS scoped to their own college
  end if;
  -- staff may preview an explicit college; without one they run platform-wide
  if public.is_staff() then
    return p_college;
  end if;
  return null;
end $$;

-- ===========================================================================
-- 12. THE INTELLIGENCE ENGINE (server-authoritative selection)
-- ===========================================================================
-- Deterministic weighted model (0048 spec):
--   score = 0.30*relevance + 0.25*quality + 0.20*freshness + 0.15*engagement + 0.10*diversity
-- Weights live in pulse_config and mirror src/lib/pulse/config.ts.
--
-- Hard constraints implemented below:
--   approved only · not expired/retired · recency exclusion (14 days per scope)
--   category diversity (de-prioritize the previous day's category)
--   participation-based engagement (responses vs skips, smoothed; NO impression
--   data exists → no pretend exposure adjustment, documented limitation)
--   deterministic seeded tie-break (stable within a day, rotates across days)
-- ===========================================================================

create or replace function public.pulse_pick_daily(p_scope uuid, p_date date)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_weight_rel   numeric := public.pulse_cfg('pulse.weight.relevance', 0.30);
  v_weight_qual  numeric := public.pulse_cfg('pulse.weight.quality', 0.25);
  v_weight_fresh numeric := public.pulse_cfg('pulse.weight.freshness', 0.20);
  v_weight_eng   numeric := public.pulse_cfg('pulse.weight.engagement', 0.15);
  v_weight_div   numeric := public.pulse_cfg('pulse.weight.diversity', 0.10);
  v_fresh_days   numeric := public.pulse_cfg('pulse.freshnessDays', 14);
  v_eng_prior    numeric := public.pulse_cfg('pulse.engagementPriorStrength', 20);
  v_eng_base     numeric := public.pulse_cfg('pulse.engagementBaseline', 0.60);
  v_seasons      jsonb := coalesce(public.pulse_cfg_json('pulse.seasonCategories'),
                                   '[{"months":[10,11,12,1],"categories":["exams"]},{"months":[2,3],"categories":["fests"]}]'::jsonb);
  v_seasonnow    text[];
  v_prev_cat     text;
  v_pick         uuid;
begin
  -- active-season categories for THIS campus day (deterministic, documented)
  select coalesce(array_agg(cat), '{}')
    into v_seasonnow
    from jsonb_array_elements(
           coalesce(
             (select jsonb_agg(cat)
                from (select jsonb_array_elements(s.value->'categories') as cat
                        from jsonb_array_elements(v_seasons) s
                       where (s.value->'months') @> to_jsonb(extract(month from p_date))
                      ) m),
             '[]'::jsonb)
         ) x(cat);

  -- previous instance's category in this scope (diversity axis)
  select it.category into v_prev_cat
    from public.pulse_instances i
    join public.pulse_items it on it.id = i.content_id
   where i.college_id is not distinct from p_scope
     and i.publish_date = p_date - 1
   limit 1;

  select t.id into v_pick
    from public.pulse_items t
    /* per-candidate history in one lateral pass: when this scope last showed
       the item, plus its participation so far (votes / skips are the only
       genuine events — no impression data exists, so no pretend
       exposure-adjustment: documented engine limitation) */
    left join lateral (
       select max(shown.publish_date) as last_shown
         from public.pulse_instances shown
        where shown.content_id = t.id
          and shown.college_id is not distinct from p_scope
    ) sh on true
    left join lateral (
       select count(*) as votes
         from public.pulse_responses r
         join public.pulse_instances ip on ip.id = r.instance_id
        where ip.content_id = t.id
    ) vd on true
    left join lateral (
       select count(*) as skips
         from public.pulse_skips sk
         join public.pulse_instances isl on isl.id = sk.instance_id
        where isl.content_id = t.id
    ) sk on true
   where t.kind = 'question'
     and t.status = 'approved'
     and (t.valid_until is null or t.valid_until > now())
     and jsonb_typeof(t.options) = 'array'
     and jsonb_array_length(t.options) between 2 and 6
     -- freshness HARD exclusion: not shown to this scope in the last N days
     and (sh.last_shown is null or sh.last_shown < p_date - v_fresh_days::int)
   order by
     -- 0.30 relevance: season hit → 1.0; evergreen stays neutral at 0.75
     (case
        when t.category = any(v_seasonnow) then 1.0
        when t.evergreen then 0.75
        else 0.5
      end) * v_weight_rel
     -- 0.25 quality: approval IS the quality gate; the pool is pre-deduped
     + 0.5 * v_weight_qual
     -- 0.20 freshness: never shown → 1.0, smooth decay across the window
     + (case
          when sh.last_shown is null then 1.0
          else greatest(0.1, 1.0 - ((p_date - sh.last_shown)::numeric / v_fresh_days))
        end) * v_weight_fresh
     -- 0.15 engagement: participation rate smoothed against the prior
     -- baseline (fairness-aware: small samples stay near the baseline)
     + ((vd.votes * 1.0 + v_eng_prior * v_eng_base)
        / (vd.votes + sk.skips + v_eng_prior)) * v_weight_eng
      -- 0.10 diversity: differing from yesterday's category scores full
      + (case when v_prev_cat is null or t.category <> v_prev_cat then 1.0 else 0.0 end) * v_weight_div
      -- deterministic tie-break: rotates daily, stable within the day
      -- deterministic tie-break: rotates daily, stable within the day
      -- (∴ bigint first: hashtext is int32 and +2^31 would overflow)
      + (mod((hashtext(coalesce(p_scope::text,'platform') || ':' || p_date::text || ':' || t.id::text)::bigint + 2147483647) % 1000000, 1000) + 0.0) / 100000.0
    desc
   limit 1;

  return v_pick;
end $$;

-- ===========================================================================
-- 13. VIEW BUILDER — one canonical shape for get/vote (no duplicated logic)
-- ===========================================================================
create or replace function public.pulse_daily_view(v_instance uuid, p_scope uuid)
returns json
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_row      record;
  v_item     record;
  v_min      integer := public.pulse_cfg('pulse.minSample', 10)::int;
  v_my       integer;
  v_total    integer;
  v_skips    integer;
  v_counts   jsonb;
  v_meets    boolean;
begin
  select i.*, (now() > i.expires_at) as is_expired into v_row
    from public.pulse_instances i
   where i.id = v_instance;
  if not found then return null; end if;

  select t.body, t.options, t.category into v_item
    from public.pulse_items t
   where t.id = v_row.content_id;

  select count(*) into v_total from public.pulse_responses r where r.instance_id = v_instance;
  select count(*) into v_skips from public.pulse_skips s where s.instance_id = v_instance;
  select r.option_index into v_my
    from public.pulse_responses r
   where r.instance_id = v_instance and r.user_id = auth.uid()
   limit 1;

  v_meets := v_total >= v_min;
  if v_meets then
    select coalesce(jsonb_object_agg(r.option_index, c), '{}'::jsonb) into v_counts
      from (
        select r.option_index, count(*)::int as c
          from public.pulse_responses r
         where r.instance_id = v_instance
         group by r.option_index
      ) z;
  else
    v_counts := null;  -- privacy threshold not met → no per-option distribution
  end if;

  return jsonb_build_object(
    'instanceId', v_instance,
    'question', v_item.body,
    'category', v_item.category,
    'options', v_item.options,          -- [{emoji,label}]
    'endsAt', v_row.expires_at,
    'status', case when v_row.is_expired then 'closed' else v_row.status end,
    'myVote', v_my,
    'responsesTotal', v_total,
    'skipsTotal', v_skips,
    'minSample', v_min,
    'results', v_counts
  );
end $$;

-- ===========================================================================
-- 14. THE AUTOMATED CONTENT LIFECYCLE — daily publisher
-- idempotent: any first caller of the day materializes the instance; every
-- caller afterwards verifies and returns the same row. No browser decides
-- anything: content selection + duplicate prevention are server rules.
-- ===========================================================================
create or replace function public.pulse_ensure_daily(p_date date default null)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_scope   uuid := public.pulse_scope_of();
  v_date    date := coalesce(p_date, public.pulse_campus_day());
  v_nonce   uuid;
  v_expires timestamptz := public.pulse_campus_day_end(v_date);
  v_exists  uuid;
  v_closed  boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('error', 'signin');
  end if;

  -- already published today for this scope?
  select i.id, (i.expires_at < now()) into v_exists, v_closed
    from public.pulse_instances i
   where i.college_id is not distinct from v_scope
     and i.publish_date = v_date
   limit 1;

  if v_exists is null then
    -- deterministic pick (identical result for every concurrent caller)
    v_nonce := public.pulse_pick_daily(v_scope, v_date);
    if v_nonce is null then
      -- honest empty state: not enough approved content — never manufacture
      perform public.pulse_log_job('pulse.ensure_daily',
        v_date::text || ':' || coalesce(v_scope::text,'platform'), true,
        jsonb_build_object('outcome', 'no_candidates'));
      return jsonb_build_object('state', 'empty');
    end if;
    insert into public.pulse_instances (college_id, publish_date, content_id, status, expires_at)
    values (v_scope, v_date, v_nonce, 'published', v_expires)
    on conflict (coalesce(college_id, '00000000-0000-0000-0000-000000000000'::uuid), publish_date) do nothing;
    perform public.pulse_log_job('pulse.ensure_daily',
      v_date::text || ':' || coalesce(v_scope::text,'platform'), true,
      jsonb_build_object('outcome', 'published', 'content_id', v_nonce));
    select i.id into v_exists
      from public.pulse_instances i
     where i.college_id is not distinct from v_scope and i.publish_date = v_date;
  end if;

  return jsonb_build_object('instanceId', v_exists,
    'daily', public.pulse_daily_view(v_exists, v_scope));
end $$;

-- ===========================================================================
-- 15. VOTING + SKIP (gated, duplicate-safe)
-- ===========================================================================
create or replace function public.pulse_vote(v_instance uuid, p_option smallint)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_row     record;
  v_item    record;
  v_just    boolean := false;
  v_already boolean := false;
  v_dates   date[];
  v_i       int;
  v_day     date;
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  if not public.account_can_write(v_user) then
    return jsonb_build_object('error', 'Your account cannot post right now.');
  end if;

  select i.* into v_row
    from public.pulse_instances i
   where i.id = v_instance
     and i.status <> 'archived';
  if not found then return jsonb_build_object('error', 'That question is not available.'); end if;
  if v_row.expires_at < now() then
    return jsonb_build_object('state', 'closed',
      'daily', public.pulse_daily_view(v_instance, public.pulse_scope_of()));
  end if;

  select t.options into v_item
    from public.pulse_items t where t.id = v_row.content_id;
  if v_item.options is null or p_option < 0 or p_option >= jsonb_array_length(v_item.options) then
    return jsonb_build_object('error', 'That answer is not one of the options.');
  end if;

  begin
    insert into public.pulse_responses (instance_id, user_id, option_index)
    values (v_instance, v_user, p_option);
    v_just := true;
  exception when unique_violation then
    v_already := true;   -- double tap / retry: keep the FIRST truthful vote
  end;

  -- ---- milestones (server-verified from real rows only) ----
  if v_just then
    -- First Pulse
    insert into public.pulse_milestones (user_id, milestone_key)
    values (v_user, 'first_pulse') on conflict do nothing;

    -- Three-Day Participation Streak: 3 CONSECUTIVE campus days ending today,
    -- counted from distinct vote dates (skips do not count as participation)
    select coalesce(array_agg(distinct (x.publish_date)), '{}') into v_dates
      from (
        select i.publish_date
          from public.pulse_responses r
          join public.pulse_instances i on i.id = r.instance_id
         where r.user_id = v_user
      ) x;
    v_day := public.pulse_campus_day();
    v_i := 0;
    while v_i < 3 loop
      exit when not (v_day - v_i) = any(v_dates);
      v_i := v_i + 1;
    end loop;
    if v_i >= 3 then
      insert into public.pulse_milestones (user_id, milestone_key)
      values (v_user, 'streak_3') on conflict do nothing;
    end if;
  end if;

  return jsonb_build_object('vote', jsonb_build_object(
    'just', v_just, 'already', v_already),
    'state', 'ok',
    'daily', public.pulse_daily_view(v_instance, public.pulse_scope_of()));
end $$;

create or replace function public.pulse_skip(v_instance uuid)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if auth.uid() is null then return jsonb_build_object('error', 'signin'); end if;
  insert into public.pulse_skips (instance_id, user_id)
  values (v_instance, auth.uid())
  on conflict (instance_id, user_id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- 16. AM I THE ONLY ONE? — deterministic daily deck + reactions
-- returns a FINITE five-card selection (no endless feed), stable within the
-- day, rotating across days, approved content only.
-- ===========================================================================
create or replace function public.pulse_statements(p_date date default null)
returns json
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope uuid := public.pulse_scope_of();
  v_date  date := coalesce(p_date, public.pulse_campus_day());
  v_deck  int := public.pulse_cfg('pulse.statementDeck', 5)::int;
  v_stmts jsonb;
begin
  if auth.uid() is null then return to_json(jsonb_build_object('error', 'signin')); end if;

  -- seeded shuffle: bigint arithmetic (hashtext is int32; adding 2^31 to it
  -- overflows), FINITE deck cut first, then slots 1..N over exactly what shows
  with scored as (
    select t.id, t.body,
           ((hashtext(coalesce(v_scope::text,'platform') || ':' || v_date::text || ':' || t.id::text)::bigint + 2147483647) % 1000000) % 100000 as rank_seed
      from public.pulse_items t
     where t.kind = 'statement'
       and t.status = 'approved'
       and (t.valid_until is null or t.valid_until > now())
  ),
  deck as (
    select s.id, s.body, row_number() over (order by s.rank_seed) as slot
      from (select * from scored order by rank_seed limit greatest(v_deck, 1)) s
  )
  select coalesce(jsonb_agg(jsonb_build_object(
             'id', d.id, 'text', d.body, 'slot', d.slot, 'my', v1.reaction,
             'counts', array[
                (select count(*) from public.pulse_reactions a where a.statement_id = d.id and a.reaction = 0)::int,
                (select count(*) from public.pulse_reactions b where b.statement_id = d.id and b.reaction = 1)::int,
                (select count(*) from public.pulse_reactions c where c.statement_id = d.id and c.reaction = 2)::int
             ]) order by d.slot), '[]'::jsonb)
    from deck d
    left join lateral (
      select r.reaction from public.pulse_reactions r
       where r.statement_id = d.id and r.user_id = auth.uid()
    ) v1 on true
  into v_stmts;

  return to_json(jsonb_build_object('statements', v_stmts));
end $$;

create or replace function public.pulse_react(v_statement uuid, p_reaction smallint)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_college uuid := public.pulse_scope_of();
  v_counts int[];
  v_my smallint;
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  if not public.account_can_write(v_user) then
    return jsonb_build_object('error', 'Your account cannot post right now.');
  end if;

  -- statement must be approved live content
  if not exists (select 1 from public.pulse_items t
                  where t.id = v_statement and t.kind = 'statement'
                    and t.status = 'approved'
                    and (t.valid_until is null or t.valid_until > now())) then
    return jsonb_build_object('error', 'That statement is not available anymore.');
  end if;

  if p_reaction is null then
    delete from public.pulse_reactions r where r.statement_id = v_statement and r.user_id = v_user;
  elsif p_reaction between 0 and 2 then
    insert into public.pulse_reactions (statement_id, user_id, reaction, college_id)
    values (v_statement, v_user, p_reaction, v_college)
    on conflict (statement_id, user_id) do update
      set reaction = excluded.reaction, updated_at = now(), college_id = excluded.college_id;
    insert into public.pulse_milestones (user_id, milestone_key)
    values (v_user, 'campus_voice') on conflict do nothing;   -- Campus Voice milestone
  else
    return jsonb_build_object('error', 'Unknown reaction.');
  end if;

  select array[
    (select count(*) from public.pulse_reactions a where a.statement_id = v_statement and a.reaction = 0)::int,
    (select count(*) from public.pulse_reactions b where b.statement_id = v_statement and b.reaction = 1)::int,
    (select count(*) from public.pulse_reactions c where c.statement_id = v_statement and c.reaction = 2)::int
  ] into v_counts;
  select r.reaction into v_my from public.pulse_reactions r
   where r.statement_id = v_statement and r.user_id = v_user;

  return jsonb_build_object('counts', v_counts, 'my', v_my);
end $$;

-- ===========================================================================
-- 17. CAMPUS PERSONALITY — quizzes (list + server-scored submit)
-- ===========================================================================
create or replace function public.pulse_quiz_list()
returns json
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'title', q.body, 'version', q.version, 'category', q.category,
      'questions', (
        select jsonb_agg(jsonb_build_object('id', qq.id, 'prompt', qq.prompt, 'options', qq.options)
                         order by qq.position)
          from public.pulse_quiz_questions qq where qq.quiz_id = q.id),
      'results', (
        select jsonb_agg(jsonb_build_object('resultKey', rr.result_key, 'label', rr.label,
                                            'emoji', rr.emoji, 'blurb', rr.blurb) order by rr.result_key)
          from public.pulse_quiz_results rr where rr.quiz_id = q.id)
    ) order by q.body), '[]'::jsonb)
    from public.pulse_items q
   where q.kind = 'quiz' and q.status = 'approved';
$$;

create or replace function public.pulse_quiz_submit(v_quiz uuid, p_version smallint, p_answers smallint[])
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_quizrow record;
  v_qsum  smallint;
  v_scores smallint[];
  v_key   smallint := 0;
  v_pos   smallint;
  v_trait smallint;
  v_answer smallint;
  v_result record;
  v_share smallint[];
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  if not public.account_can_write(v_user) then
    return jsonb_build_object('error', 'Your account cannot post right now.');
  end if;

  select * into v_quizrow from public.pulse_items
   where id = v_quiz and kind = 'quiz' and status = 'approved';
  if not found then return jsonb_build_object('error', 'That quiz is not available.'); end if;
  if v_quizrow.version <> p_version then
    return jsonb_build_object('error', 'That quiz version is out of date — open it again.');
  end if;

  select count(*)::smallint into v_qsum from public.pulse_quiz_questions where quiz_id = v_quiz;
  if coalesce(array_length(p_answers, 1), 0) <> v_qsum then
    return jsonb_build_object('error', 'The quiz was not fully answered.');
  end if;

  -- deterministic scoring: sum trait indices, ties resolve to the LOWEST key
  v_scores := array_fill(0, array[coalesce((
      select count(*)::smallint from public.pulse_quiz_results where quiz_id = v_quiz), 0)]);
  for v_pos in 1..v_qsum loop
    v_answer := coalesce(p_answers[v_pos], -1);
    if v_answer < 0 then return jsonb_build_object('error', 'The quiz was not fully answered.'); end if;
    select (qq.options -> v_answer ->> 'trait')::smallint into v_trait
      from public.pulse_quiz_questions qq
     where qq.quiz_id = v_quiz and qq.position = v_pos;
    if v_trait is null or v_trait >= array_length(v_scores, 1) or v_trait < 0 then
      return jsonb_build_object('error', 'One of the answers was not valid.');
    end if;
    v_scores[v_trait + 1] := v_scores[v_trait + 1] + 1;
  end loop;

  for v_pos in 1..array_length(v_scores, 1) loop
    if v_scores[v_pos] > v_scores[v_key + 1] then v_key := v_pos - 1; end if;
  end loop;

  select * into v_result from public.pulse_quiz_results
   where quiz_id = v_quiz and result_key = v_key;
  if not found then return jsonb_build_object('error', 'The quiz result table is incomplete.'); end if;

  insert into public.pulse_attempts (quiz_id, version, user_id, answers, result_key)
  values (v_quiz, p_version, v_user, to_jsonb(p_answers), v_key)
  on conflict (user_id, quiz_id, version) do update
    set answers = excluded.answers, result_key = excluded.result_key, created_at = now();

  -- Challenge Participant milestone (server-verified from the stored attempt)
  insert into public.pulse_milestones (user_id, milestone_key)
  values (v_user, 'challenge_participant') on conflict do nothing;

  return jsonb_build_object(
    'resultKey', v_key,
    'label', v_result.label,
    'emoji', v_result.emoji,
    'blurb', v_result.blurb
  );
end $$;

-- ===========================================================================
-- 18. CAMPUS INSIGHTS — threshold-guarded, cached, source-explained
-- Every insight carries: key (= its whitelist template), sample size, period,
-- the actual data, and an honest explanation. Templates are fixed server-side
-- copy; the TS layer formats ONLY whitelisted keys. Nothing fabricated.
-- ===========================================================================
create or replace function public.pulse_insights(p_college uuid default null)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_scope  uuid := public.pulse_scope_of(p_college);
  v_date   date := public.pulse_campus_day();
  v_min    integer := public.pulse_cfg('pulse.minSample', 10)::int;
  v_minlift numeric := public.pulse_cfg('pulse.trendMinLiftPts', 5);
  v_out    jsonb := '[]'::jsonb;
  v_cached jsonb;
  v_opt    int;
  v_today  record;
  v_prev   record;
  v_total  integer;
  v_topn   integer;
  v_tmp    jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('insights', '[]'::json, 'state', 'signin');
  end if;

  -- cached snapshot for today? (cache-valid ⇒ reuse; threshold-passing
  -- insights only ever enter the cache, so reuse adds no new exposure)
  select jsonb_agg(pi.payload order by pi.insight_key) into v_cached
    from public.pulse_insights pi
   where pi.college_id is not distinct from v_scope
     and pi.scope_date = v_date
     and pi.valid_until > now();

  if coalesce(jsonb_array_length(coalesce(v_cached, '[]'::jsonb)), 0) >= 2 then
    return jsonb_build_object('insights', v_cached, 'state', 'ok');
  end if;

  -- --- insight A: TODAY'S MOOD (today instance, sample ≥ threshold) --------
  select i.id, i.content_id into v_today
    from public.pulse_instances i
   where i.college_id is not distinct from v_scope and i.publish_date = v_date;

  if v_today is not null then
    select count(*) into v_total from public.pulse_responses r where r.instance_id = v_today.id;

    select r.option_index into v_opt
      from public.pulse_responses r
     where r.instance_id = v_today.id
     group by r.option_index
     order by count(*) desc, r.option_index
     limit 1;

    if v_total >= v_min and v_opt is not null then
      select coalesce(sum(case when r.option_index = v_opt then 1 else 0 end), 0)::int into v_topn
        from public.pulse_responses r where r.instance_id = v_today.id;

      select t.options -> v_opt, t.body into v_tmp
        from public.pulse_items t where t.id = v_today.content_id;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', 'mood_now',
        'sample', v_total,
        'min', v_min,
        'period', 'today',
        'topEmoji', v_tmp -> 'emoji',
        'topLabel', v_tmp -> 'label',
        'share', round(v_topn * 100.0 / v_total, 1),
        'shareWilsonLb', round(public.pulse_wilson_lb(v_topn, v_total) * 100, 1),
        'question', v_tmp ->> 'body',
        'explain', 'Share of the students who answered this one-day Pulse question; the confidence floor is a Wilson interval at 95%.'
      ));
    end if;

    -- --- insight B: MOOD SHIFT vs yesterday (same top option both days) ----
    select i.id into v_prev
      from public.pulse_instances i
     where i.college_id is not distinct from v_scope and i.publish_date = v_date - 1;
    if v_prev is not null and v_total >= v_min and v_opt is not null then
      declare
        v_prevtotal   int;
        v_prevtop     int;
        v_prevshare   numeric;
        v_todayshare  numeric := v_topn * 100.0 / v_total;
      begin
        select count(*) into v_prevtotal from public.pulse_responses r where r.instance_id = v_prev.id;
        select r.option_index into v_prevtop
          from public.pulse_responses r where r.instance_id = v_prev.id
         group by r.option_index order by count(*) desc, r.option_index limit 1;
        if v_prevtop is not null and v_prevtop = v_opt and v_prevtotal >= v_min then
          select (count(*) filter (where r.option_index = v_opt)) * 100.0 / v_prevtotal
            into v_prevshare
            from public.pulse_responses r where r.instance_id = v_prev.id;
          -- trend gate: BOTH the configured lift AND the Wilson floor must hold
          if v_todayshare - v_prevshare >= v_minlift
             and public.pulse_wilson_lb(v_topn, v_total) * 100 > v_prevshare then
            v_out := v_out || jsonb_build_array(jsonb_build_object(
              'key', 'mood_shift_up',
              'sample', v_total,
              'min', v_min,
              'period', 'today vs yesterday',
              'baseShare', round(v_prevshare, 1),
              'nowShare', round(v_todayshare, 1),
              'explain', 'Both days reached the minimum sample; the shift must exceed the configured threshold AND hold inside a 95% Wilson interval.'
            ));
          end if;
        end if;
      end;
    end if;
  end if;

  -- --- insight C: TOP STATEMENT of the week (needs ≥ v_min distinct reactors)
  select jsonb_build_object(
      'key', 'top_statement_week',
      'sample', cnt.reactors,
      'min', v_min,
      'period', 'last 7 days',
      'statement', t.body,
      'reactions', array[
        (select count(*) from public.pulse_reactions a where a.statement_id = t.id and a.updated_at > now() - interval '7 days' and a.reaction = 0)::int,
        (select count(*) from public.pulse_reactions b where b.statement_id = t.id and b.updated_at > now() - interval '7 days' and b.reaction = 1)::int,
        (select count(*) from public.pulse_reactions c where c.statement_id = t.id and c.updated_at > now() - interval '7 days' and c.reaction = 2)::int
      ],
      'explain', 'Statement with the most distinct students reacting in the past week for this campus. Counts are anonymous reaction totals, never attributed names.'
    ) into v_tmp
    from (
      select r.statement_id, count(distinct r.user_id)::int as reactors
        from public.pulse_reactions r
       where r.updated_at > now() - interval '7 days'
         and (case when v_scope is null then r.college_id is null else r.college_id = v_scope end)
       group by r.statement_id
       having count(distinct r.user_id) >= v_min
       order by count(distinct r.user_id) desc, r.statement_id
       limit 1
    ) cnt
    join public.pulse_items t on t.id = cnt.statement_id
   where t.status = 'approved';
  if v_tmp is not null then
    v_out := v_out || jsonb_build_array(v_tmp);
  end if;

  -- --- insight D: participation count (honest, period-labeled, any sample) --
  declare
    v_part_today int;
    v_part_week  int;
  begin
    select count(*) into v_part_today
      from public.pulse_responses r
      join public.pulse_instances i on i.id = r.instance_id
     where i.college_id is not distinct from v_scope and i.publish_date = v_date;
    select count(*) into v_part_week
      from public.pulse_responses r
      join public.pulse_instances i on i.id = r.instance_id
     where i.college_id is not distinct from v_scope and i.publish_date >= v_date - 6;
    if v_part_today > 0 or v_part_week > 0 then
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'key', 'participation',
        'sample', v_part_week,
        'min', v_min,
        'period', 'this week',
        'today', v_part_today,
        'week', v_part_week,
        'explain', 'Distinct votes cast on Pulse questions (skips are not counted as participation).'
      ));
    end if;
  end;

  -- per-key upsert into the cache table (threshold-passing rows only enter)
  declare
    v_item jsonb;
  begin
    for v_item in select * from jsonb_array_elements(v_out) loop
      insert into public.pulse_insights (college_id, insight_key, scope_date, payload, sample_size, valid_until)
      values (v_scope, v_item->>'key', v_date, v_item,
              coalesce((v_item->>'sample')::int, 0),
              public.pulse_campus_day_end(v_date))
      on conflict (coalesce(college_id,'00000000-0000-0000-0000-000000000000'::uuid), insight_key, scope_date)
      do update set payload = excluded.payload, sample_size = excluded.sample_size,
                    computed_at = now(), valid_until = excluded.valid_until;
    end loop;
  end;

  perform public.pulse_log_job('pulse.insights',
    v_date::text || ':' || coalesce(v_scope::text,'platform'), true,
    jsonb_build_object('insights', v_out));

  return jsonb_build_object('insights', v_out, 'state', 'ok');
end $$;

-- ===========================================================================
-- 19. MILESTONES (read) + quiz attempts (read for the Profile surface)
-- ===========================================================================
create or replace function public.pulse_milestones_mine()
returns json
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', m.milestone_key, 'at', m.awarded_at)
                  order by m.awarded_at), '[]'::jsonb)
    from public.pulse_milestones m
   where m.user_id = auth.uid();
$$;

create or replace function public.pulse_my_attempts()
returns json
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
             'quizId', a.quiz_id, 'version', a.version, 'resultKey', a.result_key, 'at', a.created_at)
             order by a.created_at), '[]'::jsonb)
    from public.pulse_attempts a
   where a.user_id = auth.uid();
$$;

-- ===========================================================================
-- 20. ADMINISTRATION (has_op('pulse.admin'), staff audit trail on every write)
-- ===========================================================================
create or replace function public.pulse_admin_list(p_status text default '')
returns json
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can manage Pulse content.';
  end if;
  return coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'category', t.category, 'body', t.body,
    'options', t.options, 'version', t.version, 'status', t.status,
    'evergreen', t.evergreen, 'validUntil', t.valid_until,
    'createdAt', t.created_at)), '[]'::jsonb)
  from public.pulse_items t
  where p_status = '' or t.status = p_status;
end $$;

create or replace function public.pulse_admin_set_status(
  v_item uuid, p_status text, p_reason text default null)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can manage Pulse content.';
  end if;
  if p_status not in ('draft','approved','paused','rejected') then
    raise exception 'Unknown status.';
  end if;
  update public.pulse_items
     set status = p_status,
         approved_by = case when p_status = 'approved' then v_actor else approved_by end,
         updated_at = now()
   where id = v_item;
  if not found then raise exception 'That item does not exist.'; end if;
  perform public.log_staff_action('pulse.set_status',
    jsonb_build_object('item', v_item, 'status', p_status, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- Quiz authoring goes in as ONE transaction-shaped call (item + questions + results)
create or replace function public.pulse_admin_create_quiz(
  p_title text, p_category text, p_version smallint,
  p_questions jsonb,   -- [{prompt, options:[{text,trait}]}]
  p_results jsonb      -- [{label, emoji, blurb}]
)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor  uuid := auth.uid();
  v_item   uuid;
  v_q      jsonb;
  v_r      jsonb;
  v_pos    smallint;
  v_key    smallint;
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can manage Pulse content.';
  end if;
  if jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) < 3
     or jsonb_array_length(p_questions) > 12 then
    raise exception 'A quiz needs 3-12 questions.';
  end if;
  if jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) < 2 then
    raise exception 'A quiz needs at least 2 result personalities.';
  end if;
  -- every option trait must be inside the result space
  for v_q in select * from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(v_q->'prompt') is distinct from 'string' then
      raise exception 'Every quiz question needs a prompt.';
    end if;
    for v_r in select * from jsonb_array_elements(v_q->'options') loop
      if (v_r->>'trait')::smallint is null or (v_r->>'trait')::smallint >= jsonb_array_length(p_results) then
        raise exception 'Every quiz option needs a trait within the result space.';
      end if;
    end loop;
  end loop;

  insert into public.pulse_items (kind, category, body, version, status, evergreen, created_by, approved_by)
  values ('quiz', p_category, btrim(p_title), p_version, 'approved', true, v_actor, v_actor)
  returning id into v_item;

  v_pos := 0;
  for v_q in select * from jsonb_array_elements(p_questions) loop
    v_pos := v_pos + 1;
    insert into public.pulse_quiz_questions (quiz_id, position, prompt, options)
    values (v_item, v_pos, v_q->>'prompt', v_q->'options');
  end loop;
  v_key := 0;
  for v_r in select * from jsonb_array_elements(p_results) loop
    insert into public.pulse_quiz_results (quiz_id, result_key, label, emoji, blurb)
    values (v_item, v_key, v_r->>'label', coalesce(v_r->>'emoji','🙂'), v_r->>'blurb');
    v_key := v_key + 1;
  end loop;

  perform public.log_staff_action('pulse.create_quiz', jsonb_build_object('item', v_item, 'title', p_title));
  return jsonb_build_object('id', v_item);
end $$;

-- Safe configuration edits (weights, thresholds) — versioned rows with author
create or replace function public.pulse_admin_config_get()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare v jsonb;
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can read Pulse configuration.';
  end if;
  select coalesce(jsonb_object_agg(c.key, c.value), '{}'::jsonb) into v from public.pulse_config c;
  return v;
end $$;

create or replace function public.pulse_admin_config_set(p_key text, p_value numeric)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can adjust Pulse configuration.';
  end if;
  if p_key not in ('pulse.weight.relevance','pulse.weight.quality','pulse.weight.freshness',
                   'pulse.weight.engagement','pulse.weight.diversity','pulse.minSample',
                   'pulse.trendMinLiftPts','pulse.freshnessDays','pulse.engagementPriorStrength',
                   'pulse.engagementBaseline','pulse.statementDeck') then
    raise exception 'That configuration key is not adjustable.';
  end if;
  update public.pulse_config
     set value = to_jsonb(p_value), updated_at = now(), updated_by = v_actor
   where key = p_key;
  if not found then raise exception 'Unknown configuration key.'; end if;
  perform public.log_staff_action('pulse.config', jsonb_build_object('key', p_key, 'value', p_value));
  return jsonb_build_object('ok', true);
end $$;

-- Failed-job inspection for the staff console
create or replace function public.pulse_admin_jobs()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can inspect Pulse jobs.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'jobKey', j.job_key, 'idemKey', j.idem_key, 'ok', j.ok,
      'detail', j.detail, 'ranAt', j.ran_at) order by j.ran_at desc)
      from (select * from public.pulse_job_runs order by ran_at desc limit 40) j
  ), '[]'::jsonb);
end $$;

-- Admin participation overview (aggregate-only, threshold-conscious)
create or replace function public.pulse_admin_overview()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_out jsonb;
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can view Pulse performance.';
  end if;
  select jsonb_build_object(
    'votes7', (select count(*) from public.pulse_responses r
                where r.created_at > now() - interval '7 days'),
    'votesToday', (select count(*) from public.pulse_responses r
                    join public.pulse_instances i on i.id = r.instance_id
                   where i.publish_date = public.pulse_campus_day()),
    'reactions7', (select count(*) from public.pulse_reactions where updated_at > now() - interval '7 days'),
    'attempts7',  (select count(*) from public.pulse_attempts where created_at > now() - interval '7 days'),
    'skipsToday', (select count(*) from public.pulse_skips s
                    join public.pulse_instances i on i.id = s.instance_id
                   where i.publish_date = public.pulse_campus_day()),
    'itemsByStatus', (select jsonb_object_agg(status, n) from
                       (select status, count(*) n from public.pulse_items group by status) x)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 21. Execute grants (existing pattern: functions callable, tables stay
--     RLS-gated; no table grants beyond the schema defaults)
-- ---------------------------------------------------------------------------
grant execute on function public.pulse_ensure_daily(date)            to authenticated;
grant execute on function public.pulse_vote(uuid, smallint)          to authenticated;
grant execute on function public.pulse_skip(uuid)                    to authenticated;
grant execute on function public.pulse_statements(date)              to authenticated;
grant execute on function public.pulse_react(uuid, smallint)         to authenticated;
grant execute on function public.pulse_report_statement(uuid, text, text) to authenticated;
grant execute on function public.pulse_quiz_list()                   to authenticated;
grant execute on function public.pulse_quiz_submit(uuid, smallint, smallint[]) to authenticated;
grant execute on function public.pulse_insights(uuid)                to authenticated;
grant execute on function public.pulse_milestones_mine()             to authenticated;
grant execute on function public.pulse_my_attempts()                 to authenticated;
grant execute on function public.pulse_admin_list(text)              to authenticated;
grant execute on function public.pulse_admin_set_status(uuid, text, text) to authenticated;
grant execute on function public.pulse_admin_create_quiz(text, text, smallint, jsonb, jsonb) to authenticated;
grant execute on function public.pulse_admin_config_get()            to authenticated;
grant execute on function public.pulse_admin_config_set(text, numeric) to authenticated;
grant execute on function public.pulse_admin_jobs()                  to authenticated;
grant execute on function public.pulse_admin_overview()              to authenticated;
grant execute on function public.pulse_campus_day()                  to authenticated;
grant execute on function public.pulse_campus_day_end(date)          to authenticated;
grant execute on function public.pulse_wilson_lb(numeric, numeric, numeric) to authenticated;
grant execute on function public.pulse_cfg(text, numeric)            to authenticated;
grant execute on function public.pulse_cfg_json(text)                to authenticated;
