# Supabase setup

Everything the app needs from Postgres lives in one migration:
`supabase/migrations/0001_init.sql`. It is idempotent — running it twice on the
same project is safe.

Read this first if you are touching auth or permissions:
**the database is the security boundary.** `src/lib/permissions.ts` mirrors the
same rules so the UI can hide controls and the API can return good error
messages, but a caller who edits a room id in the URL, or who takes their anon
key and talks to PostgREST directly, is stopped by Row Level Security and by the
triggers described below — not by TypeScript.

---

## 1. Create the project

1. Create a project at <https://supabase.com/dashboard>.
2. Note the project URL, the **anon** key and the **service role** key from
   *Project settings → API*.

## 2. Run the migration

**With the CLI (preferred)**

```bash
npm i -g supabase           # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push            # applies supabase/migrations/*.sql in order
```

Against a local stack instead: `supabase start && supabase db reset`.

**Without the CLI**

Open *SQL Editor → New query* in the dashboard, paste the entire contents of
`supabase/migrations/0001_init.sql`, and run it. Do this as the default
`postgres` role — the migration attaches a trigger to `auth.users`, which a
lesser role may not do.

If you see `WARNING: Could not attach on_auth_user_created to auth.users`, the
schema is fine but new signups will not get a `profiles` row. Re-run just that
block from the SQL editor as `postgres`.

## 3. Environment variables

Copy `.env.example` to `.env.local` and fill it in:

| Variable | Where it comes from | Exposed to the browser? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project settings → API → Project URL | yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project settings → API → `anon` `public` | yes |
| `NEXT_PUBLIC_SITE_URL` | e.g. `http://localhost:3000` | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Project settings → API → `service_role` | **never** |
| `ANTHROPIC_API_KEY` | console.anthropic.com | **never** |

The two secrets are read only through `serverEnv` in `src/lib/env.ts`, which
throws if it is ever evaluated in a browser bundle. The service-role key
bypasses RLS entirely — treat it as a database password.

## 4. Auth configuration

*Authentication → Providers → Email*

- Enable **Email**.
- Enable **Confirm email** for password signups (recommended).
- Magic links are part of the same provider: leave *Enable email OTP / magic
  link* on. The login page offers both password and magic link.

*Authentication → URL Configuration*

- **Site URL**: `http://localhost:3000` in development, your deployed origin in
  production.
- **Redirect URLs**: add `http://localhost:3000/auth/callback` and
  `https://<your-domain>/auth/callback`. Magic links and the invite flow both
  land there.

*Optional, for nicer profiles*: when signing up with a password the app passes
`display_name` (and optionally `avatar_url`) in the user metadata. The
`handle_new_user` trigger reads them and falls back to the email local part, so
nothing breaks if they are absent.

## 5. Realtime

The migration adds `public.messages` and `public.room_members` to the
`supabase_realtime` publication and sets `replica identity full` on
`room_members` (so DELETE events still carry `room_id` and the client can eject
a removed member). If the migration warns that it could not configure the
publication, enable Realtime for those two tables under
*Database → Replication*.

Realtime re-checks RLS per subscriber, so a member only ever receives events for
rooms they are an active member of.

---

## Which policy protects what

| Table | SELECT | INSERT | UPDATE | DELETE |
| --- | --- | --- | --- | --- |
| `profiles` | yourself, plus anyone sharing an **active** room (`shares_active_room`) | yourself only | yourself only | — (cascades from `auth.users`) |
| `rooms` | active members and the owner | `owner_id = auth.uid()` | `is_room_admin` — but a non-owner may only change `is_locked` (trigger `guard_room_update`) | `is_room_owner` |
| `room_members` | active members of the room, plus your own row in any status | `is_room_admin` | `is_room_admin` | `is_room_admin` |
| `invitations` | `is_room_admin` | `is_room_admin` and `invited_by = auth.uid()` | `is_room_admin` | — (revoke sets `revoked_at`) |
| `messages` | active members | active, non-viewer member sending as themselves, room unlocked and collaborator messages enabled (owner exempt) | `is_room_owner` (approve / reject / edit) | — (append-only) |
| `claude_sessions` | active members | `is_room_owner` | `is_room_owner` | — (cascades with the room) |
| `audit_logs` | **no policy, no grant** — service role only | same | same | same |

