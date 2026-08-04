-- ===========================================================================
-- 0002 — GitHub App connection
--
-- Binds a room to one repository through a GitHub App *installation*. The
-- installation id is the only credential material stored: access tokens are
-- minted per request from the app's private key and live an hour, so this
-- schema holds nothing that is useful if the database leaks.
--
-- Depends on 0001_init.sql (rooms, room_members, the is_room_* helpers).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'repo_access_mode') then
    create type public.repo_access_mode as enum ('read', 'read_pr');
  end if;
end
$$;

comment on type public.repo_access_mode is
  'read = Claude may browse and read files. read_pr = it may additionally push a branch and open a pull request. There is deliberately no mode that writes to the default branch.';

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- One row per GitHub App installation this deployment has seen. `installed_by`
-- records who completed the install so a room owner can only attach an
-- installation they themselves control.
create table if not exists public.github_installations (
  id               uuid primary key default gen_random_uuid(),
  installation_id  bigint not null unique,
  account_login    text not null,
  account_type     text not null default 'User',
  installed_by     uuid not null references auth.users (id) on delete cascade,
  suspended_at     timestamptz,
  created_at       timestamptz not null default now()
);

comment on table public.github_installations is
  'GitHub App installations, keyed by the numeric installation id. No tokens are stored: tokens are minted on demand from the app private key.';

-- The room -> repository binding. Unique on room_id: one repository per room,
-- so "the repo being edited in this chat" is never ambiguous.
create table if not exists public.repo_connections (
  id               uuid primary key default gen_random_uuid(),
  room_id          uuid not null unique references public.rooms (id) on delete cascade,
  installation_id  bigint not null references public.github_installations (installation_id) on delete cascade,
  owner            text not null,
  repo             text not null,
  default_branch   text not null default 'main',
  access_mode      public.repo_access_mode not null default 'read',
  connected_by     uuid not null references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint repo_connections_owner_len check (char_length(owner) between 1 and 100),
  constraint repo_connections_repo_len  check (char_length(repo)  between 1 and 100)
);

comment on table public.repo_connections is
  'Binds one room to one repository. Readable by the room''s active members so the UI can show what is connected; writable only by the room owner.';

-- Every tool call Claude makes against the repository. This is the record that
-- answers "what did the room do to my code", including the reads.
create table if not exists public.repo_actions (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references public.rooms (id) on delete cascade,
  message_id        uuid references public.messages (id) on delete set null,
  actor_id          uuid references auth.users (id) on delete set null,
  tool              text not null,
  arguments         jsonb not null default '{}'::jsonb,
  ok                boolean not null default true,
  summary           text not null default '',
  pull_request_url  text,
  created_at        timestamptz not null default now()
);

comment on table public.repo_actions is
  'Audit of repository tool calls. Members may read their room''s rows so the transcript can show what Claude touched; nobody may write through RLS.';

create index if not exists repo_actions_room_created_idx
  on public.repo_actions (room_id, created_at desc);
create index if not exists repo_connections_installation_idx
  on public.repo_connections (installation_id);
create index if not exists github_installations_installed_by_idx
  on public.github_installations (installed_by);

-- updated_at maintenance reuses the trigger function from 0001.
drop trigger if exists trg_repo_connections_touch_updated_at on public.repo_connections;
create trigger trg_repo_connections_touch_updated_at
  before update on public.repo_connections
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Guard: a room may only be pointed at an installation its owner installed
-- ---------------------------------------------------------------------------

create or replace function public.guard_repo_connection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner    uuid;
  v_installer uuid;
