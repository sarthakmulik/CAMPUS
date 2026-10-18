-- 0017: Invitee-facing invitation listing.
--
-- Why: community_invitations has no SELECT policy by design (every read/write
-- flows through security-definer RPCs), and invite_member() notifies with
-- entity_id = club (not the invitation row). Without a sanctioned listing the
-- invited student can never learn the invitation id, so respond_invite() is
-- unreachable from the app even though the RPC itself is complete and guarded.
--
-- This RPC is the only added surface: it reveals nothing beyond the caller's
-- own pending invitations. RLS on community_invitations stays closed.

drop function if exists public.list_my_club_invites();
create function public.list_my_club_invites()
returns table (
  invite_id uuid,
  club_id uuid,
  club_name text,
  club_slug text,
  club_privacy text,
  invited_by text,
  invited_by_username text,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    i.id,
    c.id,
    c.name,
    c.slug,
    c.privacy,
    pr.display_name,
    pr.username,
    i.created_at
  from public.community_invitations i
  join public.clubs c
    on c.id = i.club_id and c.archived_at is null
  left join public.profiles pr on pr.id = i.inviter_id
  where i.invitee_id = auth.uid()
  order by i.created_at desc;
$$;

revoke all on function public.list_my_club_invites() from public;
grant execute on function public.list_my_club_invites() to authenticated;
