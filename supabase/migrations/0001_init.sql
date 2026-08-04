-- ============================================================================
-- 0001_init.sql — "Claude with Friends"
--
-- Schema, Row Level Security, triggers and indexes for a collaborative wrapper
-- around one shared Claude conversation per room.
--
-- THIS FILE IS THE SECURITY BOUNDARY. `src/lib/permissions.ts` mirrors these
-- rules so the UI can hide controls and the API can produce good error
-- messages, but nothing in TypeScript is trusted: a caller who tampers with a
-- room id in a URL, or who hits PostgREST directly with their own anon-key
-- session, must get zero rows. Every rule below is therefore expressed twice —
-- once in TS for ergonomics, once here for enforcement — and the version here
-- wins.
--
-- The file is written to be re-runnable (guarded creates, dropped-then-created
-- policies) so it can be pasted into the SQL editor more than once without
-- wedging a project.
--
-- Enum names and table columns are a hand-maintained mirror of
-- `src/lib/database.types.ts`. Changing one without the other breaks the app.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
-- `create type` has no IF NOT EXISTS, so each one is wrapped to keep re-runs
-- idempotent.

do $$ begin
  create type public.room_role as enum ('core_prompter', 'administrator', 'collaborator', 'viewer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.member_status as enum ('invited', 'active', 'removed', 'banned');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.collaboration_mode as enum ('open', 'approval_required');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.sender_type as enum ('core_prompter', 'collaborator', 'assistant', 'system');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.approval_status as enum ('pending', 'approved', 'rejected', 'sent');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null check (char_length(display_name) between 1 and 60),
  avatar_url text,
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Public-facing user record. Populated by the handle_new_user trigger on auth.users; auth.users itself is never exposed to the client.';

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) <= 80 and char_length(btrim(name)) >= 1),
  owner_id uuid not null references auth.users (id) on delete cascade,
  collaboration_mode public.collaboration_mode not null default 'open',
  is_locked boolean not null default false,
  allow_collaborator_messages boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.rooms.owner_id is
  'The Core Prompter. Immutable after insert (see guard_room_update) because the whole permission model hangs off it.';

create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.room_role not null default 'collaborator',
  status public.member_status not null default 'invited',
  invited_by uuid references auth.users (id) on delete set null,
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (room_id, user_id)
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  -- Stored lower-cased (normalised by trg_invitations_normalise_email) so that
  -- the equality check in accept_invitation cannot be defeated by casing.
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  role public.room_role not null default 'collaborator' check (role <> 'core_prompter'),
  token text not null unique check (char_length(token) >= 32),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  invited_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on column public.invitations.token is
  'Bearer secret for the /invite/[token] link. Row-level policies restrict this table to admins of the room; the members API deliberately returns InvitationSummary (token omitted) so the secret is never fanned out to the access panel.';

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  -- Deleting an account must not tear holes in a shared transcript, so the
  -- authorship link is severed rather than the message removed.
  sender_id uuid references auth.users (id) on delete set null,
  sender_type public.sender_type not null,
  original_content text not null,
  processed_content text,
  approval_status public.approval_status not null default 'sent',
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  edited_content text,
  error text,
  created_at timestamptz not null default now(),
  -- MAX_MESSAGE_LENGTH (8000) is a limit on what a *human* may submit. Claude's
  -- own turns are stored in this same column and routinely exceed it at
  -- CLAUDE_MAX_TOKENS=16000, so the constraint is scoped to the two
  -- human-authored sender types instead of the whole column.
  constraint messages_human_content_length check (
    sender_type not in ('core_prompter', 'collaborator')
    or char_length(original_content) between 1 and 8000
  )
);

