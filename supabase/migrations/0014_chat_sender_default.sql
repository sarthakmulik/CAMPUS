-- The chat send policy checks `sender_id = auth.uid()`. A client insert that
-- omits sender_id leaves it NULL, and NULL = auth.uid() fails the check →
-- "new row violates row-level security policy for table chat_messages"
-- (this hit the first real send after accepting a request).
--
-- Fix: the sender is the session itself. With this default a payload that
-- omits sender_id still inserts as the signed-in member, and the check passes.
-- The client now sends sender_id explicitly; this default is defense in depth.
-- Idempotent: safe to run again.

alter table public.chat_messages alter column sender_id set default auth.uid();
