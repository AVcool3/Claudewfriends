# Architecture

How the app is put together: what each layer is allowed to know, how a message
travels from a textarea to Claude and back, how other people's browsers find out
about it, and why validation is split into two subsystems that never call a
model.

The one rule that shapes everything else: **the database is the enforcement
boundary.** Every capability in `src/lib/permissions.ts` has a matching Row Level
Security policy or trigger in `supabase/migrations/0001_init.sql`. The TypeScript
exists so the UI can hide controls and the API can return a sentence explaining a
refusal. If the two ever disagree, Postgres wins — and the pipeline is written to
notice that disagreement out loud rather than route around it.

---

## Layer map

```
  browser                                  server                         Postgres
  ───────                                  ──────                         ────────

  components/ui/*          ┐
  components/chat/*        │ 'use client'
  components/sidebar/*     │  Tailwind v4
  components/access/*      ┘
        │                                                                 ┌──────────────┐
        │ fetch()                                                         │ RLS policies │
        ▼                                                                 │ triggers     │
  hooks/useRoomRealtime ──── websocket ─────────────────────────────────► │ SECURITY     │
        │                    (postgres_changes, presence, broadcast)      │  DEFINER fns │
        │                                                                 └──────────────┘
        ▼                                                                        ▲
  app/api/**/route.ts  ──►  server/pipeline.ts                                   │
   zod body parsing         ├─ validation/security-validator.ts  (Agent 2)       │
   ValidationResult→HTTP    ├─ validation/functionality-validator.ts (Agent 1)   │
                            ├─ claude/prompt.ts  →  claude/client.ts ──► Anthropic API
                            ├─ server/room-context.ts ──┐                        │
                            ├─ server/rate-limit.ts     │ user-scoped client ────┤
                            ├─ server/audit.ts ─────────┼─ service-role client ──┘
                            └─ sanitize.ts              │
                                                        │
  lib/supabase/client.ts   browser, anon key ───────────┤
  lib/supabase/server.ts   request-scoped, anon + JWT ───┤   ← RLS applies
  lib/supabase/admin.ts    service role ─────────────────┘   ← RLS bypassed

  shared, no I/O:  lib/types.ts   lib/permissions.ts   lib/sanitize.ts   lib/env.ts
```

### What each layer may import

| Layer | May import | Must not import |
| --- | --- | --- |
| `lib/types.ts`, `lib/permissions.ts`, `lib/sanitize.ts` | each other only | anything with I/O |
| `lib/env.ts` | — | — (`serverEnv` getters throw in a browser context) |
| `lib/supabase/client.ts` (`'use client'`) | `publicEnv` | `serverEnv`, `admin.ts`, the Anthropic SDK |
| `lib/server/*`, `lib/validation/*`, `lib/claude/*` | everything server-side | React components |
| `app/api/**` | `lib/server/*`, `lib/validation/*` | Supabase clients directly, where a `lib/server` helper exists |
| `components/**`, `hooks/**` (`'use client'`) | `lib/types`, `lib/permissions`, `lib/sanitize`, `lib/supabase/client` | `serverEnv`, `admin.ts`, `pipeline.ts`, `claude/*` |

Three files carry `import 'server-only'` — `lib/supabase/admin.ts`,
`lib/claude/client.ts`, `lib/server/pipeline.ts`. That import turns a client-side
reference into a build error, which is the mechanical half of "the Claude key and
the service-role key never reach the browser"; `serverEnv`'s `assertServer()`
throw is the runtime half.

### Three Supabase clients, three trust levels

`lib/supabase/client.ts` runs in the browser with the anon key: a tampered room
id returns no rows because RLS filters it. `lib/supabase/server.ts` is
request-scoped and carries the user's JWT — still the anon key, still fully
subject to RLS, and it uses `getUser()` (which re-validates the token with
Supabase) rather than `getSession()` (which trusts a forgeable cookie).
`lib/supabase/admin.ts` is the service role and bypasses RLS entirely; it is used
only where RLS deliberately cannot express what is needed:

- writing `audit_logs`, which no member may read or write
- writing `sender_type = 'assistant'` and `'system'` message rows, which no
  policy grants to any client role
- writing `processed_content` and `claude_sessions.conversation_state` on the
  open path, where the actor is a collaborator but `messages_update_owner` and
  `claude_sessions_update_owner` admit only the Core Prompter
