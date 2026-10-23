/* 0029b — PRE-FILLED copy-paste version for the SQL editor.
   ⚠ DO NOT COMMIT THIS FILE (it contains the service_role key).
   Apply ONLY after: 1) push-deliver deployed, 2) VAPID secrets set,
   3) push_queue INSERT webhook attached. */

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
    url := 'https://ggjdhqokzdidmucvxrgz.supabase.co/functions/v1/push-deliver',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnamRocW9remRpZG11Y3Z4cmd6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjE1Mjk4MywiZXhwIjoyMTA3NzI4OTgzfQ.EOjm7rf3Fxd2OfcpRFC64mQfMoa4tar1Uz0-LeIvUCU',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('run', 'sweep'),
    timeout_milliseconds := 8000
  );
  $$
);

-- verify: should return one row named 'campus push sweep'
select jobname, schedule, command is not null as command_present from cron.job where jobname = 'campus push sweep';
