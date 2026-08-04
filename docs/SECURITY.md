# Security

The threat model for a room, the control that answers each threat, and — for
every control — whether it is enforced by Postgres or by the application.

The organising principle is stated at the top of
`supabase/migrations/0001_init.sql` and repeated here because it decides how to
read everything below:

> **The database is the security boundary.** `src/lib/permissions.ts` mirrors the
> same rules so the UI can hide controls and the API can produce good error
> messages, but nothing in TypeScript is trusted. A caller who edits a room id in
> a URL, or who takes their anon key and talks to PostgREST directly, must get
> zero rows.

Every rule is therefore expressed twice — once in TypeScript for ergonomics,
once in SQL for enforcement — and the SQL version wins. The pipeline is written
to *notice* when the two disagree: `storeOriginalMessage` writes through the
user's own session even though `validateSecurity` already approved, and if
Postgres refuses with `42501` it logs "capability layer and policy have drifted"
and surfaces a 403 rather than retrying with the service role.

---

## Who is trusted with what

| Principal | Credential | Trust |
| --- | --- | --- |
| Anonymous visitor | none | All privileges on all app tables are `REVOKE`d from `anon`, so a request fails on privileges before RLS is even consulted. |
| Signed-in member (browser) | anon key + their JWT | Sees exactly what RLS lets them see. Assumed hostile: they can call PostgREST directly with their own token, bypassing the app entirely. |
| Route handler | anon key + the caller's JWT | Same trust as the member it is acting for. This is deliberate — the policy runs. |
| Service role | `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS completely. Used only where RLS cannot express the requirement, and never to make an access decision. |

---

## Threats and controls

### 1. URL / room-id tampering

**Threat.** A member edits a room id in the address bar, or in a `fetch` call, or
in a PostgREST query made directly with their own anon key, and reads a
conversation they were never invited to.

**Control — database (authoritative).** Row Level Security on every table.
`rooms_select_members` admits `is_active_member(id) or owner_id = auth.uid()`;
`messages_select_members` admits `is_active_member(room_id)`;
`room_members_select` admits active members plus your own row in any status;
`profiles_select` admits yourself plus anyone you share an *active* room with, so
the roster and message bubbles can render names without exposing the user
directory. A tampered id simply returns zero rows — including over Realtime,
which re-evaluates RLS per subscriber, and including for the `room_id=eq.<id>`
channel filter, which is an optimisation rather than the protection.

**Control — application.** `loadRoomContext` validates the id's shape before it
reaches Postgres' uuid parser (a malformed id is a 400, not a 500) and then reads
the room, the membership and the profile through the **user-scoped** client. It
proves access rather than asserting it.

**Enumeration.** "No such room" and "you are not a member of this room" return
the identical 404 sentence, because RLS already makes them indistinguishable at
the data layer and collapsing them keeps them indistinguishable at the API. A
membership row that is *visible but not active* is different: the caller
demonstrably belongs to the room's history, so they get a specific 403 — that is
the only way "you were removed" can be shown at all, and it leaks nothing they
did not already know.

---

### 2. Role escalation

**Threat.** An administrator promotes themselves (or an accomplice) to Core
Prompter and takes the Claude session; or two administrators demote each other;
or somebody moves a membership row into a different room.

**Control — database (authoritative).**

- `guard_room_member` raises `core_prompter_reserved_for_owner` if any
  membership other than the room owner's is given the `core_prompter` role.
- The same trigger raises `core_prompter_membership_immutable` when the owner's
  own row would be demoted, removed or banned — including on `DELETE`.
- It raises `admin_cannot_manage_admin` when the actor is an active
  administrator who is not the owner and the target is another administrator, on
  both `UPDATE` and `DELETE`.
- It raises `membership_identity_immutable` if `room_id` or `user_id` changes.
- A **partial unique index** on `room_members (room_id) where role =
  'core_prompter'` caps the room at one Core Prompter in the storage engine.
- `guard_room_update` freezes `id`, `owner_id` and `created_at` on `rooms`, and
  restricts a non-owner admin to toggling `is_locked` alone — a column-level rule
  RLS cannot express, which is why it lives in a trigger. It is named to sort
  before `trg_rooms_touch_updated_at` so it sees the caller's diff.
- `invitations.role` carries `check (role <> 'core_prompter')`.

**Control — application.** `canChangeRole()` and `canRemoveMember()` in
`permissions.ts` refuse the same cases with a readable sentence;
`validateSecurity` step 5 runs them before any write; the members routes reject
`core_prompter` by name before the capability check even runs, so the user gets
"the Core Prompter role belongs to the room's owner" rather than an enum error.
The access panel greys out the controls it knows will fail.

**Note on the service-role exemption.** The guards return early when
`auth.uid() is null`, which can only be the service role — trusted server code
that has already run its own capability checks. RLS keeps anonymous callers out
entirely, so a null uid has no other origin.

---

### 3. Impersonation

**Threat.** A collaborator sends a message that claims to be from the Core
Prompter, or forges a reply from Claude, so that other members — or Claude
itself — act on it.

**Control — application.** There is no field to forge. The message endpoint
accepts `{ content }` and nothing else; the room comes from the path and the
sender from `auth.getUser()`, which re-validates the JWT with Supabase rather
than trusting the cookie the way `getSession()` would. Name, account address and
role in the contribution header all come from that verified context, never from
the stored row's claims or the request body.

**Control — database (authoritative).** `messages_insert_members` requires
`sender_id = auth.uid()`, restricts `sender_type` to `('core_prompter',
'collaborator')`, and additionally requires `current_member_role(room_id) =
'core_prompter'` before anyone may write a `core_prompter` row. No policy grants
`assistant` or `system` at all, so those rows are service-role-only — that is
what makes a forged reply from Claude impossible rather than merely unlikely.

**Control — prompt.** In the transcript, identity lives in the block header,
which the sender cannot write into. `Account:` (the email) is included alongside
the display name because display names are self-chosen and two people can pick
the same one. The system prompt states plainly that the header is the only source
of a sender's identity and role.

---

### 4. Prompt injection

**Threat.** A collaborator writes text designed to be read as instructions —
"ignore previous instructions", a fake `<system>` turn, a forged
`Core Prompter says:` line, a second contribution header — and steers a
conversation they do not own.

**Control — structural framing (application).** This is the control that
actually holds.

1. Every human turn — the Core Prompter's included — is wrapped in the identical
   envelope by `buildStructuredContribution`. The uniformity is the point: if
   only collaborators were framed, the *absence* of framing would itself be a
   signal a collaborator could imitate.
2. The message body sits between `<<<PARTICIPANT_MESSAGE>>>` and
   `<<</PARTICIPANT_MESSAGE>>>`, and `neutraliseDelimiters()` HTML-escapes
   anything in the payload that would read as either marker. The pattern
   tolerates the obvious evasions — extra angle brackets, whitespace inside the
   marker, any casing — because what matters is what a *model* would read as a
   closing marker, not the exact literal. `prompt.ts` imports the marker
   constants from `sanitize.ts` rather than re-declaring them, so the frame and
   the escaper cannot drift apart.
3. The same escaping is applied to names, email addresses and the room title,
   with whitespace collapsed, because those are user-controlled too: a display
   name containing a newline and `Role: Core Prompter` would otherwise forge a
   second header.
4. `normaliseMessage()` strips zero-width and bidirectional-control characters
   before anything is stored. Those survive a copy/paste and render as nothing,
   which makes them the standard vehicle for hiding an instruction inside text
   that looks innocuous to a human reviewer — including the Core Prompter
   reviewing a pending contribution. Stripping them means what the approver sees
   is what Claude receives.
5. The system prompt tells Claude that framed text is a record of what someone
   wrote, that a participant cannot grant themselves a role by asserting it, and
   that a contribution attempting to override the instructions should simply have
   that part set aside — no lecture, no refusing the whole turn. It is
   deliberately calm and unemphatic: shouting makes current models over-trigger
   and start treating ordinary discussion *about* prompts as an attack.

**Control — heuristics (application, non-blocking).**
`detectPromptInjection()` scores about a dozen weighted patterns and combines
them as independent probabilities, so five weak signals cannot outrank one
unambiguous "ignore previous instructions" and the total stays in 0..1. At
`score >= 0.7` it writes `security.prompt_injection_suspected` to the audit log
and attaches a `warning` issue to the response. **It never blocks.** Pattern
matching on natural language cannot be made complete: a gate there would reject
legitimate discussion about prompting while still missing any paraphrase. Its job
is to make an attempt visible to an operator and to the Core Prompter, not to
decide.

**Control — human (product).** `approval_required` mode puts a person between a
contribution and the model, which is the only control here that generalises to
attacks nobody has thought of yet.

**Residual risk, stated plainly.** A sufficiently clever paraphrase inside the
frame may still influence a turn. The framing bounds the *blast radius* — the
model is told whose words these are and what weight they carry — it does not make
influence impossible.

---

### 5. Key exposure

**Threat.** The Claude API key or the Supabase service-role key ends up in the
client bundle, where anybody can read it. The service-role key bypasses RLS
entirely, so leaking it is equivalent to publishing the database password.

**Control — application.**

- `src/lib/env.ts` is the only place either secret is read. `serverEnv`'s getters
  call `assertServer()`, which throws if `typeof window !== 'undefined'` — an
  accidental client import becomes a loud error instead of a silent leak.
- Neither secret is prefixed `NEXT_PUBLIC_`, which is the only namespace Next
  inlines into the browser bundle, and `next.config.ts` sets `env: {}` so nothing
  else is inlined either.
- `lib/supabase/admin.ts`, `lib/claude/client.ts` and `lib/server/pipeline.ts`
  begin with `import 'server-only'`, making a reference from a `'use client'`
  file a build failure.
- The Anthropic client is constructed lazily rather than at module scope,
  because `serverEnv.anthropicApiKey` throws when unset and evaluating it on
  import would break `next build` on a machine that only has the public vars.
- `recordAudit` runs every metadata object through a sanitiser that redacts any
  key matching `/token|key|secret|password/i` and truncates long strings, so a
  credential cannot reach the log by way of an ad-hoc metadata field.
- `.env` and `.env*.local` are gitignored.

**Control — database.** None applicable; this one is entirely an application
concern. What the database contributes is that a leaked *anon* key is not a
breach: it grants nothing on its own, because RLS resolves everything from
`auth.uid()`.

---

### 6. Invitation misuse

**Threat.** An invitation link is guessed, forwarded, replayed, or used to walk a
banned account back into a room.

**Control — application.** The token is 32 bytes from Node's CSPRNG
(`randomBytes(32).toString('base64url')`) — 256 bits, URL-safe without escaping,
far past anything enumerable against a column with a unique index. Expiry is 7
days. `GET .../members` selects an explicit column list that omits `token`
rather than selecting `*` and deleting the key afterwards, so a future refactor
cannot re-leak it; the URL is returned exactly once, to the administrator who
created it. An outstanding invitation for the same address is *refreshed* rather
than duplicated, so revoking the visible one can never leave a second live token
behind. `POST /api/invitations/accept` is rate limited to 20 attempts per user
per hour — the token is not guessable, but redemption is the one authenticated
endpoint that accepts an arbitrary secret and it should not be a free oracle. The
invite page carries `robots: { index: false, follow: false }`, and it deliberately
shows **no** room details before redemption, so a stolen link reveals nothing
about the room it points at.

**Control — database (authoritative).** `accept_invitation(token)` is a single
`SECURITY DEFINER` transaction that locks the invitation row `FOR UPDATE` (so two
concurrent redemptions cannot both see `accepted_at` as null) and then refuses it
unless it is unrevoked, unredeemed and unexpired. Crucially it compares the
caller's own email — from the JWT claim, falling back to `auth.users` — against
the invited address, both lower-cased, with the stored value normalised by
`trg_invitations_normalise_email` and pinned by a `check (email = lower(email))`
constraint. **A forwarded or shoulder-surfed link is useless to anybody but the
intended recipient.** A `banned` membership raises `membership_banned` rather
than being laundered back to active; a `removed` one is restored; a Core
Prompter who happens to redeem an invitation is never demoted by it. The
`invitations` policies are admin-only in every direction, and there is no DELETE
policy — revocation is meant to set `revoked_at` so the attempt stays in the
record.

**Gap.** No endpoint currently sets `revoked_at`, and no endpoint lifts a ban.
Both are supported by the schema and the redemption function; today they require
SQL. See the README's *what is not included* section.

---

### 7. Immediate revocation

**Threat.** Somebody is removed from a room and keeps reading it — from an open
tab, from a cached page, or from a direct PostgREST call with a token that has
not expired yet.

**Control — database (authoritative).** Removal is a status flip
(`removed` / `banned`), not a row delete, and **every** policy resolves
membership through `is_active_member()` or `current_member_role()`, both of which
filter on `status = 'active'`. There is no cached capability anywhere: the
functions are `STABLE`, so they are re-evaluated on each statement. The very next
request from that account — through the app or straight to PostgREST with their
own JWT — returns zero rows. `can()` mirrors this by returning false for every
capability when `status !== 'active'`.

The row is updated rather than deleted for two reasons: deleting it would take
the ban with it, letting the account be re-invited straight back in; and the
record of who removed whom would be reduced to an audit line with nothing to
point at.

**Control — realtime (application).** `room_members` is in the
`supabase_realtime` publication with `replica identity full`, so the UPDATE
reaches the removed member's open tab — and a DELETE would still carry `room_id`
and survive the channel filter. `useRoomRealtime` sets `error: 'access_revoked'`
and latches it, and `ChatArea` replaces the whole conversation column with a
notice. This is the *visible* half; the database half is what makes it true.

**Residual.** Their existing JWT stays valid until it expires — it just no longer
authorises anything in that room, which is the property that matters. Anything
they had already loaded into their browser before removal is, unavoidably,
already in their browser.

---

### 8. Cross-site scripting

**Threat.** A contribution — or Claude's reply to one — contains markup or a
script that executes in another member's browser, turning a prompt injection into
stored XSS.

**Control — application.** **There is no `dangerouslySetInnerHTML` anywhere in
`src/`.** (Verified by search: the only occurrence of the string in the whole
tree is inside a comment in `src/app/globals.css` explaining why it is not used.)
There is no `innerHTML` assignment, no `eval`, and no `new Function`.

Every message body is rendered as a React text node — `<p>{body}</p>` in
`MessageBubble` — so React escapes it. Claude replies in markdown-flavoured text
and it is deliberately **not** parsed: the `prose-plain` utility in `globals.css`
restores only the *typography* of plain text (`white-space: pre-wrap`,
`overflow-wrap: anywhere`, a readable measure) so the output looks right without
ever becoming HTML. Typing-indicator payloads, which arrive as untyped JSON from
another client's browser, are field-checked before anything is rendered from
them.

**Supporting headers.** `next.config.ts` sets `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a
`Permissions-Policy` denying camera, microphone and geolocation.

