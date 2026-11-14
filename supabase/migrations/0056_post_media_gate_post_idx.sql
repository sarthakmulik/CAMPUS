-- 0056 - post_media_gate write-path index
--
-- Why: post_media_gate_sync() (0051, extended 0055) runs
--   DELETE FROM post_media_gate WHERE post_id = <post>
-- on EVERY posts insert/update/delete. The table's only index is the
-- primary key (name, post_id) - name-leading - so that DELETE is a full
-- sequential scan of the gate table per post write.
--
-- Invisible at today's row counts, a real write-latency source once
-- posts x media grow (every carousel post adds several gate rows).
-- This is the one index the gate infra was missing; everything else
-- audited (posts, comments, messages, chat_messages, notifications,
-- marketplace, events, bookmarks, follows, pulse) already has the
-- indexes its queries need.
--
-- Trivial + idempotent. No policy or RLS changes.

create index if not exists post_media_gate_post_idx
  on public.post_media_gate (post_id);

analyze public.post_media_gate;
