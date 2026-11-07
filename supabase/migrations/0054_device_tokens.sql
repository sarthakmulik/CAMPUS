/* =====================================================================
   0054 — Native push device tokens (Capacitor Android/iOS)
   ---------------------------------------------------------------------
   Mirrors 0029's push_subscriptions model exactly: own-row RLS, a
   security-definer saver that reassigns a token to the CURRENT signed-in
   user (account switching can never inherit a previous account's device),
   and a remover scoped to the owner. The push_queue pipeline is unchanged
   — notifications_enqueue_push() now also fires when the recipient has a
   native device token, and push-deliver sends those rows over FCM HTTP v1.
   ===================================================================== */

create table if not exists public.device_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('android', 'ios')),
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx
  on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;

drop policy if exists "own device tokens" on public.device_tokens;
create policy "own device tokens" on public.device_tokens
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

/* A device token can only ever map to the signed-in owner: when a device
   registers under a new account, the old row is reassigned at the same
   instant — account switching can never inherit devices. */
create or replace function public.save_device_token(
  p_token text,
  p_platform text,
  p_user_agent text default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Sign in to enable notifications.';
  end if;
  if coalesce(p_token, '') = '' or p_platform not in ('android', 'ios') then
    raise exception 'That device registration is incomplete.';
  end if;
  delete from public.device_tokens where token = p_token and user_id <> v_me;
  insert into public.device_tokens (user_id, token, platform, user_agent)
  values (v_me, p_token, p_platform, p_user_agent)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        user_agent = excluded.user_agent,
        updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.remove_device_token(p_token text)
returns void
language sql security definer set search_path = public as $$
  delete from public.device_tokens
  where user_id = auth.uid() and token = p_token
$$;

/* Enqueue when the recipient has ANY push target: browser subscription
   (0029) or native device token. Preferences, quiet hours and payload
   building stay exactly as 0029 defined them. */
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
    else true -- account / security notices always eligible
  end;
  if not v_push or public.notif_is_quiet(new.recipient_id) then
    return null;
  end if;
  if not exists (
    select 1 from public.push_subscriptions s
    where s.user_id = new.recipient_id
  ) and not exists (
    select 1 from public.device_tokens t
    where t.user_id = new.recipient_id
  ) then
    return null; -- nothing registered: no queue churn
  end if;
  v_payload := public.notification_push_payload(new);
  insert into public.push_queue (notification_id, recipient_id, payload)
  values (new.id, new.recipient_id, v_payload);
  return null;
end $$;

grant execute on function
  public.save_device_token(text, text, text),
  public.remove_device_token(text)
  to authenticated;