create table if not exists public.claude_sessions (
  id uuid primary key default gen_random_uuid(),
  -- One Claude conversation per room is the core product invariant; the unique
  -- constraint is what actually guarantees it.
  room_id uuid not null unique references public.rooms (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  conversation_state jsonb not null default
    '{"turn_count": 0, "last_message_id": null, "total_input_tokens": 0, "total_output_tokens": 0, "last_error": null}'::jsonb,
  model text not null default 'claude-opus-5',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  -- Audit rows outlive the things they describe, hence SET NULL rather than
  -- CASCADE on both references.
  room_id uuid references public.rooms (id) on delete set null,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  -- Polymorphic: a member id, a message id, an invitation id. Intentionally
  -- unconstrained so an audit write can never fail on a dangling reference.
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only. No RLS policy exists for anon or authenticated, so PostgREST returns zero rows and rejects every write; only the service-role client (src/lib/server/audit.ts) can touch it.';

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------

-- Transcript paging: newest-first within a room.
create index if not exists messages_room_created_idx
  on public.messages (room_id, created_at desc);

-- The pending-approval queue.
create index if not exists messages_room_approval_idx
  on public.messages (room_id, approval_status);

-- Access panel: active members of a room.
create index if not exists room_members_room_status_idx
  on public.room_members (room_id, status);

-- Sidebar: every room a user belongs to.
create index if not exists room_members_user_idx
  on public.room_members (user_id);

-- invitations(token) is already covered by the UNIQUE constraint's index; a
-- second one would only cost writes.
create index if not exists invitations_room_email_idx
  on public.invitations (room_id, email);

create index if not exists audit_logs_room_created_idx
  on public.audit_logs (room_id, created_at desc);

create index if not exists rooms_owner_idx
  on public.rooms (owner_id);

-- Exactly one Core Prompter per room, enforced by the storage engine rather
-- than by application code.
create unique index if not exists room_members_one_core_prompter_idx
  on public.room_members (room_id)
  where role = 'core_prompter'::public.room_role;

-- ---------------------------------------------------------------------------
-- 4. Helper functions
-- ---------------------------------------------------------------------------
-- All SECURITY DEFINER with a pinned search_path. Two reasons:
--
--   1. Recursion. A policy on room_members that needs to read room_members
--      would re-enter its own policy forever. Running the lookup as the table
--      owner skips RLS on the inner read and breaks the cycle.
--   2. Injection. `set search_path = public, pg_temp` stops a caller from
--      shadowing a referenced object with a temp-schema decoy — the classic
--      SECURITY DEFINER attack.
--
-- They are STABLE so the planner can call them once per row-set rather than
-- once per row inside policy expressions.

create or replace function public.current_member_role(p_room_id uuid)
returns public.room_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select rm.role
  from public.room_members rm
  where rm.room_id = p_room_id
    and rm.user_id = auth.uid()
    and rm.status = 'active'
  limit 1;
$$;

comment on function public.current_member_role(uuid) is
  'Caller''s role in a room, or NULL when they have no ACTIVE membership. Status is part of the lookup so that removing or banning someone revokes every capability in one write.';

create or replace function public.is_active_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
      and rm.status = 'active'
  );
$$;

create or replace function public.is_room_owner(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = p_room_id
      and r.owner_id = auth.uid()
  );
$$;

create or replace function public.is_room_admin(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = p_room_id
      and r.owner_id = auth.uid()
  )
  or exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
      and rm.status = 'active'
      and rm.role = 'administrator'
  );
$$;

comment on function public.is_room_admin(uuid) is
  'Owner OR active administrator. Mirrors can(''room.invite'' | ''room.remove_member'' | ''room.change_role'') in src/lib/permissions.ts.';