`anon` has every privilege on these tables revoked, so an unauthenticated
request fails before RLS is even consulted.

### Rules RLS cannot express, enforced by triggers

| Trigger | Rule | Error raised |
| --- | --- | --- |
| `guard_room_update` | Administrators may toggle `is_locked` and nothing else; `id`, `owner_id` and `created_at` are immutable | `room_admin_may_only_toggle_lock`, `room_immutable_columns` |
| `guard_room_member` | `core_prompter` may only ever belong to the room owner | `core_prompter_reserved_for_owner` |
| `guard_room_member` | The owner's membership row cannot be demoted, removed or banned | `core_prompter_membership_immutable` |
| `guard_room_member` | An administrator cannot change or remove another administrator | `admin_cannot_manage_admin` |
| `guard_room_member` | A membership cannot be moved to another room or user | `membership_identity_immutable` |
| `bootstrap_room` | Every room gets exactly one active Core Prompter and one `claude_sessions` row, whoever inserts it | — |
| `handle_new_user` | Every `auth.users` row gets a `profiles` row | — |
| `normalise_invitation_email` | Invitation emails are stored lower-cased and trimmed | — |
| partial unique index | At most one `core_prompter` per room | unique violation |

The guards exempt the service-role client (`auth.uid()` is null there), which is
trusted server code that has already run its own capability checks.

### Helper functions

`current_member_role`, `is_active_member`, `is_room_owner`, `is_room_admin` and
`shares_active_room` are `SECURITY DEFINER`, `STABLE`, and pinned to
`search_path = public, pg_temp`. They exist because a policy on `room_members`
that needs to read `room_members` would recurse into itself forever; running the
lookup as the table owner breaks the cycle. Execute is revoked from `PUBLIC` and
`anon` and granted to `authenticated` and `service_role`.

### `accept_invitation(token)`

The only write path a non-member has into a room. In one transaction it locks
the invitation row, rejects it unless it is unredeemed, unrevoked and unexpired,
and then requires that the caller's own email matches the invited address — so a
forwarded or shoulder-surfed link is useless to anyone else. A `removed` member
is restored to `active`; a `banned` member is not. It is `VOLATILE` rather than
`STABLE` (unlike the read-only helpers) because Postgres refuses to run
`INSERT`/`UPDATE` inside a non-volatile function.

Failure messages, all distinguishable, with a human sentence in the error hint:

```
not_authenticated
invitation_invalid
invitation_revoked
invitation_already_accepted
invitation_expired
invitation_email_mismatch
membership_banned
```

Note that a pending invitee cannot `select` their own invitation — the policies
are admin-only. The `/invite/[token]` page resolves the token with the
service-role client, and the members API returns `InvitationSummary`, which
omits `token` so the bearer secret is never fanned out to the access panel.

### The 8000-character limit

`MAX_MESSAGE_LENGTH` is a limit on human input. Claude's own turns are stored in
the same `messages.original_content` column and routinely exceed it, so the
check constraint applies only to rows whose `sender_type` is `core_prompter` or
`collaborator`. `assistant` and `system` rows are unbounded — and are writable
only by the service role, since no policy grants those sender types.

---

## Verifying it works

After running the migration, this should return zero rows for a room you are not
a member of, no matter what id you substitute:

```sql
-- as an authenticated user, from the SQL editor's "run as" or the JS client
select * from public.rooms where id = '<someone-elses-room-id>';
select * from public.messages where room_id = '<someone-elses-room-id>';
```

And this should always fail:

```sql
select * from public.audit_logs;   -- permission denied for table audit_logs
```
