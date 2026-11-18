-- =============================================================================
-- 0073 — CAMPUS PULSE 2.1: THE AUTONOMOUS ENGINE
--
-- Keeps every guarantee from 0048/0072. Adds the missing autonomy layer:
--
--   1. CATEGORY RESOLUTION FIX (audit finding): the seeded library uses
--      legacy categories (sleep, deadline, wifi, canteen, …) that are not in
--      the 0072 topic taxonomy, so statement reactions silently never taught
--      the profile. pulse_topic_touch now resolves through a deterministic
--      legacy→topic map (exact taxonomy match still wins).
--   2. pulse_items.origin — 'authored' | 'ai', so AI content is always
--      distinguishable in the library and audits.
--   3. AUTO-PUBLISH TOGGLE: pulse.ai.autoPublish — when on, the validated
--      pulse-generate function inserts quizzes as status='approved'
--      (origin='ai') instead of draft. Manual approval flow unchanged.
--   4. COHORT NOTIFICATIONS: when a quiz becomes approved, the interest
--      cohort (users whose learned profile scores that topic high) gets one
--      in-app + push notification (type pulse_quiz). New 'pulse' notification
--      category — visible and controllable in notification settings.
--   5. MANUAL PUSH: pulse_admin_push_quiz(p_item, 'cohort'|'all') — the
--      admin override button; works even when auto-notify is off.
--   6. NUDGES: pulse_nudge_idle() — students idle for N days with a push
--      device get at most one gentle nudge per week pointing at a random
--      approved quiz. No streak guilt, no fake urgency, capped per run.
--   7. COHORT DEMAND: pulse_cohort_demand() — per-topic cohort sizes and
--      quiz coverage; the cron-mode edge function generates for the largest
--      underserved cohort (generation follows real demand, not guesses).
--
-- Nothing here weakens security: notification recipients are computed
-- server-side; the browser still cannot forge notifications, quiz states,
-- votes or profiles.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. pulse_items.origin — AI content is always identifiable
-- ---------------------------------------------------------------------------
alter table public.pulse_items
  add column if not exists origin text not null default 'authored'
  check (origin in ('authored', 'ai'));