- verification read-backs, where using RLS would conflate "the write silently
  failed" with "this row is not visible to you"

Everything that is an *access decision* uses the user-scoped client, so the
policy runs. `loadRoomContext` in particular reads the room, the membership and
the profile through the caller's own session: it *proves* access rather than
asserting it.

---

## The nine-step message pipeline

`src/lib/server/pipeline.ts` is the only path that puts words in front of Claude.
Three entry points share it — `submitContribution`, `approveAndSend`,
`combineAndSend` (plus `rejectContribution`, which stops at step 3's mirror
image). The steps run in a fixed order because each depends on the guarantee the
previous one established.

| # | Step | Implemented in | Notes |
| --- | --- | --- | --- |
| 1 | Identify the authenticated sender | `lib/server/room-context.ts` (`requireUser`, `loadRoomContext`) via `lib/supabase/server.ts` | Identity comes from `auth.getUser()`. No request field names a sender, so there is nothing to forge. |
| 2 | Confirm permission to post | `lib/validation/security-validator.ts` (`validateSecurity`) + `lib/permissions.ts` | The ordered gate chain; every denial writes `security.denied`. |
| 3 | Store the original message | `lib/server/pipeline.ts` (`storeOriginalMessage`) → `lib/validation/functionality-validator.ts` (`verifyMessageStored`) | Written with the **user-scoped** client so `messages_insert_members` runs as an independent second check, then read back to prove it committed. |
| 4 | Label sender identity and role | `lib/server/pipeline.ts` (`submitContribution`; `contributionForRow` for approve/combine) | Name, account and role are taken from the verified context, not from the stored row's claims. |
| 5 | Convert to a structured contribution | `lib/claude/prompt.ts` (`buildStructuredContribution`) + `lib/sanitize.ts` (`neutraliseDelimiters`) | Persisted to `processed_content` so a later replay reproduces exactly what was sent. |
| 6 | Add conversation context | `lib/server/pipeline.ts` (`loadTranscriptContext`) + `lib/claude/prompt.ts` (`buildSystemPrompt`, `buildClaudeRequest`) | Replays the last `CLAUDE_HISTORY_LIMIT` (60) delivered turns; pending and rejected rows are excluded in SQL *and* again in `buildClaudeRequest`. |
| 7 | Send to Claude | `lib/validation/functionality-validator.ts` (`verifyClaudeRequest`, `withRetry`) → `lib/claude/client.ts` (`runClaudeTurn`) | The request is validated before it leaves. Retries cover transport failures, 429 and 5xx only. |
| 8 | Save Claude's response | `lib/validation/functionality-validator.ts` (`verifyClaudeResponse`) → `pipeline.ts` service-role insert → `verifyAssistantPersisted` | `sender_type = 'assistant'` is service-role-only, which is what stops a member forging a reply from Claude. |
| 9 | Broadcast + session bookkeeping | Postgres logical replication → `hooks/useRoomRealtime.ts`; `writeConversationState`, `recordAudit` in `pipeline.ts` | There is no fan-out call: the INSERT in step 8 *is* the broadcast. |

### Why step 9 has no code that sends anything

`messages` is in the `supabase_realtime` publication, so the row written in step
8 reaches every subscribed client through `postgres_changes` without the server
pushing anything. An explicit fan-out would double-deliver and, worse, would
bypass RLS — and RLS is exactly what filters the stream per subscriber. So step 9
is only the bookkeeping half: increment `turn_count`, add the turn's token usage,
clear `last_error`, and write `claude.response` to the audit log.

### Failure handling along the way

A shared room's worst failure mode is a silent dead end: one person watches their
message vanish while everybody else sees nothing. So a failed turn writes a
`sender_type = 'system'` row into the same realtime stream, and the whole room
gets the same explanation at the same time. Beyond that:

- `submitContribution` marks the message row's `error` and returns the failure.
- `approveAndSend` / `combineAndSend` call `revertToPending`, putting the
  contribution back in the queue. Without that it would be stranded: `approved`
  means the queue no longer offers it, but it never reached Claude — and since
  `buildClaudeRequest` treats `approved` as delivered, it would silently ride
  along on the *next* turn instead.
- Approval transitions are compare-and-set (`.eq('approval_status', 'pending')`),
  so a double-clicked button or a second tab loses with a 409 rather than sending
  the same contribution twice.