begin
  select r.owner_id into v_owner from public.rooms r where r.id = new.room_id;

  -- Parent room already gone (cascade delete); nothing left to protect.
  if v_owner is null then
    return new;
  end if;

  select i.installed_by into v_installer
  from public.github_installations i
  where i.installation_id = new.installation_id;

  if v_installer is null then
    raise exception 'installation_unknown'
      using hint = 'That GitHub App installation is not registered with this deployment.';
  end if;

  -- The decisive check. Without it, a room owner who learned any installation
  -- id — they are small integers and appear in GitHub URLs — could point their
  -- room at a stranger's repository and read it through our app's credentials.
  if v_installer <> v_owner then
    raise exception 'installation_not_owned'
      using hint = 'A room can only use a GitHub installation completed by that room''s Core Prompter.';
  end if;

  -- connected_by is attributed, not accepted: the only legitimate value is the
  -- owner, and letting it be set freely would misattribute the audit trail.
  if new.connected_by <> v_owner then
    raise exception 'connection_actor_mismatch'
      using hint = 'The repository connection must be recorded against the Core Prompter.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_repo_connections_guard on public.repo_connections;
create trigger trg_repo_connections_guard
  before insert or update on public.repo_connections
  for each row execute function public.guard_repo_connection();

-- ---------------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.github_installations enable row level security;
alter table public.repo_connections     enable row level security;
alter table public.repo_actions         enable row level security;

-- github_installations: strictly your own. The list of repositories an
-- installation can reach is fetched live from GitHub, never mirrored here, so
-- there is nothing to leak between users.
drop policy if exists github_installations_select_own on public.github_installations;
create policy github_installations_select_own on public.github_installations
  for select to authenticated
  using (installed_by = auth.uid());

drop policy if exists github_installations_insert_own on public.github_installations;
create policy github_installations_insert_own on public.github_installations
  for insert to authenticated
  with check (installed_by = auth.uid());

drop policy if exists github_installations_delete_own on public.github_installations;
create policy github_installations_delete_own on public.github_installations
  for delete to authenticated
  using (installed_by = auth.uid());

-- repo_connections: every active member sees which repository is attached —
-- they are talking to a Claude that can read it, so hiding it would be worse
-- than showing it. Only the owner may bind, rebind or detach.
drop policy if exists repo_connections_select_members on public.repo_connections;
create policy repo_connections_select_members on public.repo_connections
  for select to authenticated
  using (public.is_active_member(room_id));

drop policy if exists repo_connections_insert_owner on public.repo_connections;
create policy repo_connections_insert_owner on public.repo_connections
  for insert to authenticated
  with check (public.is_room_owner(room_id));

drop policy if exists repo_connections_update_owner on public.repo_connections;
create policy repo_connections_update_owner on public.repo_connections
  for update to authenticated
  using (public.is_room_owner(room_id))
  with check (public.is_room_owner(room_id));

drop policy if exists repo_connections_delete_owner on public.repo_connections;
create policy repo_connections_delete_owner on public.repo_connections
  for delete to authenticated
  using (public.is_room_owner(room_id));

-- repo_actions: readable by the room, written only by the service role. A
-- member who could forge a row could fabricate a pull request in the record.
drop policy if exists repo_actions_select_members on public.repo_actions;
create policy repo_actions_select_members on public.repo_actions
  for select to authenticated
  using (public.is_active_member(room_id));

-- No insert/update/delete policy on purpose.

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

grant select, insert, delete on public.github_installations to authenticated;
grant select, insert, update, delete on public.repo_connections to authenticated;
grant select on public.repo_actions to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Profile bootstrap for OAuth signups
-- ---------------------------------------------------------------------------
-- Same function as 0001 with GitHub's `user_name` (the @handle) added to the
-- fallback chain: a GitHub account with a hidden real name would otherwise
-- land on the email local part, and with a private email on 'Member'.

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
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'user_name'), ''),
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

-- ---------------------------------------------------------------------------
-- 7. Realtime
-- ---------------------------------------------------------------------------
-- Connecting or detaching a repository changes what every participant's Claude
-- can see, so the panel updates without a reload.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'repo_connections'
    ) then
      alter publication supabase_realtime add table public.repo_connections;
    end if;
  end if;
end
$$;
