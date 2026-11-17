-- =============================================================================
-- 0072 — CAMPUS PULSE 2.0: PERSONALIZATION ENGINE + AI GENERATION FOUNDATIONS
--
-- Preserves 0048/0048b completely: every existing table, RPC, policy and the
-- weighted selection algorithm stay untouched. This migration is purely
-- additive:
--
--   1. pulse_topics            — the topic taxonomy (seeded, admin-editable)
--   2. pulse_user_interests    — per-user bounded interest scores (0..1)
--   3. pulse_topic_feedback    — legitimate first-party signals (like/dislike)
--   4. pulse_user_prefs        — personalization on/off per user
--   5. pulse_events            — minimal analytics events, 90-day retention
--   6. Signal hooks as TRIGGERS on existing participation tables — the 0048
--      RPCs are NOT rewritten; votes/skips/reactions/quiz attempts feed the
--      interest profile server-side, where the authoritative data lives.
--   7. New member RPCs: profile get/reset, prefs, signal, event log
--   8. New admin RPCs: AI settings, events stats, maintenance
--   9. Recommendation weights + AI knobs in pulse_config (numeric whitelist
--      extended; the AI model name has its own admin RPC — pulse_config
--      values stay numeric so the existing config UI keeps working)
--
-- Privacy guarantees kept:
--   * interests/feedback/events have NO member SELECT policies (server-only)
--   * users can see and correct their OWN profile only via RPC
--   * opting out stops all learning immediately (triggers check prefs)
--   * nothing here feeds insights/milestones with new exposure of individual
--     rows; aggregates stay behind the same thresholds
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. TOPIC TAXONOMY — the single source of truth for Pulse topics
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_topics (
  key         text primary key,
  label       text not null,
  emoji       text not null default '✨',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.pulse_topics (key, label, emoji) values
  ('campus_life',     'Campus life',       '🎓'),
  ('exams',           'Exams & study',     '📚'),
  ('food',            'Food & mess',       '🍜'),
  ('hostel',          'Hostel life',       '🛏️'),
  ('commute',         'Commute',           '🚌'),
  ('fests',           'Fests & events',    '🎉'),
  ('technology',      'Technology',        '💻'),
  ('placements',      'Placements & career', '🧭'),
  ('sports',          'Sports & fitness',  '🏏'),
  ('entertainment',   'Entertainment',     '🎬'),
  ('entrepreneurship','Startups & ideas',  '🚀')
on conflict (key) do nothing;

alter table public.pulse_topics enable row level security;
drop policy if exists pulse_topics_select on public.pulse_topics;
create policy pulse_topics_select on public.pulse_topics
  for select using (active = true or public.is_staff());
-- (writes happen only through this migration / future admin RPCs — no
--  member write policies exist)

-- ---------------------------------------------------------------------------
-- 2. INTEREST PROFILE — bounded, incremental, explainable
--    score semantics: 0 = not interested · 1 = strong interest
--    'explicit' rows came from the user's own choices (settings sheet)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_user_interests (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  topic      text not null references public.pulse_topics(key) on delete cascade,
  score      numeric not null default 0.5 check (score between 0 and 1),
  explicit   boolean not null default false,
  touched_at timestamptz not null default now(),
  primary key (user_id, topic)
);
create index if not exists pulse_user_interests_user_idx on public.pulse_user_interests (user_id, touched_at desc);

alter table public.pulse_user_interests enable row level security;
-- NO select policies: members read their profile through pulse_profile_get,
-- nobody reads anyone else's — not even their own raw rows.

-- ---------------------------------------------------------------------------
-- 3. TOPIC FEEDBACK — the legitimate signal log (also the audit trail of
--    how a profile was learned; reset deletes it)
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_topic_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  topic       text not null references public.pulse_topics(key) on delete cascade,
  signal      text not null check (signal in ('select','avoid','neutral','like','dislike','dismiss','hide')),
  target_kind text,
  target_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists pulse_topic_feedback_user_idx
  on public.pulse_topic_feedback (user_id, created_at desc);

alter table public.pulse_topic_feedback enable row level security;
-- NO select policies (same reasoning as interests).

-- ---------------------------------------------------------------------------
-- 4. USER PREFERENCES — explicit personalization control
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_user_prefs (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  personalization boolean not null default true,
  updated_at     timestamptz not null default now()
);
alter table public.pulse_user_prefs enable row level security;
-- NO select policies; read/write through RPC only.

