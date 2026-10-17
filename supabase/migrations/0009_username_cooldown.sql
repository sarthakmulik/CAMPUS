-- 0009 — username change cooldown
--
-- Rule (Instagram-style): a member who already HAS a username may change it
-- at most once every 30 days. This is enforced on the server by a BEFORE
-- UPDATE trigger on profiles, so a hand-crafted client cannot skip it.
-- The first-ever username (null → value) is allowed at any time.
--
-- Fully idempotent: safe to re-run from any partial state.

alter table public.profiles add column if not exists username_changed_at timestamptz;

drop trigger if exists username_change_cooldown on public.profiles;

create or replace function public.enforce_username_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.username is distinct from old.username then
    -- Setting a username for the first time is always allowed. For members
    -- whose username_changed_at is still null (no change since this rule
    -- shipped), the first change under the new rule is allowed too — we will
    -- not lock anyone out based on a timestamp we never recorded.
    if old.username is not null and old.username_changed_at is not null then
      if old.username_changed_at > now() - interval '30 days' then
        raise exception
          'Usernames can be changed once every 30 days — you can change yours on %.',
          to_char(old.username_changed_at + interval '30 days', 'DD Mon YYYY')
          using errcode = 'P0001';
      end if;
    end if;
    new.username_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger username_change_cooldown
  before update on public.profiles
  for each row
  execute function public.enforce_username_cooldown();
