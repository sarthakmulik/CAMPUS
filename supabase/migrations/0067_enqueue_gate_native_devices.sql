-- 0061 - ENQUEUE GATE: the bump-path helper learns about native devices
--
-- 0054 fixed notifications_enqueue_push() (the INSERT trigger) to enqueue
-- when the recipient has a browser subscription OR a native device token.
-- But 0033's enqueue_push_for_notification() helper - which notify_member's
-- bump-on-unread path still calls - kept the web-only gate from 0032, so a
-- member registered ONLY on the Android/iOS app silently skipped pushes on
-- the bump path. This aligns the helper with 0054: ANY registered target
-- (browser subscription or native device token) is enough to enqueue.
-- Preferences, quiet hours and payload building are untouched.
--
-- Rollback: recreate the 0033 helper body (web-only gate).

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
  ) and not exists (
    select 1 from public.device_tokens d
    where d.user_id = p_row.recipient_id
  ) then
    return; -- nothing registered: no queue churn
  end if;
  v_payload := public.notification_push_payload(p_row);
  insert into public.push_queue (notification_id, recipient_id, payload)
  values (p_row.id, p_row.recipient_id, v_payload);
end $$;

revoke all on function public.enqueue_push_for_notification(public.notifications) from public, anon, authenticated;