**Gaps.** There is **no Content-Security-Policy**, so React's escaping is the
only thing standing between a future `dangerouslySetInnerHTML` and stored XSS —
adding a CSP is the highest-value hardening left in this codebase. And
`Avatar` renders `profiles.avatar_url` into a plain `<img src>` with no scheme or
host allow-list; since `profiles_update_self` lets a member set their own row
directly, a member can point their avatar at an arbitrary host and learn when
peers load it. That is a privacy leak rather than script execution (browsers do
not run `javascript:` in `img src`), but it is worth an allow-list.

---

### 9. Cross-site request forgery

**Threat.** A page on another origin causes a signed-in member's browser to
perform a state-changing request.

**Control — application.** There is no CSRF token. What stands in for one: every
mutating endpoint is `POST` / `PATCH` / `DELETE` with a JSON body, and a
cross-origin page cannot send `Content-Type: application/json` without a preflight
the app never answers; Supabase's auth cookies are `SameSite=Lax`, so they are
not attached to cross-site non-navigational requests; and sign-out is POST-only
and returns a 303, specifically because a GET sign-out can be triggered by any
`<img>` tag on a third-party page and is a trivial denial of service on someone's
session. `X-Frame-Options: DENY` rules out clickjacking as a delivery route.

**Also here — open redirect.** `/auth/callback` is the one URL an attacker can
reliably get a victim to click, so `safeNext()` accepts only same-origin paths
and explicitly rejects `//evil.example` and `/\evil.example`, which browsers
resolve as absolute URLs and which a naive "starts with a slash" test would let
through.