-- Used only by the profiles SELECT policy. Written as a definer function so
-- that the peer lookup is not itself filtered by the room_members policies,
-- which would make visibility depend on evaluation order.
create or replace function public.shares_active_room(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.room_members mine
    join public.room_members theirs on theirs.room_id = mine.room_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = p_user_id
      and theirs.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Invitation redemption
-- ---------------------------------------------------------------------------

create or replace function public.accept_invitation(p_token text)
returns table (room_id uuid, role public.room_role)
language plpgsql
-- VOLATILE, not STABLE: the body writes (membership upsert + accepted_at), and
-- Postgres refuses INSERT/UPDATE inside a non-volatile function.
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_caller_email text;
  v_inv public.invitations%rowtype;
  v_member public.room_members%rowtype;
  v_role public.room_role;
begin
  if v_uid is null then
    raise exception 'not_authenticated'
      using hint = 'Sign in before accepting an invitation.';
  end if;

  -- The JWT claim is the fast path; auth.users is the fallback for tokens
  -- minted without a top-level email claim. Reading auth.users is only
  -- possible because this function runs as its definer.
  select lower(coalesce(nullif(auth.jwt() ->> 'email', ''), u.email))
    into v_caller_email
  from auth.users u
  where u.id = v_uid;

  -- Locked for the duration of the transaction so two concurrent redemptions
  -- of the same link cannot both observe accepted_at as NULL.
  select * into v_inv
  from public.invitations i
  where i.token = p_token
  for update;

  if not found then
    raise exception 'invitation_invalid'
      using hint = 'This invitation link is not valid.';
  end if;

  if v_inv.revoked_at is not null then
    raise exception 'invitation_revoked'
      using hint = 'This invitation was revoked by a room administrator.';
  end if;

  if v_inv.accepted_at is not null then
    raise exception 'invitation_already_accepted'
      using hint = 'This invitation has already been used.';
  end if;

  if v_inv.expires_at <= now() then
    raise exception 'invitation_expired'
      using hint = 'This invitation has expired. Ask for a new one.';
  end if;

  -- The whole point of binding an invitation to an address: a link that leaks
  -- (forwarded mail, shoulder-surfed URL, referrer header) is useless to
  -- anybody but the intended recipient.
  if v_caller_email is null or lower(v_inv.email) <> v_caller_email then
    raise exception 'invitation_email_mismatch'
      using hint = 'This invitation was issued to a different email address.';
  end if;

  select * into v_member
  from public.room_members rm
  where rm.room_id = v_inv.room_id
    and rm.user_id = v_uid
  for update;

  if found then
    if v_member.status = 'banned' then
      -- A ban is terminal. Re-inviting a banned address must not silently
      -- launder them back into the room; an admin has to lift the ban first.
      raise exception 'membership_banned'
        using hint = 'This account is banned from the room.';
    end if;

    -- Never demote the Core Prompter by way of an invitation they happened to
    -- redeem; otherwise take the invited role (this is how a 'removed' member
    -- is restored).
    v_role := case when v_member.role = 'core_prompter' then v_member.role else v_inv.role end;

    update public.room_members rm
    set role = v_role,
        status = 'active',
        joined_at = coalesce(rm.joined_at, now()),
        invited_by = coalesce(rm.invited_by, v_inv.invited_by)
    where rm.id = v_member.id;
  else
    v_role := v_inv.role;

    insert into public.room_members (room_id, user_id, role, status, invited_by, joined_at)
    values (v_inv.room_id, v_uid, v_role, 'active', v_inv.invited_by, now());
  end if;

  update public.invitations i
  set accepted_at = now()
  where i.id = v_inv.id;

  return query select v_inv.room_id, v_role;
end;
$$;

comment on function public.accept_invitation(text) is
  'Single-transaction redemption. Distinguishable failure messages: not_authenticated, invitation_invalid, invitation_revoked, invitation_already_accepted, invitation_expired, invitation_email_mismatch, membership_banned.';

-- ---------------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_rooms_touch_updated_at on public.rooms;
create trigger trg_rooms_touch_updated_at
  before update on public.rooms
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_claude_sessions_touch_updated_at on public.claude_sessions;
create trigger trg_claude_sessions_touch_updated_at
  before update on public.claude_sessions
  for each row execute function public.touch_updated_at();

-- New signup -> profile row. -----------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    -- Magic-link signups arrive with no metadata at all, so the email local
    -- part is the fallback rather than an empty display name.
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'Member'
      ),
      60
    ),
    nullif(btrim(new.raw_user_meta_data ->> 'avatar_url'), '')
  )
  on conflict (id) do update
    set email = excluded.email;

  return new;