-- ---------------------------------------------------------------------------
-- 2. CATEGORY RESOLUTION — legacy seed categories → taxonomy topics
--    Exact pulse_topics match wins; the map only catches the legacy rows.
-- ---------------------------------------------------------------------------
create or replace function public.pulse_topic_resolve(p_category text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_topic text;
begin
  if p_category is null then return null; end if;
  select t.key into v_topic
    from public.pulse_topics t where t.key = p_category and t.active;
  if v_topic is not null then return v_topic; end if;
  return case btrim(lower(p_category))
    when 'campus_lib'    then 'exams'
    when 'campus_improve' then 'campus_life'
    when 'project'       then 'exams'
    when 'group'         then 'campus_life'
    when 'laptop'        then 'technology'
    when 'sleep'         then 'hostel'
    when 'deadline'      then 'exams'
    when 'timetable'     then 'exams'
    when 'notes'         then 'exams'
    when 'attendance'    then 'exams'
    when 'canteen'       then 'food'
    when 'lectures'      then 'exams'
    when 'wifi'          then 'technology'
    when 'intro'         then 'campus_life'
    else null
  end;
end $$;

-- pulse_topic_touch v2: identical learning rules (0072), but the topic is
-- resolved through the map so legacy categories finally teach the profile.
create or replace function public.pulse_topic_touch(p_user uuid, p_topic text, p_signal text)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_personalization boolean;
  v_today integer;
  v_topic text;
begin
  if p_user is null or p_topic is null then return; end if;
  if p_signal not in ('select','avoid','like','dislike','dismiss','hide') then return; end if;

  -- resolve the (possibly legacy) category to an active taxonomy topic
  v_topic := public.pulse_topic_resolve(p_topic);
  if v_topic is null then return; end if;

  -- personalization opt-out stops ALL learning, including implicit signals
  select p.personalization into v_personalization
    from public.pulse_user_prefs p where p.user_id = p_user;
  if v_personalization is false then return; end if;

  -- rate limit implicit + explicit signals alike (server events only; the
  -- explicit sheet calls pulse_interest_signal which enforces its own cap)
  if p_signal in ('like','dislike','dismiss','hide') then
    select count(*) into v_today from public.pulse_topic_feedback f
     where f.user_id = p_user and f.created_at > now() - interval '24 hours';
    if v_today >= 40 then return; end if;
  end if;

  insert into public.pulse_topic_feedback (user_id, topic, signal)
    values (p_user, v_topic, p_signal);

  insert into public.pulse_user_interests (user_id, topic, score, explicit, touched_at)
    values (
      p_user, v_topic,
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

-- ---------------------------------------------------------------------------
-- 3. CONFIG — autonomy toggles + thresholds (numeric grid, admin-adjustable)
-- ---------------------------------------------------------------------------
insert into public.pulse_config (key, value) values
  ('pulse.ai.autoPublish',          '0'),    -- OFF by default: validated drafts still wait for a human
  ('pulse.notify.auto',             '1'),    -- cohort notifications on approval
  ('pulse.notify.cohortMinScore',   '0.65'), -- who counts as "this is my interest"
  ('pulse.notify.cohortCap',        '300'),  -- max recipients per quiz blast
  ('pulse.nudge.idleDays',          '7'),    -- idle window before a nudge is allowed
  ('pulse.nudge.cap',               '100')   -- max nudges per maintenance run
on conflict (key) do nothing;

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
                   'pulse.recommend.exploration',
                   'pulse.ai.enabled','pulse.ai.dailyBudget','pulse.ai.maxRetries','pulse.ai.autoPublish',
                   'pulse.notify.auto','pulse.notify.cohortMinScore','pulse.notify.cohortCap',
                   'pulse.nudge.idleDays','pulse.nudge.cap') then
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
-- 4. NOTIFICATION PLUMBING — new 'pulse' category, fully user-controllable
-- ---------------------------------------------------------------------------

alter table public.notification_prefs
  add column if not exists pulse_inapp boolean not null default true,
  add column if not exists pulse_push  boolean not null default true;

create or replace function public.notification_category(p_type text)
returns text
language sql immutable as $$
  select case
    when p_type in ('post_like', 'post_repost', 'comment_like') then 'like'
    when p_type in ('post_comment', 'post_reply')                  then 'comment'
    when p_type = 'follow'                                         then 'follow'
    when p_type in ('post_mention', 'chat_mention')                then 'mention'
    when p_type = 'chat_message'                                   then 'message'
    when p_type in ('chat_reply', 'club_join_accepted', 'club_join_rejected',
                    'club_invitation', 'club_role_changed', 'club_banned',
                    'club_removed', 'club_ownership')              then 'community'
    when p_type in ('event_updated', 'event_cancelled', 'event_registered',
                    'event_promoted')                              then 'event'
    when p_type in ('listing_removed', 'listing_restored')         then 'marketplace'
    when p_type in ('pulse_quiz', 'pulse_nudge')                   then 'pulse'
    else 'account'
  end
$$;

create or replace function public.notif_inapp_allowed(p_user uuid, p_cat text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case p_cat
    when 'like'        then (public.notif_prefs_of(p_user)).like_inapp
    when 'comment'     then (public.notif_prefs_of(p_user)).comment_inapp
    when 'follow'      then (public.notif_prefs_of(p_user)).follow_inapp
    when 'mention'     then (public.notif_prefs_of(p_user)).mention_inapp
    when 'message'     then (public.notif_prefs_of(p_user)).message_inapp
    when 'community'   then (public.notif_prefs_of(p_user)).community_inapp
    when 'event'       then (public.notif_prefs_of(p_user)).event_inapp
    when 'marketplace' then (public.notif_prefs_of(p_user)).marketplace_inapp
    when 'pulse'       then (public.notif_prefs_of(p_user)).pulse_inapp
    else true
  end
$$;

create or replace function public.notif_push_allowed(p_user uuid, p_cat text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case p_cat
    when 'like'        then (public.notif_prefs_of(p_user)).like_push
    when 'comment'     then (public.notif_prefs_of(p_user)).comment_push
    when 'follow'      then (public.notif_prefs_of(p_user)).follow_push
    when 'mention'     then (public.notif_prefs_of(p_user)).mention_push
    when 'message'     then (public.notif_prefs_of(p_user)).message_push
    when 'community'   then (public.notif_prefs_of(p_user)).community_push
    when 'event'       then (public.notif_prefs_of(p_user)).event_push
    when 'marketplace' then (public.notif_prefs_of(p_user)).marketplace_push
    when 'pulse'       then (public.notif_prefs_of(p_user)).pulse_push
    else true
  end
$$;

-- merge a whitelist of columns; returns the stored row (0029/0029c body +
-- the pulse keys)
create or replace function public.update_notification_prefs(p_update jsonb)
returns public.notification_prefs
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := auth.uid();
  v_key  text;
  v_val  jsonb;
  v_row  public.notification_prefs;
begin
  if v_me is null then
    raise exception 'Sign in to manage notification settings.';
  end if;
  insert into public.notification_prefs (user_id) values (v_me)
  on conflict (user_id) do nothing;

  for v_key, v_val in select * from jsonb_each(coalesce(p_update, '{}'::jsonb))
  loop
    if v_key in (
      'like_inapp','like_push','comment_inapp','comment_push',
      'follow_inapp','follow_push','mention_inapp','mention_push',
      'message_inapp','message_push','community_inapp','community_push',
      'event_inapp','event_push','marketplace_inapp','marketplace_push',
      'pulse_inapp','pulse_push',
      'message_preview','quiet_enabled'
    ) then
      if jsonb_typeof(v_val) is distinct from 'boolean' then
        raise exception 'Setting % must be true or false.', v_key;
      end if;
      execute format('update public.notification_prefs set %I = %s, updated_at = now() where user_id = %L',
                     v_key, v_val::text, v_me);
    elsif v_key = 'quiet_start' or v_key = 'quiet_end' then
      if jsonb_typeof(v_val) is distinct from 'string'
         or (v_val #>> '{}') !~ '^\d{2}:\d{2}$'
         or split_part(v_val #>> '{}', ':', 1)::int > 23
         or split_part(v_val #>> '{}', ':', 2)::int > 59 then
        raise exception 'Quiet-hours time must be a valid HH:MM value.';
      end if;
      execute format('update public.notification_prefs set %I = %L, updated_at = now() where user_id = %L',
                     v_key, v_val #>> '{}', v_me);
    elsif v_key = 'timezone' then
      if jsonb_typeof(v_val) = 'null' then
        update public.notification_prefs
          set timezone = null, updated_at = now()
          where user_id = v_me;
      elsif jsonb_typeof(v_val) is distinct from 'string'
            or (select count(*) from pg_timezone_names
                where lower(name) = lower(v_val #>> '{}')) = 0 then
        raise exception 'That timezone is not valid.';
      else
        update public.notification_prefs
          set timezone = v_val #>> '{}', updated_at = now()
          where user_id = v_me;
      end if;
    else
      raise exception 'Unknown notification setting: %', v_key;
    end if;
  end loop;

  select * into v_row from public.notification_prefs where user_id = v_me;
  return v_row;
end $$;

-- human push payloads for the pulse types (titles/bodies are server-built
-- from validated data only — the quiz title already passed generation checks)
create or replace function public.notification_push_payload(p_row public.notifications)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_actor     record;
  v_prefs     public.notification_prefs;
  v_cat       text;
  v_title     text;
  v_body      text;
  v_url       text := '';
  v_tag       text;
  v_post      uuid;
  v_msg       record;
  v_preview   text;
begin
  v_prefs := public.notif_prefs_of(p_row.recipient_id);
  v_cat   := public.notification_category(p_row.type);
  select username, display_name into v_actor
    from public.profiles where id = p_row.actor_id;
  v_post := coalesce(p_row.metadata ->> 'post_id', p_row.entity_id::text);

  if p_row.type = 'chat_message' then
    v_title := coalesce(v_actor.display_name, 'Someone') || ' sent a message';
    if v_prefs.message_preview then
      select b.body, b.attachments, b.shared_kind into v_msg
        from public.chat_messages b
       where b.conversation_id = p_row.entity_id
         and b.deleted_at is null
       order by b.created_at desc limit 1;
      v_preview := null;
      if found then
        if coalesce(btrim(v_msg.body), '') <> '' then
          v_preview := left(btrim(v_msg.body), 80);
        elsif v_msg.shared_kind is not null then
          v_preview := 'shared a post with you';
        elsif v_msg.attachments is not null
          and jsonb_array_length(v_msg.attachments) > 0 then
          v_preview := 'sent an attachment';
        end if;
      end if;
      if v_preview is null then
        v_body := 'New message — open to read';
      else
        v_body := v_preview;
      end if;
    else
      v_body := 'New message — open to read';
    end if;
    v_url := '#chat/' || coalesce(p_row.entity_id::text, '');
    v_tag := 'chat:' || coalesce(p_row.entity_id::text, '');
    return jsonb_build_object('title', v_title, 'body', v_body,
                              'url', v_url, 'tag', v_tag);

  elsif p_row.type = 'follow' then
    v_title := 'New follower';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' started following you';
    v_url   := case when v_actor.username is null then ''
                    else '#u/' || v_actor.username end;

  elsif p_row.type = 'post_like' then
    v_title := 'New like';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' liked your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'post_repost' then
    v_title := 'New repost';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' reposted your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'comment_like' then
    v_title := 'New like';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' liked your comment';
    v_url   := '#p/' || coalesce(v_post, '');

  elsif p_row.type = 'post_comment' then
    v_title := 'New comment';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' commented on your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'post_reply' then
    v_title := 'New reply';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' replied to your ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');

  elsif p_row.type = 'post_mention' then
    v_title := 'Mention';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' mentioned you in a ' ||
               coalesce(p_row.metadata ->> 'kind', 'post');
    v_url   := '#p/' || coalesce(v_post, '');
  elsif p_row.type = 'chat_mention' then
    v_title := 'Mention';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' mentioned you in a community chat';
    v_url   := '#chat/' || coalesce(p_row.entity_id::text, '');
  elsif p_row.type = 'chat_reply' then
    v_title := 'Reply';
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' replied to your message in a community chat';
    v_url   := '#chat/' || coalesce(p_row.entity_id::text, '');

  elsif p_row.type = 'pulse_quiz' then
    v_title := 'New quiz on CAMPUS Pulse';
    v_body  := coalesce(nullif(p_row.metadata ->> 'title', ''), 'A fresh quiz just landed — see how you score');
    v_tag   := 'pulse_quiz:' || coalesce(p_row.entity_id::text, '');
    return jsonb_build_object('title', v_title, 'body', v_body,
                              'url', v_url, 'tag', v_tag);

  elsif p_row.type = 'pulse_nudge' then
    v_title := 'Campus Pulse';
    v_body  := coalesce(nullif(p_row.metadata ->> 'title', ''), 'A fresh quiz is waiting — no streak, no pressure');
    v_tag   := 'pulse_nudge:' || coalesce(p_row.entity_id::text, '');
    return jsonb_build_object('title', v_title, 'body', v_body,
                              'url', v_url, 'tag', v_tag);

  -- administrative/community/event/marketplace/system
  else
    v_title := case p_row.type
      when 'club_join_accepted' then 'Join request accepted'
      when 'club_join_rejected' then 'Join request declined'
      when 'club_invitation'    then 'Community invitation'
      when 'club_role_changed'  then 'Community role updated'
      when 'club_banned'        then 'Removed from a community'
      when 'club_removed'       then 'Removed from a community'
      when 'club_ownership'     then 'Community ownership transferred'
      when 'event_updated'      then 'Event update'
      when 'event_cancelled'    then 'Event cancelled'
      when 'event_registered'   then 'RSVP confirmed'
      when 'event_promoted'     then 'Promoted to event host'
      when 'listing_removed'    then 'Listing removed'
      when 'listing_restored'   then 'Listing restored'
      else 'CAMPUS notification'
    end;
    -- entity display names, resolved only for the recipient's own rows
    declare
      v_name text;
    begin
      if p_row.entity_type = 'club' then
        select c.name into v_name from public.clubs c where c.id = p_row.entity_id;
      elsif p_row.entity_type = 'event' then
        select e.title into v_name from public.events e where e.id = p_row.entity_id;
      elsif p_row.entity_type = 'listing' then
        select l.title into v_name from public.marketplace_listings l where l.id = p_row.entity_id;
      end if;
      v_body := case p_row.type
        when 'club_join_accepted' then 'Your request to join '     || coalesce(v_name, 'the community') || ' was accepted'
        when 'club_join_rejected' then 'Your request to join '     || coalesce(v_name, 'the community') || ' was declined'
        when 'club_invitation'    then coalesce(v_actor.display_name, 'Someone') || ' invited you to join ' || coalesce(v_name, 'a community')
        when 'club_role_changed'  then 'Your role in '             || coalesce(v_name, 'a community') || ' changed'
        when 'club_banned'        then 'You have been removed from ' || coalesce(v_name, 'a community')
        when 'club_removed'       then 'You have been removed from ' || coalesce(v_name, 'a community')
        when 'club_ownership'     then coalesce(v_name, 'A community') || ' changed ownership'
        when 'event_updated'      then coalesce(v_actor.display_name, 'Someone') || ' updated ' || coalesce(v_name, 'an event')
        when 'event_cancelled'    then coalesce(v_actor.display_name, 'Someone') || ' cancelled ' || coalesce(v_name, 'an event')
        when 'event_registered'   then 'Your spot for '            || coalesce(v_name, 'the event') || ' is confirmed'
        when 'event_promoted'     then 'You are now a host of '    || coalesce(v_name, 'an event')
        when 'listing_removed'    then 'Your listing '             || coalesce(v_name, '') || ' was removed'
        when 'listing_restored'   then 'Your listing '             || coalesce(v_name, '') || ' is live again'
        else 'Open CAMPUS to see the details'
      end;
      if p_row.entity_type = 'club' then
        select '#c/' || c.slug into v_url
          from public.clubs c where c.id = p_row.entity_id;
      elsif p_row.entity_type = 'event' then
        select '#e/' || e.slug into v_url
          from public.events e where e.id = p_row.entity_id;
      elsif p_row.entity_type = 'listing' then
        select '#m/' || l.slug into v_url
          from public.marketplace_listings l where l.id = p_row.entity_id;
      else
        v_url := '';
      end if;
    end;
  end if;

  v_tag := p_row.type || ':' || coalesce(
    p_row.metadata ->> 'comment_id',
    p_row.metadata ->> 'post_id',
    p_row.entity_id::text,
    '');
  return jsonb_build_object('title', v_title, 'body', v_body,
                            'url', coalesce(v_url, ''), 'tag', v_tag);
end $$;

-- enqueue gate gains the pulse branch (0029 body + pulse)
create or replace function public.notifications_enqueue_push()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_prefs public.notification_prefs;
  v_cat   text;
  v_push  boolean;
  v_payload jsonb;
begin
  v_prefs := public.notif_prefs_of(new.recipient_id);
  v_cat   := public.notification_category(new.type);
  v_push := case v_cat
    when 'like'        then v_prefs.like_push
    when 'comment'     then v_prefs.comment_push
    when 'follow'      then v_prefs.follow_push
    when 'mention'     then v_prefs.mention_push
    when 'message'     then v_prefs.message_push
    when 'community'   then v_prefs.community_push
    when 'event'       then v_prefs.event_push
    when 'marketplace' then v_prefs.marketplace_push
    when 'pulse'       then v_prefs.pulse_push
    else true -- account / security notices always eligible
  end;
  if not v_push or public.notif_is_quiet(new.recipient_id) then
    return null;
  end if;
  if not exists (
    select 1 from public.push_subscriptions s
    where s.user_id = new.recipient_id
  ) then
    return null; -- nothing registered: no queue churn
  end if;
  v_payload := public.notification_push_payload(new);
  insert into public.push_queue (notification_id, recipient_id, payload)
    values (new.id, new.recipient_id, v_payload);
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 5. COHORT NOTIFICATION ON APPROVAL
--    When a quiz becomes approved (manual approval OR auto-publish), the
--    interest cohort gets ONE notification each. Same-quiz re-saves are
--    deduped; recipients are computed server-side only.
-- ---------------------------------------------------------------------------
create or replace function public.pulse_notify_quiz(p_item uuid)
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_item record;
  v_topic text;
  v_min numeric;
  v_cap int;
  v_count int := 0;
begin
  select * into v_item from public.pulse_items i
   where i.id = p_item and i.kind = 'quiz' and i.status = 'approved';
  if v_item.id is null then
    return jsonb_build_object('ok', false, 'reason', 'item-not-approved-quiz');
  end if;

  -- dedupe: re-saving an approved row must never re-blast the campus
  if exists (select 1 from public.notifications n
              where n.type = 'pulse_quiz' and n.entity_id = p_item
                and n.created_at > now() - interval '3 days') then
    return jsonb_build_object('ok', true, 'queued', 0, 'reason', 'recently-notified');
  end if;

  if public.pulse_cfg('pulse.notify.auto', 1) = 0 then
    return jsonb_build_object('ok', true, 'queued', 0, 'reason', 'notify-disabled');
  end if;

  v_topic := public.pulse_topic_resolve(v_item.category);
  if v_topic is null then
    return jsonb_build_object('ok', true, 'queued', 0, 'reason', 'no-topic');
  end if;

  v_min := public.pulse_cfg('pulse.notify.cohortMinScore', 0.65);
  v_cap := public.pulse_cfg('pulse.notify.cohortCap', 300)::int;

  -- the interest cohort: students whose learned profile says this topic is a
  -- strong interest; personalization respected (absent row = default on)
  for r in (
    select u.user_id
      from public.pulse_user_interests u
      left join public.pulse_user_prefs p on p.user_id = u.user_id
     where u.topic = v_topic
       and u.score >= v_min
       and coalesce(p.personalization, true)
     order by u.score desc
     limit v_cap
  ) loop
    if not exists (select 1 from public.notifications n
                    where n.recipient_id = r.user_id
                      and n.type = 'pulse_quiz'
                      and n.entity_id = p_item) then
      perform public.create_notification(
        r.user_id, null, 'pulse_quiz', 'pulse_item', p_item,
        jsonb_build_object('title', left(v_item.body, 120), 'topic', v_topic));
      v_count := v_count + 1;
    end if;
  end loop;

  perform public.pulse_log_job('pulse.notify', p_item::text, true,
    jsonb_build_object('topic', v_topic, 'queued', v_count));
  return jsonb_build_object('ok', true, 'queued', v_count, 'topic', v_topic);
end $$;

create or replace function public.pulse_notify_quiz_from_row()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform public.pulse_notify_quiz(new.id);
  return null;
end $$;

drop trigger if exists pulse_quiz_approved on public.pulse_items;
create trigger pulse_quiz_approved
  after insert or update of status on public.pulse_items
  for each row
  when (new.kind = 'quiz' and new.status = 'approved')
  execute function public.pulse_notify_quiz_from_row();

-- ---------------------------------------------------------------------------
-- 6. MANUAL PUSH — the admin override (works even with auto-notify off)
--    scope 'cohort' = interest cohort · scope 'all' = every member (capped)
-- ---------------------------------------------------------------------------
create or replace function public.pulse_admin_push_quiz(p_item uuid, p_scope text default 'cohort')
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_item record;
  v_topic text;
  v_min numeric;
  v_cap int;
  v_count int := 0;
begin
  if not public.has_op('pulse.admin') then
    raise exception 'Only campus admins can push Pulse quizzes.';
  end if;
  if p_scope not in ('cohort', 'all') then
    raise exception 'Push scope must be "cohort" or "all".';
  end if;
  select * into v_item from public.pulse_items i
   where i.id = p_item and i.kind = 'quiz' and i.status = 'approved';
  if v_item.id is null then
    raise exception 'That quiz is not approved — approve it first.';
  end if;

  -- per-item cooldown so a double-click can never spam the campus
  if exists (select 1 from public.notifications n
              where n.type = 'pulse_quiz' and n.entity_id = p_item
                and n.created_at > now() - interval '3 days') then
    return jsonb_build_object('ok', true, 'queued', 0, 'reason', 'recently-notified');
  end if;

  if p_scope = 'all' then
    for r in (
      select p.id from public.profiles p
       where p.id <> auth.uid()
       order by p.created_at desc
       limit 1000
    ) loop
      if not exists (select 1 from public.notifications n
                      where n.recipient_id = r.id
                        and n.type = 'pulse_quiz'
                        and n.entity_id = p_item) then
        perform public.create_notification(
          r.id, null, 'pulse_quiz', 'pulse_item', p_item,
          jsonb_build_object('title', left(v_item.body, 120), 'topic', v_item.category));
        v_count := v_count + 1;
      end if;
    end loop;
  else
    v_topic := public.pulse_topic_resolve(v_item.category);
    if v_topic is null then
      return jsonb_build_object('ok', true, 'queued', 0, 'reason', 'no-topic');
    end if;
    v_min := public.pulse_cfg('pulse.notify.cohortMinScore', 0.65);
    v_cap := public.pulse_cfg('pulse.notify.cohortCap', 300)::int;
    for r in (
      select u.user_id
        from public.pulse_user_interests u
        left join public.pulse_user_prefs p on p.user_id = u.user_id
       where u.topic = v_topic
         and u.score >= v_min
         and coalesce(p.personalization, true)
       order by u.score desc
       limit v_cap
    ) loop
      if not exists (select 1 from public.notifications n
                      where n.recipient_id = r.user_id
                        and n.type = 'pulse_quiz'
                        and n.entity_id = p_item) then
        perform public.create_notification(
          r.user_id, null, 'pulse_quiz', 'pulse_item', p_item,
          jsonb_build_object('title', left(v_item.body, 120), 'topic', v_topic));
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  perform public.log_staff_action('pulse.push_quiz', p_item, null,
    jsonb_build_object('scope', p_scope, 'queued', v_count));
  perform public.pulse_log_job('pulse.push', p_item::text, true,
    jsonb_build_object('scope', p_scope, 'queued', v_count));
  return jsonb_build_object('ok', true, 'queued', v_count, 'scope', p_scope);
end $$;

-- ---------------------------------------------------------------------------
-- 7. NUDGES — gentle, capped, at most one per student per week
-- ---------------------------------------------------------------------------
create or replace function public.pulse_nudge_idle()
returns json
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_idle int;
  v_cap int;
  v_quiz record;
  v_count int := 0;
begin
  -- the edge function's service client (cron) or a pulse admin may run this
  if auth.uid() is not null then
    if not public.has_op('pulse.admin') then
      raise exception 'Only campus admins can run Pulse nudges.';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Pulse nudges run through the server pipeline only.';
  end if;

  v_idle := public.pulse_cfg('pulse.nudge.idleDays', 7)::int;
  v_cap  := public.pulse_cfg('pulse.nudge.cap', 100)::int;

  select id, body into v_quiz
    from public.pulse_items
   where kind = 'quiz' and status = 'approved'
   order by random()
   limit 1;
  if v_quiz.id is null then
    return jsonb_build_object('ok', true, 'notified', 0, 'reason', 'no-quiz');
  end if;

  for r in (
    select p.id
      from public.profiles p
     where exists (select 1 from public.push_subscriptions s where s.user_id = p.id)          -- has a device
       and not exists (                                                                       -- genuinely idle
             select 1 from public.pulse_events e
              where e.user_id = p.id and e.created_at > now() - (v_idle || ' days')::interval)
       and not exists (
             select 1 from public.pulse_responses v
              where v.user_id = p.id and v.created_at > now() - (v_idle || ' days')::interval)
       and not exists (
             select 1 from public.pulse_reactions c
              where c.user_id = p.id and c.created_at > now() - (v_idle || ' days')::interval)
       and not exists (
             select 1 from public.pulse_attempts a
              where a.user_id = p.id and a.created_at > now() - (v_idle || ' days')::interval)
       and not exists (                                                                       -- at most one nudge a week
             select 1 from public.notifications n
              where n.recipient_id = p.id and n.type = 'pulse_nudge'
                and n.created_at > now() - interval '7 days')
       and not exists (                                                                       -- never stack on a fresh quiz ping
             select 1 from public.notifications n
              where n.recipient_id = p.id and n.type = 'pulse_quiz'
                and n.created_at > now() - interval '2 days')
     order by p.created_at desc
     limit v_cap
  ) loop
    perform public.create_notification(
      r.id, null, 'pulse_nudge', 'pulse_item', v_quiz.id,
      jsonb_build_object('title', left(v_quiz.body, 120)));
    v_count := v_count + 1;
  end loop;

  perform public.pulse_log_job('pulse.nudge', now()::date::text, true,
    jsonb_build_object('notified', v_count, 'idleDays', v_idle));
  return jsonb_build_object('ok', true, 'notified', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- 8. COHORT DEMAND — what the campus actually wants vs what exists
--    (cron-mode generation picks the largest underserved cohort)
-- ---------------------------------------------------------------------------
create or replace function public.pulse_cohort_demand()
returns json
language plpgsql stable security definer set search_path = ''
as $$
begin
  -- the edge function's service client (cron) or a pulse admin may read this
  if auth.uid() is not null then
    if not public.has_op('pulse.admin') then
      raise exception 'Only campus admins can read Pulse demand.';
    end if;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Pulse demand runs through the server pipeline only.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
              'topic', d.topic, 'cohort', d.cohort,
              'lastQuizDays', coalesce(d.last_quiz_days, 999))
            order by d.cohort desc)
      from (
        select t.key as topic,
               count(u.user_id)::int as cohort,
               extract(day from now() - max(i.created_at))::int as last_quiz_days
          from public.pulse_topics t
          left join public.pulse_user_interests u
                 on u.topic = t.key and u.score >= 0.65
          left join public.pulse_items i
                 on i.kind = 'quiz' and i.status = 'approved'
                and public.pulse_topic_resolve(i.category) = t.key
         where t.active
         group by t.key
      ) d
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------
grant execute on function public.pulse_admin_push_quiz(uuid, text) to authenticated;