---

### 10. Rate limiting and abuse

**Threat.** One member floods the room, burns the workspace's Claude quota, mints
rooms in a loop, or sprays invitations.

**Control — application.** `checkRateLimit` (`lib/server/rate-limit.ts`) keeps
sliding-window counters keyed by room and user. Defaults:

| Bucket | Limit | Window | Applies to |
| --- | --- | --- | --- |
| `messagePerUser` | 20 | 1 min | `room.send_message`, keyed `room:user` |
| `claudePerRoom` | 30 | 1 min | `room.send_message` **and** `room.approve_message`, keyed on the room |
| `invitePerRoom` | 20 | 1 hr | `room.invite` |
| `roomCreatePerUser` | 10 | 1 hr | `POST /api/rooms` |
| `invitationAcceptPerUser` | 20 | 1 hr | `POST /api/invitations/accept` |

Sending and approving deliberately share one bucket: both cause exactly one
Claude turn, so separate buckets would let the per-room ceiling be doubled
trivially. A denied attempt is *not* recorded, so a client that keeps hammering
cannot push its own window forward and lock itself out indefinitely. Every
refusal writes two audit rows — `security.rate_limited` for a clean throttling
series and `security.denied` for one queryable stream of all refusals — and
returns a 429 with `Retry-After`.

