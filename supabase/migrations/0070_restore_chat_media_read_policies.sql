-- 0070 - RESTORE STORAGE READ POLICIES DESTROYED BY 0051'S SWEEP
--
-- Symptom in the wild: every chat attachment (voice notes, photos, videos,
-- files) renders "Voice note unavailable. Retry" / "Unavailable" on BOTH
-- sides, old and new messages alike. Uploads still succeed (the INSERT
-- policy survived), but signing/reading fails with
--   "Either the object does not exist or you do not have access"
--
-- Root cause: 0051_media_lockdown.sql's policy sweep dropped every SELECT
-- policy on storage.objects whose USING clause contained the substring
-- 'media' —
--     and lower(qual) like '%media%'
-- That matched not only the `media` bucket policies it meant to replace,
-- but also:
--   * "chat media members read"      (0020) — qual contains bucket_id = 'chat-media'
--   * "ad-media public read"         (0035) — qual contains bucket_id = 'ad-media'
-- Only the `media`-bucket replacements were recreated afterwards, so chats
-- and ads media were left with ZERO SELECT policies. Storage RLS then blocks
-- every read for every role, and list/createSignedUrl report the object as
-- non-existent.
--
-- Fix: recreate both policies byte-for-byte from their original definitions.
-- No weakening relative to the pre-0051 state; nothing else is touched.
-- Idempotent: drop-if-exists, then create.

-- ------------------------------------------------------------------ --
-- 1. chat-media: conversation members read (0020, exact shape)       --
-- ------------------------------------------------------------------ --
drop policy if exists "chat media members read" on storage.objects;
create policy "chat media members read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-media'
    and public.is_conversation_member(public.uuid_or_null((storage.foldername(name))[1]))
  );

-- ------------------------------------------------------------------ --
-- 2. ad-media: public read (0035, exact shape)                       --
-- ------------------------------------------------------------------ --
drop policy if exists "ad-media public read" on storage.objects;
create policy "ad-media public read" on storage.objects
  for select to public
  using (bucket_id = 'ad-media');

-- ------------------------------------------------------------------ --
-- 3. Sanity guard so this class of bug cannot silently return:       --
--    fail loudly if a future sweep ever leaves a media-bearing       --
--    bucket without a SELECT policy. Runs once here; cheap.          --
-- ------------------------------------------------------------------ --
do $$
declare
  missing text;
begin
  select string_agg(b.id, ', ' order by b.id)
    into missing
    from (values ('chat-media'), ('ad-media')) as b(id)
    where not exists (
      select 1 from pg_policies p
      where p.schemaname = 'storage'
        and p.tablename = 'objects'
        and p.cmd = 'SELECT'
        and p.qual like '%''' || b.id || '''%'
    );
  if missing is not null then
    raise exception '0070 check failed: no SELECT policy covers bucket(s) %', missing;
  end if;
end $$;