end;
$$;

-- auth.users is owned by supabase_auth_admin. Creating a trigger on it needs
-- elevated rights; if the migration is applied by a role that lacks them we
-- warn instead of aborting the whole schema, and the README explains the
-- manual fallback.
do $$
begin
  drop trigger if exists on_auth_user_created on auth.users;
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();
exception
  when insufficient_privilege then
    raise warning 'Could not attach on_auth_user_created to auth.users. Create it from the Supabase SQL editor as the postgres role — profiles will not be auto-created until you do.';
end $$;

-- New room -> owner membership + Claude session. ----------------------------
create or replace function public.bootstrap_room()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Done in the database, not the API route, so the invariant "every room has
  -- exactly one active Core Prompter and exactly one Claude session" holds no
  -- matter who inserts the room (API route, service-role script, SQL editor).
  insert into public.room_members (room_id, user_id, role, status, joined_at)
  values (new.id, new.owner_id, 'core_prompter', 'active', now())
  on conflict (room_id, user_id) do nothing;

  insert into public.claude_sessions (room_id, owner_id)
  values (new.id, new.owner_id)
  on conflict (room_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_rooms_bootstrap on public.rooms;
create trigger trg_rooms_bootstrap
  after insert on public.rooms
  for each row execute function public.bootstrap_room();

-- Column-level guard for room updates. --------------------------------------
create or replace function public.guard_room_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- auth.uid() is NULL for the service-role client, which is trusted server
  -- code that has already run its own capability checks. RLS keeps anonymous
  -- callers out entirely, so a NULL uid here can only mean the service role.
  if auth.uid() is null then
    return new;
  end if;

  if new.id is distinct from old.id
     or new.owner_id is distinct from old.owner_id
     or new.created_at is distinct from old.created_at then
    raise exception 'room_immutable_columns'
      using hint = 'A room''s id, owner and creation time cannot be changed.';
  end if;

  -- The UPDATE policy admits any admin, because administrators need to be able
  -- to lock a room (can('room.lock')). Everything else on this table is
  -- Core-Prompter-only, and that distinction is a column-level rule, which RLS
  -- cannot express — so it lives here.
  if old.owner_id <> auth.uid() then
    if new.name is distinct from old.name
       or new.collaboration_mode is distinct from old.collaboration_mode
       or new.allow_collaborator_messages is distinct from old.allow_collaborator_messages then
      raise exception 'room_admin_may_only_toggle_lock'
        using hint = 'Only the Core Prompter can rename a room or change its collaboration settings.';
    end if;
  end if;

  return new;
end;
$$;

-- Named so it sorts before trg_rooms_touch_updated_at: the guard must see the
-- caller's diff, not a diff that already includes a rewritten updated_at.
drop trigger if exists trg_rooms_guard_update on public.rooms;
create trigger trg_rooms_guard_update
  before update on public.rooms
  for each row execute function public.guard_room_update();

-- Role-escalation guard for memberships. ------------------------------------
create or replace function public.guard_room_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room_id uuid := coalesce(new.room_id, old.room_id);
  v_owner uuid;
  v_actor_is_peer_admin boolean;
begin
  select r.owner_id into v_owner
  from public.rooms r
  where r.id = v_room_id;

  -- The parent room is already gone: this firing is the ON DELETE CASCADE from
  -- `delete from rooms`, and there is no invariant left to protect.
  if v_owner is null then
    return coalesce(new, old);
  end if;

  -- canRemoveMember()/canChangeRole() in src/lib/permissions.ts refuse to let
  -- one administrator manage another; without the same rule here, an admin who
  -- calls PostgREST directly could demote or ban every peer admin. NULL uid
  -- (service role) and the owner are exempt.
  v_actor_is_peer_admin :=
    auth.uid() is not null
    and auth.uid() <> v_owner
    and public.current_member_role(v_room_id) = 'administrator';

  if tg_op = 'DELETE' then
    if old.user_id = v_owner then
      raise exception 'core_prompter_membership_immutable'
        using hint = 'The Core Prompter cannot be removed from their own room.';
    end if;
    if v_actor_is_peer_admin and old.role = 'administrator' and old.user_id <> auth.uid() then
      raise exception 'admin_cannot_manage_admin'
        using hint = 'Administrators cannot remove another administrator.';
    end if;
    return old;
  end if;

  -- The escalation itself: only the room's owner may ever hold this role, so a
  -- compromised admin session cannot mint a second Core Prompter or promote
  -- itself into the seat that controls the Claude session.
  if new.role = 'core_prompter' and new.user_id <> v_owner then
    raise exception 'core_prompter_reserved_for_owner'
      using hint = 'The Core Prompter role belongs to the room owner and cannot be assigned.';
  end if;

  if tg_op = 'UPDATE' then
    if new.room_id is distinct from old.room_id or new.user_id is distinct from old.user_id then
      raise exception 'membership_identity_immutable'
        using hint = 'A membership cannot be moved to another room or user.';
    end if;

    -- The owner's own row is frozen for role and status (nobody demotes, bans
    -- or "removes" the Core Prompter). last_seen_at and joined_at stay
    -- writable so the owner's own presence heartbeat still works.
    if old.user_id = v_owner
       and (new.role is distinct from old.role or new.status is distinct from old.status) then
      raise exception 'core_prompter_membership_immutable'
        using hint = 'The Core Prompter''s role and status cannot be changed.';
    end if;

    if v_actor_is_peer_admin
       and old.role = 'administrator'
       and old.user_id <> auth.uid()
       and (new.role is distinct from old.role or new.status is distinct from old.status) then
      raise exception 'admin_cannot_manage_admin'
        using hint = 'Administrators cannot change another administrator''s role or status.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_room_members_guard on public.room_members;