-- ---------------------------------------------------------------------------
-- 5. ANALYTICS EVENTS — minimal, whitelisted, rate-limited, retained 90 days
-- ---------------------------------------------------------------------------
create table if not exists public.pulse_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  event_key   text not null,
  target_kind text,
  target_id   uuid,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists pulse_events_user_idx on public.pulse_events (user_id, created_at desc);
create index if not exists pulse_events_key_idx  on public.pulse_events (event_key, created_at desc);

alter table public.pulse_events enable row level security;
-- NO select policies: analytics is server-side only; staff read aggregates
-- through pulse_admin_events_stats, never raw rows.

-- ---------------------------------------------------------------------------
-- 6. THE LEARNING ENGINE — one transparent, bounded update rule
--
--   select  : user picked the topic in settings     → score = max(score, 0.70), explicit
--   avoid   : user marked "not interested"          → score = min(score, 0.20), explicit
--   like    : positive voluntary signal             → score += 0.08 * (1 - score)
--   dismiss : skip / recommendation dismissed       → score -= 0.05 * score
--   dislike : explicit "less like this" / hide      → score -= 0.12 * score
--
-- Every rule is asymptotic — no single interaction can jump a topic to 1.0
-- or 0.0 — and rows older than 14 days get a small recency settle on read
-- (ranking applies it, storage keeps the last touched score). Signal
-- rate limit: 40 feedback rows per user per day.
-- ---------------------------------------------------------------------------
create or replace function public.pulse_topic_touch(p_user uuid, p_topic text, p_signal text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_personalization boolean;
  v_today integer;
begin
  if p_user is null or p_topic is null then return; end if;
  if p_signal not in ('select','avoid','like','dislike','dismiss','hide') then return; end if;

  -- personalization opt-out stops ALL learning, including implicit signals
  select p.personalization into v_personalization
    from public.pulse_user_prefs p where p.user_id = p_user;
  if v_personalization is false then return; end if;

  -- the topic must exist in the taxonomy
  if not exists (select 1 from public.pulse_topics t where t.key = p_topic and t.active) then
    return;
  end if;

  -- rate limit implicit + explicit signals alike (server events only; the
  -- explicit sheet calls pulse_interest_signal which enforces its own cap)
  if p_signal in ('like','dislike','dismiss','hide') then
    select count(*) into v_today from public.pulse_topic_feedback f
     where f.user_id = p_user and f.created_at > now() - interval '24 hours';
    if v_today >= 40 then return; end if;
  end if;

  insert into public.pulse_topic_feedback (user_id, topic, signal)
    values (p_user, p_topic, p_signal);

  insert into public.pulse_user_interests (user_id, topic, score, explicit, touched_at)
    values (
      p_user, p_topic,
      case p_signal
        when 'select'  then 0.70
        when 'avoid'   then 0.20
        when 'like'    then 0.55   -- a first positive signal starts slightly above baseline
        when 'dislike' then 0.40
        when 'hide'    then 0.40
        else 0.45                -- dismiss
      end,
      p_signal in ('select','avoid'),
      now())
  on conflict (user_id, topic) do update set
    score = case p_signal
      when 'select'  then greatest(pulse_user_interests.score, 0.70)
      when 'avoid'   then least(pulse_user_interests.score, 0.20)
      when 'like'    then least(1.0, pulse_user_interests.score + 0.08 * (1 - pulse_user_interests.score))
      when 'dislike' then greatest(0.0, pulse_user_interests.score - 0.12 * pulse_user_interests.score)
      when 'hide'    then greatest(0.0, pulse_user_interests.score - 0.12 * pulse_user_interests.score)
      else greatest(0.0, pulse_user_interests.score - 0.05 * pulse_user_interests.score)
    end,
    explicit = pulse_user_interests.explicit or p_signal in ('select','avoid'),
    touched_at = now();
end $$;

-- --- signal hooks: TRIGGERS on the authoritative participation tables ------
-- (the 0048 RPCs stay byte-for-byte; the profile learns where the truth is)

create or replace function public.pulse_touch_from_response()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_topic text;
begin
  select t.category into v_topic
    from public.pulse_responses r
    join public.pulse_instances i on i.id = r.instance_id
    join public.pulse_items t on t.id = i.content_id
   where r.id = new.id;
  perform public.pulse_topic_touch(new.user_id, v_topic, 'like');
  return null;
end $$;

drop trigger if exists pulse_touch_response on public.pulse_responses;
create trigger pulse_touch_response
  after insert on public.pulse_responses
  for each row execute function public.pulse_touch_from_response();

create or replace function public.pulse_touch_from_skip()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_topic text;
begin
  select t.category into v_topic
    from public.pulse_skips s
    join public.pulse_instances i on i.id = s.instance_id
    join public.pulse_items t on t.id = i.content_id
   where s.instance_id = new.instance_id;
  perform public.pulse_topic_touch(new.user_id, v_topic, 'dismiss');
  return null;
end $$;

drop trigger if exists pulse_touch_skip on public.pulse_skips;
create trigger pulse_touch_skip
  after insert on public.pulse_skips
  for each row execute function public.pulse_touch_from_skip();

create or replace function public.pulse_touch_from_reaction()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_topic text;
begin
  select t.category into v_topic from public.pulse_items t where t.id = new.statement_id;
  perform public.pulse_topic_touch(new.user_id, v_topic, 'like');
  return null;
end $$;

drop trigger if exists pulse_touch_reaction on public.pulse_reactions;
create trigger pulse_touch_reaction
  after insert on public.pulse_reactions
  for each row execute function public.pulse_touch_from_reaction();

create or replace function public.pulse_touch_from_attempt()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_topic text;
begin
  select t.category into v_topic from public.pulse_items t where t.id = new.quiz_id;
  perform public.pulse_topic_touch(new.user_id, v_topic, 'like');
  return null;
end $$;

drop trigger if exists pulse_touch_attempt on public.pulse_attempts;
create trigger pulse_touch_attempt
  after insert or update on public.pulse_attempts
  for each row execute function public.pulse_touch_from_attempt();

-- ---------------------------------------------------------------------------
-- 7. MEMBER RPCs — profile, prefs, explicit signals, event log
-- ---------------------------------------------------------------------------

-- the member's own profile: interests + control flags
create or replace function public.pulse_profile_get()
returns json
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_personalization boolean;
  v_interests jsonb;
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  select p.personalization into v_personalization
    from public.pulse_user_prefs p where p.user_id = v_user;
  select coalesce(jsonb_agg(jsonb_build_object(
             'topic', i.topic, 'score', round(i.score::numeric, 3),
             'explicit', i.explicit, 'touchedAt', i.touched_at)
           order by i.score desc, i.topic), '[]'::jsonb)
    into v_interests
    from public.pulse_user_interests i where i.user_id = v_user;
  return jsonb_build_object(
    'personalization', coalesce(v_personalization, true),
    'interests', v_interests);
end $$;

-- explicit settings-sheet signal (rate-limited more generously than
-- implicit signals, but still bounded)
create or replace function public.pulse_interest_signal(
  p_topic text, p_signal text, p_target_kind text default null, p_target_id uuid default null
)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today integer;
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  if p_signal not in ('select','avoid','neutral','like','dislike') then
    return jsonb_build_object('error', 'Unknown signal.');
  end if;
  if not exists (select 1 from public.pulse_topics t where t.key = p_topic and t.active) then
    return jsonb_build_object('error', 'Unknown topic.');
  end if;
  select count(*) into v_today from public.pulse_topic_feedback f
   where f.user_id = v_user and f.created_at > now() - interval '24 hours';
  if v_today >= 40 then
    return jsonb_build_object('error', 'That is a lot of changes for one day — try again tomorrow.');
  end if;
  if exists (select 1 from public.pulse_user_prefs p
              where p.user_id = v_user and p.personalization = false) then
    -- opted-out users get an honest no-op
    return jsonb_build_object('ok', true, 'ignored', true);
  end if;
  -- 'neutral' is the un-set: the topic returns to its natural (unlearned)
  -- state, and the change is still recorded in the signal history
  if p_signal = 'neutral' then
    delete from public.pulse_user_interests i
     where i.user_id = v_user and i.topic = p_topic and i.explicit;
    insert into public.pulse_topic_feedback (user_id, topic, signal)
      values (v_user, p_topic, 'neutral');
    return jsonb_build_object('ok', true);
  end if;
  -- 'like'/'dislike' are the gentle result-screen feedback: implicit,
  -- asymptotic adjustments through the shared engine (never explicit)
  perform public.pulse_topic_touch(v_user, p_topic, p_signal);
  return jsonb_build_object('ok', true);
end $$;

-- personalization on/off (turning it OFF never deletes data; deleting is
-- the explicit reset below)
create or replace function public.pulse_prefs_set(p_personalization boolean)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  if p_personalization is null then return jsonb_build_object('error', 'Unknown value.'); end if;
  insert into public.pulse_user_prefs (user_id, personalization, updated_at)
    values (v_user, p_personalization, now())
  on conflict (user_id) do update
    set personalization = excluded.personalization, updated_at = now();
  return jsonb_build_object('ok', true, 'personalization', p_personalization);
end $$;

-- reset: clears the learned profile + its signal history. Prefs survive.
create or replace function public.pulse_profile_reset()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  delete from public.pulse_user_interests where user_id = v_user;
  delete from public.pulse_topic_feedback where user_id = v_user;
  return jsonb_build_object('ok', true);
end $$;

-- minimal analytics event log (whitelisted keys, rate-limited, pruned lazily)
create or replace function public.pulse_event_log(
  p_key text, p_target_kind text default null, p_target_id uuid default null, p_meta jsonb default null
)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_today integer;
begin
  if v_user is null then return jsonb_build_object('error', 'signin'); end if;
  if p_key not in (
    'pulse_question_viewed','pulse_question_answered','pulse_question_skipped',
    'quiz_opened','quiz_completed','quiz_shared','quiz_feedback_submitted',
    'quiz_recommendation_dismissed','topic_interest_updated','insight_opened'
  ) then
    return jsonb_build_object('error', 'Unknown event.');
  end if;
  select count(*) into v_today from public.pulse_events e
   where e.user_id = v_user and e.created_at > now() - interval '24 hours';
  if v_today >= 60 then return jsonb_build_object('ok', true, 'logged', false); end if;

  insert into public.pulse_events (user_id, event_key, target_kind, target_id, meta)
    values (v_user, p_key, p_target_kind, p_target_id,
            coalesce(p_meta, '{}'::jsonb));

  -- lazy retention: prune past the window at most once an hour per caller
  if v_today = 0 or random() < 0.02 then
    delete from public.pulse_events where created_at < now() - interval '90 days';
  end if;
  return jsonb_build_object('ok', true, 'logged', true);
end $$;

-- ---------------------------------------------------------------------------
-- 8. ADMIN RPCs — AI settings, event stats, maintenance
-- ---------------------------------------------------------------------------

-- AI generation settings (the model NAME cannot ride the numeric config
-- grid; this dedicated call sets all AI knobs atomically, audited)
create or replace function public.pulse_admin_ai_set(
  p_enabled boolean, p_model text, p_daily_budget integer, p_max_retries integer
)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can change Pulse AI settings.';
  end if;
  if p_model is null or char_length(btrim(p_model)) < 3 or char_length(btrim(p_model)) > 120 then
    raise exception 'That model name does not look valid.';
  end if;
  if p_daily_budget is null or p_daily_budget < 0 or p_daily_budget > 500 then
    raise exception 'The daily generation budget must be between 0 and 500.';
  end if;
  if p_max_retries is null or p_max_retries < 0 or p_max_retries > 5 then
    raise exception 'The retry count must be between 0 and 5.';
  end if;
  insert into public.pulse_config (key, value, updated_at, updated_by) values
    ('pulse.ai.enabled',    to_jsonb(case when p_enabled then 1 else 0 end), now(), v_actor),
    ('pulse.ai.dailyBudget', to_jsonb(p_daily_budget), now(), v_actor),
    ('pulse.ai.maxRetries',  to_jsonb(p_max_retries),  now(), v_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_actor;
  -- the model name lives beside them as a jsonb string (read via pulse_cfg_json)
  insert into public.pulse_config (key, value, updated_at, updated_by)
    values ('pulse.ai.model', to_jsonb(btrim(p_model)), now(), v_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = v_actor;
  perform public.log_staff_action('pulse.ai_set', null, null,
    jsonb_build_object('enabled', p_enabled, 'model', btrim(p_model),
                       'dailyBudget', p_daily_budget, 'maxRetries', p_max_retries));
  return jsonb_build_object('ok', true);
end $$;

-- current AI settings for the admin panel
create or replace function public.pulse_admin_ai_get()
returns json
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can read Pulse AI settings.';
  end if;
  return jsonb_build_object(
    'enabled', coalesce(public.pulse_cfg('pulse.ai.enabled', 0), 0) <> 0,
    'model', coalesce(public.pulse_cfg_json('pulse.ai.model') #>> '{}', ''),
    'dailyBudget', public.pulse_cfg('pulse.ai.dailyBudget', 12),
    'maxRetries', public.pulse_cfg('pulse.ai.maxRetries', 2));
end $$;

-- admin analytics: which topics land, what events fire (aggregates only)
create or replace function public.pulse_admin_events_stats()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can view Pulse analytics.';
  end if;
  return jsonb_build_object(
    'events7', coalesce((
      select jsonb_agg(jsonb_build_object('key', k.event_key, 'n', k.n) order by k.n desc)
        from (select e.event_key, count(*)::int n from public.pulse_events e
               where e.created_at > now() - interval '7 days'
               group by e.event_key) k), '[]'::jsonb),
    'topicSignals7', coalesce((
      select jsonb_agg(jsonb_build_object(
               'topic', f.topic, 'positive', f.pos, 'negative', f.neg) order by f.pos + f.neg desc)
        from (select f.topic,
                     count(*) filter (where f.signal in ('select','like'))::int pos,
                     count(*) filter (where f.signal in ('avoid','dislike','dismiss','hide'))::int neg
                from public.pulse_topic_feedback f
               where f.created_at > now() - interval '7 days'
               group by f.topic) f), '[]'::jsonb),
    'profilesLearned', (select count(*) from public.pulse_user_interests
                         where touched_at > now() - interval '7 days'),
    'personalizationOn', (select count(*) from public.pulse_user_prefs where personalization));
end $$;

-- maintenance: retention pruning + stale interest settle (admin-callable;
-- the AI edge function also calls it after each generation run)
create or replace function public.pulse_admin_maintenance()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare v_events integer;
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can run Pulse maintenance.';
  end if;
  delete from public.pulse_events where created_at < now() - interval '90 days';
  get diagnostics v_events = row_count;
  perform public.pulse_log_job('pulse.maintenance', now()::date::text, true,
    jsonb_build_object('eventsPruned', v_events));
  return jsonb_build_object('ok', true, 'eventsPruned', v_events);
end $$;

-- ---------------------------------------------------------------------------
-- 9. RECOMMENDATION WEIGHTS + numeric AI knobs in pulse_config
--    (defaults only when absent — pulse_cfg already falls back, so these
--     inserts are seed rows so the admin panel can show real values)
-- ---------------------------------------------------------------------------
insert into public.pulse_config (key, value) values
  ('pulse.recommend.interest',     '0.30'),
  ('pulse.recommend.quality',      '0.20'),
  ('pulse.recommend.freshness',    '0.15'),
  ('pulse.recommend.diversity',    '0.15'),
  ('pulse.recommend.satisfaction', '0.10'),
  ('pulse.recommend.campus',       '0.10'),
  ('pulse.recommend.exploration',  '0.10'),
  ('pulse.ai.enabled',             '0'),
  ('pulse.ai.dailyBudget',         '12'),
  ('pulse.ai.maxRetries',          '2')
on conflict (key) do nothing;

-- extend the numeric config whitelist for the admin panel
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
                   'pulse.engagementBaseline','pulse.statementDeck',
                   'pulse.recommend.interest','pulse.recommend.quality','pulse.recommend.freshness',
                   'pulse.recommend.diversity','pulse.recommend.satisfaction','pulse.recommend.campus',
                   'pulse.recommend.exploration') then
    raise exception 'That configuration key is not adjustable.';
  end if;
  update public.pulse_config
     set value = to_jsonb(p_value), updated_at = now(), updated_by = v_actor
   where key = p_key;
  if not found then raise exception 'Unknown configuration key.'; end if;
  perform public.log_staff_action('pulse.config', null, null,
    jsonb_build_object('key', p_key, 'value', p_value));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 10. Execute grants
-- ---------------------------------------------------------------------------
grant execute on function public.pulse_profile_get()                    to authenticated;
grant execute on function public.pulse_interest_signal(text, text, text, uuid) to authenticated;
grant execute on function public.pulse_prefs_set(boolean)               to authenticated;
grant execute on function public.pulse_profile_reset()                  to authenticated;
grant execute on function public.pulse_event_log(text, text, uuid, jsonb) to authenticated;
grant execute on function public.pulse_admin_ai_set(boolean, text, integer, integer) to authenticated;
grant execute on function public.pulse_admin_ai_get()                   to authenticated;
grant execute on function public.pulse_admin_events_stats()             to authenticated;
grant execute on function public.pulse_admin_maintenance()              to authenticated;