### Queued mode

In an `approval_required` room, `requiresApproval()` returns true for everyone
except the Core Prompter, the row is stored as `pending`, and the pipeline
**stops at step 3**. Nothing was sent and no session state changed. The row still
travels over realtime, so the room can see a contribution is waiting and the
Core Prompter's queue populates immediately. Steps 4–9 run later, from
`approveAndSend` or `combineAndSend`, against the approved text.

---

## Realtime data flow

One Supabase channel per room, `room:${roomId}`, owned by `ChatArea` through
`useRoomRealtime`. It carries three independent streams.

```
  Postgres                        Realtime                    Browser
  ────────                        ────────                    ───────

  INSERT/UPDATE messages ──┐
    (pipeline, composer)   ├──► postgres_changes ──────────► ingestMessage()
  INSERT/UPDATE/DELETE     │    filter: room_id=eq.<id>       └─ upsertMessage()
    room_members ──────────┘    re-checked against RLS           replaces optimistic
                                per subscriber                    rows by id, or by
                                                                  sender + exact body

                                presence (key: user_id) ────► online dots
                                  30s re-track heartbeat

                                broadcast 'typing' ─────────► TypingRow
                                  self: false, 2s throttle,     4s TTL, swept
                                  never persisted               once per second
```

Server-rendered initial state comes from the room page and is handed to the hook
as `initialMessages` / `initialMembers`; the socket only carries deltas from
there. The channel filter is `room_id=eq.<id>`, but the real protection is that
Realtime re-checks RLS per subscriber — a member only ever receives events for
rooms where they are `active`.

Four behaviours are worth calling out:

**Eviction.** A `room_members` UPDATE whose row is the current user and whose
status is no longer `active` sets `error: 'access_revoked'`, and `ChatArea`
replaces the entire column with a notice. This is the visible half of "removal
takes effect immediately"; the invisible half is that every RLS policy already
refuses them. A `revokedRef` latch means a later `CHANNEL_ERROR` or a reconnect
cannot overwrite the reason they are being ejected. `room_members` carries
`replica identity full` precisely so a DELETE event still includes `room_id` and
survives the channel filter.

**Optimistic sends.** The composer appends a row with a `temp-` id, POSTs, and
either swaps in the server's row from the response or removes it and restores the
draft on failure. The realtime INSERT that arrives afterwards is matched to the
optimistic row by sender plus exact body — which works because the composer runs
the *same* `normaliseMessage()` the server does, so both sides compare the same
string.

**Late identities.** Realtime payloads carry the raw row and no joined profile
(`messages.sender_id` references `auth.users`, not `profiles`, so PostgREST has
no relationship to embed). A message from someone the client has never seen
triggers exactly one roster refresh, guarded by an in-flight flag so a burst of
their messages does not fire a request each; an effect then backfills the names
of any messages still holding a null sender.

**Presence over polling.** Online status comes from the presence channel with a
30-second re-track, not from PATCHing `last_seen_at` on a timer — a per-client
write every 30 seconds would be a write storm for a fact the channel already
knows. (`GET .../members` still derives `is_online` from `last_seen_at` for
offline members; nothing currently writes that column, so it is always null in
practice.)

The access panel does **not** open its own subscription. `ChatArea` passes the
roster back up through `onMembersChange` so both columns render the same array —
two subscriptions to the same room would double the socket traffic and could
disagree for a frame.

---

## The two-validator design

Two independent subsystems gate step 7, and a turn only goes out when both have
approved.

- **Agent 2 — the security validator** (`lib/validation/security-validator.ts`)
  answers *"is this person allowed to do this?"*
- **Agent 1 — the functionality validator**
  (`lib/validation/functionality-validator.ts`) answers *"did that actually
  work, and is what we are about to send well formed?"*

They are separate because they fail differently. A security failure is a final
answer about a person and must be audited and refused. A functionality failure is
a statement about the world that may be transient, may deserve a retry, and
sometimes only deserves a warning attached to a successful result.

### What each one checks