create trigger trg_room_members_guard
  before insert or update or delete on public.room_members
  for each row execute function public.guard_room_member();

-- Invitation email normalisation. -------------------------------------------
create or replace function public.normalise_invitation_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Runs before the `email = lower(email)` check constraint, so callers may
  -- pass whatever casing the user typed and the stored value is still the one
  -- accept_invitation compares against.
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

drop trigger if exists trg_invitations_normalise_email on public.invitations;
create trigger trg_invitations_normalise_email
  before insert or update on public.invitations
  for each row execute function public.normalise_invitation_email();

-- ---------------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.rooms           enable row level security;
alter table public.room_members    enable row level security;
alter table public.invitations     enable row level security;
alter table public.messages        enable row level security;
alter table public.claude_sessions enable row level security;
alter table public.audit_logs      enable row level security;

-- profiles ------------------------------------------------------------------
-- Readable by yourself and by people you actually share a room with, so the
-- access panel and message bubbles can show names and avatars without exposing
-- the whole user directory.

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.shares_active_room(id));

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No delete policy: profiles disappear with their auth.users row.

-- rooms ---------------------------------------------------------------------

drop policy if exists rooms_select_members on public.rooms;
create policy rooms_select_members on public.rooms
  for select to authenticated
  using (public.is_active_member(id) or owner_id = auth.uid());

drop policy if exists rooms_insert_own on public.rooms;
create policy rooms_insert_own on public.rooms
  for insert to authenticated
  with check (owner_id = auth.uid());

-- Admins are admitted here only so they can flip is_locked; guard_room_update
-- rejects any other column change from a non-owner.
drop policy if exists rooms_update_admin on public.rooms;
create policy rooms_update_admin on public.rooms
  for update to authenticated
  using (public.is_room_admin(id))
  with check (public.is_room_admin(id));

drop policy if exists rooms_delete_owner on public.rooms;
create policy rooms_delete_owner on public.rooms
  for delete to authenticated
  using (public.is_room_owner(id));

-- room_members --------------------------------------------------------------