**Limitation, and it is a real one.** These counters live in **one Node
process's memory**. That is correct for a single instance and wrong the moment
the app is scaled horizontally or moved to a runtime that spins up isolates per
request: N instances multiply every limit by N, and a cold start resets the
window. There is also a 50 000-key ceiling above which the limiter **fails open**
rather than denying every request — a limiter that causes an outage under memory
pressure is worse than one that lapses. Move the store to Redis or a
`rate_limit_hits` table before running more than one instance.

**Control — database.** Independent structural bounds that do not depend on the
limiter: `char_length(original_content) between 1 and 8000` for human sender
types (Claude's own turns share the column and routinely exceed it, so the
constraint is scoped rather than applied to the whole column), an 80-character
room name, a 60-character display name, and `unique (room_id, user_id)` on
memberships. The API adds a raw-payload ceiling of `MAX_MESSAGE_LENGTH * 4` so a
multi-megabyte body is never parsed or normalised at all, and caps a combine
request at 20 contributions so one call cannot assemble a turn large enough to
blow the context window.

---

### 11. Audit logging

**Threat.** Something happens in a room and nobody can reconstruct who did it —
or the person who did it edits the record.

**Control — database (authoritative).** `audit_logs` has RLS **enabled with no
policies at all**, so `authenticated` and `anon` get zero rows on `SELECT` and a
rejection on `INSERT`. On top of that, all privileges are `REVOKE`d from both
roles, so a future migration that adds a policy by accident still cannot open it
up: no privilege, no access, regardless of policies. Only the service role can
write it. A Core Prompter cannot edit the record of what they did in their own
room, and members cannot read other rooms' moderation activity or anyone's
rate-limit and injection verdicts. `room_id` and `actor_id` are `ON DELETE SET
NULL` rather than `CASCADE`, so audit rows outlive the things they describe.

