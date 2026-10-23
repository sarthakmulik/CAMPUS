/* ==================================================================== */
/* 0030 — richer web-push payloads                                       */
/*                                                                       */
/* notification_push_payload (last defined in 0029c) now also emits:    */
/*   category   — display category, lets the SW adapt rendering          */
/*   nid        — the notifications row id (future mark-read plumbing)   */
/*   created_at — the EVENT time, so the OS renders real relative age    */
/*                                                                       */
/* Only this function changes; no tables, grants, or triggers.           */
/* Idempotent: run anywhere. 0029c was updated to the same definition,   */
/* so fresh clones get the identical payload shape.                      */
/* ==================================================================== */
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
        v_body := 'New message â€” open to read';
      else
        v_body := v_preview;
      end if;
    else
      v_body := 'New message â€” open to read';
    end if;
    v_url := '#chat/' || coalesce(p_row.entity_id::text, '');
    v_tag := 'chat:' || coalesce(p_row.entity_id::text, '');
    return jsonb_build_object('title', v_title, 'body', v_body,
                              'url', v_url, 'tag', v_tag,
                              'category', v_cat, 'nid', p_row.id,
                              'created_at', to_jsonb(p_row.created_at));

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
                            'url', coalesce(v_url, ''), 'tag', v_tag,
                            'category', v_cat, 'nid', p_row.id,
                            'created_at', to_jsonb(p_row.created_at));
end $$;

grant execute on function public.notification_push_payload(public.notifications) to service_role;
