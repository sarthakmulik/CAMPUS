/* ============================================================================
   0066 - SOCIAL GRAPH ENGINE: tighten the function grants

   0065 revoked EXECUTE from PUBLIC and granted it to `authenticated`, which reads
   as "members only". On Supabase it was not: `alter default privileges in schema
   public` grants EXECUTE on every new function to `anon` as well, and a revoke
   from PUBLIC does not undo a direct grant to `anon`.

   Verified against the live project after 0065: an anonymous call to
   social_relation_of / social_mutual_list returned HTTP 200 with zero rows. So
   no relationship data was exposed - the `auth.uid()` gate in the SQL held - but
   the grant was wider than the design, and "defence in depth" is the point of
   that gate rather than a substitute for it.

   This closes it: anon loses EXECUTE, authenticated keeps it, PUBLIC has none.
   The functions still return zero rows for a signed-out caller (auth.uid() is
   null), which is the behaviour the client already relies on.

   Re-runnable.
   ============================================================================ */

revoke all on function public.social_relation_of(uuid) from public;
revoke all on function public.social_relation_of(uuid) from anon;
grant execute on function public.social_relation_of(uuid) to authenticated;

revoke all on function public.social_mutual_list(uuid, integer, integer) from public;
revoke all on function public.social_mutual_list(uuid, integer, integer) from anon;
grant execute on function public.social_mutual_list(uuid, integer, integer) to authenticated;

/* The aggregate table keeps its own-row-only RLS policy from 0065. Nothing else
   changes: no policy, no data, no trigger. */

/* ---------------------------------------------------------------------------
   Note for later phases: every function this project adds is granted to `anon`
   automatically unless it is revoked. New security-definer functions that read
   member data should carry the same two revokes (public, anon) in the migration
   that creates them, not in a follow-up.
   --------------------------------------------------------------------------- */