**Control — application.** `recordAudit` (`lib/server/audit.ts`) writes through
the service-role client and **never throws** — an audit write is observability,
not correctness, and failing a user's message because the log table was briefly
unavailable would be the worse outcome. Metadata is depth-limited, array-limited,
string-truncated, and stripped of any key matching `/token|key|secret|password/i`
before it is persisted.

The action vocabulary is the `AUDIT_ACTIONS` union in `lib/types.ts`:
room lifecycle (`room.created`, `room.deleted`, `room.locked`, `room.unlocked`,
`room.mode_changed`, `room.messaging_toggled`), membership
(`member.invited`, `member.joined`, `member.removed`, `member.banned`,
`member.role_changed`, `invitation.revoked`), messages (`message.sent`,
`message.approved`, `message.rejected`, `message.edited`), Claude
(`claude.request`, `claude.response`, `claude.error`) and security
(`security.denied`, `security.prompt_injection_suspected`,
`security.rate_limited`). Room settings changes are audited one row per field
with its own before/after, because a single combined row would make "who unlocked
this room" unanswerable without parsing a diff. Room deletion is audited
*before* the delete, since `room_id` is set to null and the room's name is gone
the moment the row is.

**Gap.** Nothing in the app reads this table. Today you query it with the
service-role key or from the SQL editor.

