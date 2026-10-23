-- 0029c — hotfix for 0029: live marketplace table is public.marketplace_listings
-- (0019_marketplace.sql), but list_notifications / notification_push_payload
-- referenced public.listings, which does not exist. Postgres validates the whole
-- embedded SELECT at parse time, so list_notifications failed with
-- `relation "public.listings" does not exist` even with zero listing rows.
-- Re-emit both functions with the corrected table. Run AFTER 0029.

/* -------------------------------------------------------------- */
/* list_notifications — paged, filtered, RLS-safe (corrected)      */
/* -------------------------------------------------------------- */

create or replace function public.list_notifications(
  p_filter text default 'all',
  p_limit int default 30,
  p_offset int default 0
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    return '[]'::jsonb;
  end if;
  return coalesce(
    jsonb_agg(x.r order by x.created_at desc),
    '[]'::jsonb
  )
  from (
    select jsonb_build_object(
        'id',          n.id,
        'type',        n.type,
        'entity_type', n.entity_type,
        'entity_id',   n.entity_id,
        'metadata',    n.metadata,
        'read_at',     n.read_at,
        'created_at',  n.created_at,
        'slug',        case n.entity_type
                         when 'club'    then (select c.slug from public.clubs c                 where c.id = n.entity_id)
                         when 'event'   then (select e.slug from public.events e               where e.id = n.entity_id)
                         when 'listing' then (select l.slug from public.marketplace_listings l where l.id = n.entity_id)
                         else null
                       end,
        'title',       case n.entity_type
                         when 'club'    then (select c.name  from public.clubs c                 where c.id = n.entity_id)
                         when 'event'   then (select e.title from public.events e                where e.id = n.entity_id)
                         when 'listing' then (select l.title from public.marketplace_listings l where l.id = n.entity_id)
                         else null
                       end,
        'actor',       case when pr.id is null then null else
          jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'name', pr.display_name,
            'avatar', pr.avatar_url
          ) end
      ) as r,
      n.created_at
    from public.notifications n
    left join public.profiles pr on pr.id = n.actor_id
    where n.recipient_id = v_me
      and case p_filter
            when 'unread'    then n.read_at is null
            when 'mention'   then n.type in ('post_mention', 'chat_mention')
            when 'message'   then n.type = 'chat_message'
            when 'community' then n.type in (
              'club_join_accepted', 'club_join_rejected', 'club_invitation',
              'club_role_changed', 'club_banned', 'club_removed',
              'club_ownership', 'chat_reply', 'chat_mention')
            when 'follow'    then n.type = 'follow'
            when 'event'     then n.type in (
              'event_updated', 'event_cancelled', 'event_registered', 'event_promoted')
            when 'like'      then n.type in ('post_like', 'post_repost', 'comment_like')
            when 'comment'   then n.type in ('post_comment', 'post_reply')
            else true
          end
    limit least(greatest(coalesce(p_limit, 30), 1), 50)
    offset greatest(coalesce(p_offset, 0), 0)
  ) x;
end $$;

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
    v_body  := coalesce(v_actor.display_name, 'Someone') || ' replied to your comment';
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
        when 'club_role_changed'  then 'Your role in '             || coalesce(v_name, 'the community') || ' changed'
        when 'club_banned'        then 'You have been removed from ' || coalesce(v_name, 'a community')
        when 'club_removed'       then 'You have been removed from ' || coalesce(v_name, 'a community')
        when 'club_ownership'     then coalesce(v_name, 'A community') || ' changed ownership'
        when 'event_updated'      then coalesce(v_actor.display_name, 'Someone') || ' updated ' || coalesce(v_name, 'an event')
        when 'event_cancelled'    then coalesce(v_actor.display_name, 'Someone') || ' cancelled ' || coalesce(v_name, 'an event')
        when 'event_registered'   then 'Your spot for '            || coalesce(v_name, 'the event') || ' is confirmed'
        when 'event_promoted'     then 'You are now a host of '    || coalesce(v_name, 'the event')
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

grant execute on function public.list_notifications(text, int, int) to authenticated;
grant execute on function public.notification_push_payload(public.notifications) to service_role;

/* -------------------------------------------------------------- */
/* prefs RPCs — plpgsql composite RETURN cannot be a scalar         */
/* subquery: `return (select * ...)` fails with 42601. Select into  */
/* a typed row and return that instead.                            */
/* -------------------------------------------------------------- */

create or replace function public.ensure_notification_prefs()
returns public.notification_prefs
language plpgsql security definer set search_path = public as $$
declare
  v_me  uuid := auth.uid();
  v_row public.notification_prefs;
begin
  if v_me is null then
    raise exception 'Sign in to manage notification settings.';
  end if;
  insert into public.notification_prefs (user_id) values (v_me)
  on conflict (user_id) do nothing;
  select * into v_row from public.notification_prefs where user_id = v_me;
  return v_row;
end $$;

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