-- Active members see the roster (the access panel needs it); everyone can see
-- their own row in any state, which is what lets the client detect that it has
-- been removed or banned and eject itself.
drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members
  for select to authenticated
  using (public.is_active_member(room_id) or user_id = auth.uid());

drop policy if exists room_members_insert_admin on public.room_members;
create policy room_members_insert_admin on public.room_members
  for insert to authenticated
  with check (public.is_room_admin(room_id));

drop policy if exists room_members_update_admin on public.room_members;
create policy room_members_update_admin on public.room_members
  for update to authenticated
  using (public.is_room_admin(room_id))
  with check (public.is_room_admin(room_id));

drop policy if exists room_members_delete_admin on public.room_members;
create policy room_members_delete_admin on public.room_members
  for delete to authenticated
  using (public.is_room_admin(room_id));

-- invitations ---------------------------------------------------------------
-- Admin-only in every direction. A pending invitee has no membership row yet,
-- so they cannot read their own invitation: redemption goes through
-- accept_invitation(), and the invite landing page resolves the token with the
-- service-role client. No DELETE policy — revoking sets revoked_at so the
-- attempt stays visible in the audit trail.

drop policy if exists invitations_select_admin on public.invitations;
create policy invitations_select_admin on public.invitations
  for select to authenticated
  using (public.is_room_admin(room_id));

drop policy if exists invitations_insert_admin on public.invitations;
create policy invitations_insert_admin on public.invitations
  for insert to authenticated
  with check (public.is_room_admin(room_id) and invited_by = auth.uid());

drop policy if exists invitations_update_admin on public.invitations;
create policy invitations_update_admin on public.invitations
  for update to authenticated
  using (public.is_room_admin(room_id))
  with check (public.is_room_admin(room_id));

-- messages ------------------------------------------------------------------

drop policy if exists messages_select_members on public.messages;
create policy messages_select_members on public.messages
  for select to authenticated
  using (public.is_active_member(room_id));

-- The full send rule, mirroring can('room.send_message'):
--   * active member of this room, and
--   * writing as themselves, and
--   * claiming a human sender_type (assistant/system rows are service-role
--     only — no policy grants them), and
--   * not impersonating the Core Prompter, and
--   * not a viewer, and
--   * either the owner, or the room is unlocked with collaborator messages on.
drop policy if exists messages_insert_members on public.messages;
create policy messages_insert_members on public.messages
  for insert to authenticated
  with check (
    public.is_active_member(room_id)
    and sender_id = auth.uid()
    and sender_type in ('core_prompter', 'collaborator')
    and (sender_type <> 'core_prompter' or public.current_member_role(room_id) = 'core_prompter')
    and public.current_member_role(room_id) is distinct from 'viewer'::public.room_role
    and (
      public.is_room_owner(room_id)
      or exists (
        select 1
        from public.rooms r
        where r.id = messages.room_id
          and r.is_locked = false
          and r.allow_collaborator_messages = true
      )
    )
  );

-- Approval, rejection and edits are the Core Prompter's gate on what reaches
-- Claude, so only the owner may update a message row.
drop policy if exists messages_update_owner on public.messages;
create policy messages_update_owner on public.messages
  for update to authenticated
  using (public.is_room_owner(room_id))
  with check (public.is_room_owner(room_id));

-- No delete policy: the transcript is append-only for every client.

-- claude_sessions -----------------------------------------------------------

drop policy if exists claude_sessions_select_members on public.claude_sessions;
create policy claude_sessions_select_members on public.claude_sessions
  for select to authenticated
  using (public.is_active_member(room_id));

drop policy if exists claude_sessions_insert_owner on public.claude_sessions;
create policy claude_sessions_insert_owner on public.claude_sessions
  for insert to authenticated
  with check (public.is_room_owner(room_id) and owner_id = auth.uid());

drop policy if exists claude_sessions_update_owner on public.claude_sessions;
create policy claude_sessions_update_owner on public.claude_sessions
  for update to authenticated
  using (public.is_room_owner(room_id))
  with check (public.is_room_owner(room_id));

