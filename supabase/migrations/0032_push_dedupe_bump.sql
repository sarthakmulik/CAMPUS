/* ==================================================================== */
/* 0032 — push reliability: repeated events must not be swallowed        */
/*                                                                       */
/* BUG fixed here: the legacy dedupe in notify_member returned silently  */
/* when the recipient already had an UNREAD notification for the same    */
/* (type, entity) — e.g. a second chat message in one conversation.      */
/* Consequence: no in-app row AND no push, for every message until the   */
/* user opened the chat. Users experienced "one push worked, then the    */
/* phone went quiet" even though delivery itself was healthy.            */
/*                                                                       */
/* Fix: when an unread row already exists, BUMP it (new actor + fresh    */
/* created_at so the inbox shows the newest sender first) and enqueue    */
/* the push through the same gated path an insert uses.                  */
/*                                                                       */
/* Also factors the push-enqueue gate into a shared helper so the        */
/* trigger and the bump path cannot drift apart.                         */
/* Idempotent; no tables or columns change.                              */
/* ==================================================================== */

/* ------------------------------------------------------------------ */
/* shared gate + enqueue (extracted from notifications_enqueue_push)   */
/* ------------------------------------------------------------------ */
create or replace function public.enqueue_push_for_notification(
  p_row public.notifications
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prefs public.notification_prefs;
  v_cat   text;
  v_push  boolean;
  v_payload jsonb;
begin
  v_prefs := public.notif_prefs_of(p_row.recipient_id);
  v_cat   := public.notification_category(p_row.type);
  v_push := case v_cat
    when 'like'        then v_prefs.like_push
    when 'comment'     then v_prefs.comment_push
    when 'follow'      then v_prefs.follow_push
    when 'mention'     then v_prefs.mention_push
    when 'message'     then v_prefs.message_push
    when 'community'   then v_prefs.community_push
    when 'event'       then v_prefs.event_push
    when 'marketplace' then v_prefs.marketplace_push
    else true -- account / security notices always eligible
  end;
  if not v_push or public.notif_is_quiet(p_row.recipient_id) then
    return;
  end if;
  if not exists (
    select 1 from public.push_subscriptions s
    where s.user_id = p_row.recipient_id
  ) then
    return; -- nothing registered: no queue churn
  end if;
  v_payload := public.notification_push_payload(p_row);
  insert into public.push_queue (notification_id, recipient_id, payload)
  values (p_row.id, p_row.recipient_id, v_payload);
end $$;

revoke all on function public.enqueue_push_for_notification(public.notifications) from public, anon, authenticated;

/* the insert trigger now delegates to the shared helper */
create or replace function public.notifications_enqueue_push()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.enqueue_push_for_notification(new);
  return null;
end $$;

/* ------------------------------------------------------------------ */
/* notify_member — bump-on-unread instead of silent skip               */
/* ------------------------------------------------------------------ */
create or replace function public.notify_member(
  p_recipient uuid,
  p_actor uuid,
  p_type text,
  p_entity_type text,
  p_entity_id uuid
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.notifications;
begin
  if p_recipient is null or p_recipient = p_actor then
    return;
  end if;
  if p_actor is not null and (
    exists (select 1 from public.user_blocks b
            where (b.blocker_id = p_recipient and b.blocked_id = p_actor)
               or (b.blocker_id = p_actor and b.blocked_id = p_recipient))
    or exists (select 1 from public.user_mutes m
            where (m.blocker_id = p_recipient and m.blocked_id = p_actor)
               or (m.blocker_id = p_actor and m.blocked_id = p_recipient))
  ) then
    return;
  end if;
  if not public.notif_inapp_allowed(p_recipient, public.notification_category(p_type)) then
    return;
  end if;
  -- chat conversations honor the per-conversation mute switch too
  if p_entity_type in ('chat', 'dm_chat', 'group_chat') and exists (
    select 1 from public.conversation_members m
    where m.conversation_id = p_entity_id
      and m.user_id = p_recipient
      and m.muted
  ) then
    return;
  end if;
  -- legacy dedupe, upgraded: one unread row per (recipient, type, entity)
  -- no matter which actor raised it — BUMP it instead of dropping the
  -- event, so repeat messages keep notifying (in-app + push).
  if exists (
    select 1 from public.notifications n
    where n.recipient_id = p_recipient
      and n.type = p_type
      and n.entity_id is not distinct from p_entity_id
      and n.read_at is null
  ) then
    update public.notifications n
      set actor_id  = coalesce(p_actor, n.actor_id),
          created_at = now()
      where n.recipient_id = p_recipient
        and n.type = p_type
        and n.entity_id is not distinct from p_entity_id
        and n.read_at is null
      returning * into v_row;
    perform public.enqueue_push_for_notification(v_row);
    return;
  end if;
  insert into public.notifications (recipient_id, actor_id, type, entity_type, entity_id)
  values (p_recipient, p_actor, p_type, p_entity_type, p_entity_id);
  -- the notifications_enqueue_push trigger handles this enqueue
end $$;

revoke all on function public.notify_member(uuid, uuid, text, text, uuid) from public;

-- sanity check (recipient-idempotent, safe to run):
select proname from pg_proc
where proname = 'enqueue_push_for_notification';