| | Check | Why it is there |
| --- | --- | --- |
| **Agent 2** | 1. Authenticated (`requireUser`) | Resolved before anything else so every later denial can be attributed to a user id in the audit log. |
| | 2. Membership row exists and is `active` (`loadRoomContext`) | Collapses "no such room" and "not a member" into one 404 so room ids cannot be enumerated. |
| | 3. Room not locked / messaging not paused (send only) | `can()` covers this too, but checking first yields "the room is locked" instead of a generic denial. |
| | 4. Capability (`can(action, membership, room)`) | The single source of truth mirrored by RLS. |
| | 5. Role-escalation guard (`canChangeRole`, `canRemoveMember`) | Runs *after* the capability check so a viewer never learns whether a given member id exists. |
| | 6. Rate limit (`checkRateLimit`) | After identity, so an unauthenticated probe cannot burn a real user's quota. Send and approve share the `claudePerRoom` bucket, since both cause exactly one turn. |
| | 7. Length (`assertMessageLength` on normalised text) | Measured in code points after normalisation, matching Postgres' `char_length()` — padding cannot be used to slip past or to trip the limit. |
| | 8. Injection heuristics (`detectPromptInjection`) | Warns and audits. Never blocks. |
| **Agent 1** | `verifyMessageStored` | Independent read-back: proves the row committed instead of trusting the insert's echo, and rejects a row that landed under the wrong `room_id`. |
| | `verifyClaudeRequest` | Non-empty model and system prompt; at least one turn; first turn is `user`; no empty content block; `maxTokens` in range; serialised size under a ceiling derived from `CLAUDE_HISTORY_LIMIT × MAX_MESSAGE_LENGTH`. Non-alternating roles are an `info` issue, not a failure. |
| | `verifyClaudeResponse` | `stop_reason === 'refusal'` is checked *before* the text, because a refusal arrives with empty content and "empty response" would be a misleading diagnosis. Truncation returns the partial text with a warning. |
| | `verifyAssistantPersisted` | Confirms the reply committed, is genuinely `sender_type = 'assistant'`, and is not empty. |
| | `withRetry` / `isTransientFailure` | Transport errors, 408, 429 and 5xx only, with equal-jitter exponential backoff. |

### Why both are deterministic rather than model-driven

**They run on every single message.** A model call in either position would add a
round trip and a bill to every turn in the app, including the ones that are about
to be refused.

**Everything they check is expressible as code.** "Is this member active",
"does this role hold this capability", "did the row commit", "does the first turn
have role `user`" are facts, not judgements. A model would answer them less
reliably than a `SELECT` does.

**Non-determinism in a security gate is a bug.** The same request must produce
the same verdict every time, must be reproducible when someone disputes a denial,
and must be auditable — `security.denied` rows carry a stable `reason` code
precisely because the reason is computed, not generated. A model gate would also
be attackable through its own input, which is exactly the class of problem the
validator exists to contain.

**Using a model to check a model is circular.** Agent 1 exists to catch the case
where the Claude call misbehaved; asking Claude whether the Claude call worked
adds a second thing that can fail in the same way.

The one place where judgement genuinely cannot be reduced to rules —
"is this natural-language text trying to redirect the model?" — is deliberately
**not** treated as a gate. `detectPromptInjection` scores a dozen weighted
patterns, combines them as independent probabilities so five weak signals cannot
outrank one unambiguous *"ignore previous instructions"*, and at `score >= 0.7`
raises a warning and writes `security.prompt_injection_suspected` to the audit
log. It never blocks. Pattern matching on natural language cannot be made
complete: a gate there would reject legitimate discussion *about* prompting while
still missing any paraphrase. The real defence is structural — the framing, the
escaped delimiters and the system prompt described in `docs/SECURITY.md` — and
the heuristic's job is to make an attempt *visible* to an operator, not to decide.

---

## Request shapes at the edges

Every route handler follows the same three moves: parse the body with zod into
`ValidationIssue[]`, call one `lib/server` or `lib/validation` function, and
render the returned `ValidationResult` as `{ error, code, issues }` with its
suggested status. Nothing in a request body ever names an actor or a room — the
room comes from the path, the actor from the session cookie. `dynamic =
'force-dynamic'` is set on every route: they all read the session and write to
Postgres, so a cached response would serve one user's room to another.

`ValidationResult<T>` (`lib/types.ts`) is the shared currency: `ok`, optional
`data`, an `issues` array, and a suggested HTTP `status`. Warnings ride along on
successful results — a truncated Claude reply or a suspected injection is
returned *with* the data, not instead of it.
