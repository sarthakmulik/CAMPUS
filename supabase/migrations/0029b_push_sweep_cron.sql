/* ==================================================================== */
/* OPTIONAL (0029b): bounded retry sweep for browser push delivery       */
/*                                                                       */
/* The push-deliver edge function runs immediately on every push_queue    */
/* insert via a Supabase Database Webhook. If delivery fails, the row     */
/* stays pending with a scheduled next attempt — this cron sweep picks    */
/* those rows up again using the SAME function (bounded batch of 50,      */
/* backoff rows only, no infinite loops).                                */
/*                                                                       */
/* Requires: pg_cron + pg_net extensions and the deploys pushed function  */
/* Deno function. ONLY apply this file after:                            */
/*   1. supabase functions deploy push-deliver                           */
/*   2. supabase secrets set VAPID_*                                     */
/*   3. You know your project ref + function URL.                        */
/* Run inside the SQL editor; then replace <PROJECT_REF> and             */
/* <SERVICE_ROLE_KEY> in the json literal below.                         */
/* ==================================================================== */

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('campus push sweep') where exists (
  select 1 from cron.job where jobname = 'campus push sweep'
);

/* every minute; the function itself rate-limits and bounds work */
select cron.schedule(
  'campus push sweep',
  '* * * * *',
  $$
  select extensions.net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/push-deliver',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('run', 'sweep'),
    timeout_milliseconds := 8000
  );
  $$
);