-- audit_logs ----------------------------------------------------------------
-- Deliberately policy-free. RLS is enabled and nothing is granted, so
-- authenticated and anon get zero rows on SELECT and a rejection on INSERT.
-- The service-role client bypasses RLS and is the only writer/reader. Do not
-- add a policy here: members being able to read the audit trail would leak
-- other rooms' moderation activity and every rate-limit/injection verdict.

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
-- RLS filters rows; grants decide whether the role may address the table at
-- all. Both layers are set explicitly rather than relying on the project's
-- default privileges.

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update on public.profiles        to authenticated;
grant select, insert, update, delete on public.rooms   to authenticated;
grant select, insert, update, delete on public.room_members to authenticated;
grant select, insert, update on public.invitations     to authenticated;
grant select, insert, update on public.messages        to authenticated;
grant select, insert, update on public.claude_sessions to authenticated;

grant all on public.profiles, public.rooms, public.room_members, public.invitations,
             public.messages, public.claude_sessions, public.audit_logs
  to service_role;

-- Nothing in this app is public. An unauthenticated PostgREST call should fail
-- on privileges before RLS is even consulted.
revoke all on public.profiles, public.rooms, public.room_members, public.invitations,
              public.messages, public.claude_sessions, public.audit_logs
  from anon;

-- Second lock on the audit trail, in case a future migration adds a policy by
-- accident: no privilege, no read, regardless of policies.
revoke all on public.audit_logs from authenticated;

-- SECURITY DEFINER functions are granted to PUBLIC by default — that would let
-- an anonymous caller run them with the definer's rights. Lock them down and
-- re-grant only to signed-in users.
revoke all on function public.current_member_role(uuid) from public, anon;
revoke all on function public.is_active_member(uuid)    from public, anon;
revoke all on function public.is_room_owner(uuid)       from public, anon;
revoke all on function public.is_room_admin(uuid)       from public, anon;
revoke all on function public.shares_active_room(uuid)  from public, anon;
revoke all on function public.accept_invitation(text)   from public, anon;

grant execute on function public.current_member_role(uuid) to authenticated;
grant execute on function public.is_active_member(uuid)    to authenticated;
grant execute on function public.is_room_owner(uuid)       to authenticated;
grant execute on function public.is_room_admin(uuid)       to authenticated;
grant execute on function public.shares_active_room(uuid)  to authenticated;
grant execute on function public.accept_invitation(text)   to authenticated;

-- The policies above call these helpers while running as the invoking role, so
-- the service role needs execute rights too even though it bypasses RLS.
grant execute on function public.current_member_role(uuid) to service_role;
grant execute on function public.is_active_member(uuid)    to service_role;
grant execute on function public.is_room_owner(uuid)       to service_role;
grant execute on function public.is_room_admin(uuid)       to service_role;
grant execute on function public.shares_active_room(uuid)  to service_role;
grant execute on function public.accept_invitation(text)   to service_role;

-- ---------------------------------------------------------------------------
-- 9. Realtime
-- ---------------------------------------------------------------------------
-- useRoomRealtime subscribes to postgres_changes on these two tables. Adding a
-- table that is already in the publication is an error, so both steps are
-- guarded to keep the migration re-runnable.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_members'
  ) then
    alter publication supabase_realtime add table public.room_members;
  end if;
exception
  when insufficient_privilege then
    raise warning 'Could not configure the supabase_realtime publication. Enable Realtime for public.messages and public.room_members from the dashboard.';
end $$;

-- DELETE events only carry the replica identity. Without FULL, a member
-- deletion would arrive without room_id and the client's `room_id=eq.…` filter
-- would silently drop it, leaving a removed user on screen. The table is small,
-- so the extra WAL is irrelevant. messages is append-only and its INSERT/UPDATE
-- payloads already carry the whole row, so it keeps the default.
alter table public.room_members replica identity full;
