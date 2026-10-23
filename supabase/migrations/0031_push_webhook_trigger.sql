/* ==================================================================== */
/* 0031 — push delivery wiring (instant path + retry sweep)              */
/*                                                                       */
/* This documents the LIVE configuration that ships push instantly:      */
/*                                                                       */
/*   1. push_delivery_config — one row (id = 1) holding the signer       */
/*      bearer token. Zero grants + RLS with no policies: only the       */
/*      postgres role and security-definer code can read it, so no       */
/*      secret ever lives in a migration file or the repo.               */
/*                                                                       */
/*   2. push_delivery_webhook — a trigger on push_queue INSERT that      */
/*      POSTs the row to the push-deliver edge function (pg_net), so     */
/*      delivery starts in milliseconds instead of waiting for cron.     */
/*                                                                       */
/*   3. cron 'campus push sweep' — every minute, POSTs {run:"sweep"}     */
/*      to the same function to retry rows that failed instantly         */
/*      (bounded backoff lives in the edge function). Reads the token    */
/*      from the config table at run time.                               */
/*                                                                       */
/* Run order (fresh clone): 0029 → 0029b → 0029c → 0030 → 0031 → 0032.   */
/* All statements are idempotent.                                        */
/* ==================================================================== */

/* 1. config table (skips if it already exists — live DB has it)         */
create table if not exists public.push_delivery_config (
  id           int primary key default 1 check (id = 1),
  bearer_token text not null
);
alter table public.push_delivery_config enable row level security;
revoke all on public.push_delivery_config from anon, authenticated;
/*  (no policies: only postgres + security-definer code reach it)         */

/* 2. instant delivery on enqueue                                        */

create or replace function public.push_delivery_call()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_token text;
begin
  if new.status is distinct from 'pending' then
    return null; -- only fresh pending rows trigger instant delivery
  end if;
  select bearer_token into v_token
  from public.push_delivery_config where id = 1;
  if v_token is null or v_token = '' then
    return null; -- not configured: the cron sweep still picks rows up
  end if;
  perform net.http_post(
    url := 'https://ggjdhqokzdidmucvxrgz.supabase.co/functions/v1/push-deliver',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('record', jsonb_build_object('id', new.id)),
    timeout_milliseconds := 8000
  );
  return null;
end $$;

drop trigger if exists push_delivery_webhook on public.push_queue;
create trigger push_delivery_webhook
  after insert on public.push_queue
  for each row execute function public.push_delivery_call();

/* 3. retry sweep — every minute                                         */

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('campus push sweep') where exists (
  select 1 from cron.job where jobname = 'campus push sweep'
);

select cron.schedule(
  'campus push sweep',
  '* * * * *',
  $$
  select extensions.net.http_post(
    url := 'https://ggjdhqokzdidmucvxrgz.supabase.co/functions/v1/push-deliver',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' ||
        (select bearer_token from public.push_delivery_config where id = 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('run', 'sweep'),
    timeout_milliseconds := 8000
  );
  $$
);

-- verify: one row named 'campus push sweep'
select jobname, schedule,
       command is not null as command_present
from cron.job where jobname = 'campus push sweep';