---

## Hardening the SQL layer itself

Three things in the migration are about protecting the protections:

**`SECURITY DEFINER` + pinned `search_path`.** `current_member_role`,
`is_active_member`, `is_room_owner`, `is_room_admin`, `shares_active_room` and
`accept_invitation` all run as their definer, which is necessary — a policy on
`room_members` that needs to read `room_members` would re-enter its own policy
forever, and running the lookup as the table owner breaks the cycle. Every one of
them sets `search_path = public, pg_temp`, which stops a caller from shadowing a
referenced object with a temp-schema decoy: the classic `SECURITY DEFINER`
attack.

**Execute grants.** Postgres grants function execute to `PUBLIC` by default,
which would let an anonymous caller run these with the definer's rights. All six
are revoked from `public` and `anon` and re-granted to `authenticated` and
`service_role`.

**Grants as a second layer under RLS.** RLS filters rows; grants decide whether a
role may address the table at all. Both are set explicitly rather than inherited
from project defaults, and everything is revoked from `anon`, so an
unauthenticated PostgREST call fails on privileges before a policy is consulted.

---

## Where each control lives

The spec requires the database to be authoritative. This is the ledger.

| Control | Postgres | Application | Authoritative |
| --- | :---: | :---: | --- |
| Room / message / roster visibility | RLS `*_select_*` policies | `loadRoomContext` reads via user-scoped client | **database** |
| Who may send a message | `messages_insert_members` | `can('room.send_message')`, `validateSecurity` | **database** |
| Sender identity | `sender_id = auth.uid()` in the insert policy | identity from `auth.getUser()`; no body field names a sender | **database** |
| Assistant / system messages | no policy grants those sender types | service-role-only insert in `pipeline.ts` | **database** |
| Approve / reject / edit | `messages_update_owner` | `can('room.approve_message')` (Core Prompter only) | **database** |
| One Core Prompter per room | partial unique index + `guard_room_member` | `canChangeRole`, route-level refusal | **database** |
| Admin cannot manage admin | `guard_room_member` | `canChangeRole`, `canRemoveMember` | **database** |
| Admin may only toggle the lock | `guard_room_update` | per-field capability map in the room PATCH route | **database** |
| Room bootstrap (owner membership + Claude session) | `bootstrap_room` trigger | route verifies both rows and rolls back if missing | **database** |
| Invitation email binding, expiry, single use, ban check | `accept_invitation` transaction | zod parsing, TTL, duplicate refresh | **database** |
| Invitation token secrecy | admin-only policies; no `anon` grant | explicit column projection omitting `token` | both |
| Immediate revocation | `is_active_member` / `current_member_role` filter on `status` | realtime eviction in `useRoomRealtime` | **database** |
| Audit trail integrity | RLS with no policies + revoked grants | `recordAudit` via service role, never throws | **database** |
| Message length / room name length | check constraints | `assertMessageLength`, zod, live counter | both |
| Prompt-injection framing | — | `sanitize.ts` + `prompt.ts` + system prompt | application |
| Prompt-injection heuristics | — | `detectPromptInjection` (warn only) | application |
| Rate limiting | — | in-memory sliding windows | application ⚠ per-process |
| XSS | — | React text nodes, no `dangerouslySetInnerHTML` | application |
| Secret containment | — | `env.ts` + `server-only` + no `NEXT_PUBLIC_` prefix | application |
| Open-redirect / CSRF surface | — | `safeNext()`, POST-only signout, JSON-only mutations | application |

Everything in the "application" rows is genuinely application-only, and each is
either impossible to express in SQL (prompt framing, XSS, secret handling) or
deliberately advisory (injection heuristics, rate limiting). Everything that
decides **who may read or change what** is enforced in Postgres, and the
TypeScript copy exists to explain the answer, not to produce it.
