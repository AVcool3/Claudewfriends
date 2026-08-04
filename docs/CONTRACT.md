# Internal contract

This file pins the module boundaries so each part of the app can be built and
reviewed independently. Anything listed here is a public surface: change it and
you change several call sites.

Import alias: `@/*` -> `src/*`. TypeScript is strict. Tailwind v4 (`@import "tailwindcss"`).

## Layer map

```
src/lib/types.ts             domain types + enums + validation result shape   (DONE)
src/lib/database.types.ts    Postgres schema mirror                           (DONE)
src/lib/permissions.ts       capability resolution, mirrored by RLS           (DONE)
src/lib/env.ts               public vs server-only env access                 (DONE)
src/lib/supabase/*.ts        browser / server / service-role clients          (DONE)
src/middleware.ts            session refresh + login redirect                 (DONE)

supabase/migrations/0001_init.sql   schema, RLS, triggers, indexes
src/lib/sanitize.ts                 input normalisation + injection heuristics
src/lib/server/audit.ts             append-only audit writer
src/lib/server/rate-limit.ts        per-user + per-room limits
src/lib/server/room-context.ts      auth + membership + capability loader
src/lib/validation/security-validator.ts        Agent 2 (permissions/API safety)
src/lib/validation/functionality-validator.ts   Agent 1 (did it actually work)
src/lib/claude/prompt.ts            structured contribution + system prompt
src/lib/claude/client.ts            Anthropic SDK wrapper
src/lib/server/pipeline.ts          the 9-step message pipeline
src/app/api/**                      route handlers
src/components/**                   React components
src/hooks/**                        client hooks (realtime, presence)
src/app/**                          pages
```

## Server modules

### `src/lib/sanitize.ts`

```ts
export function normaliseMessage(raw: string): string
export function assertMessageLength(text: string): ValidationResult<string>
/** Escapes the delimiters we use to frame untrusted text in the Claude prompt. */
export function neutraliseDelimiters(text: string): string
export interface InjectionFinding { pattern: string; excerpt: string; score: number }
export function detectPromptInjection(text: string): { score: number; findings: InjectionFinding[] }
/** score >= 0.7 is treated as suspicious and audited; it never silently blocks. */
export const INJECTION_SUSPICION_THRESHOLD = 0.7
```

### `src/lib/server/audit.ts`

```ts
export async function recordAudit(entry: {
  roomId: string | null
  actorId: string | null
  action: AuditAction
  targetId?: string | null
  metadata?: Record<string, unknown>
}): Promise<void>          // never throws; logs on failure
```

### `src/lib/server/rate-limit.ts`

```ts
export interface RateLimitVerdict { allowed: boolean; retryAfterSeconds: number; remaining: number }
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitVerdict
export const LIMITS: {
  messagePerUser: { limit: number; windowMs: number }
  claudePerRoom: { limit: number; windowMs: number }
  invitePerRoom: { limit: number; windowMs: number }
  roomCreatePerUser: { limit: number; windowMs: number }
}
```
In-memory token buckets, documented as per-instance; swap for Redis/Postgres in
a multi-instance deployment.

### `src/lib/server/room-context.ts`

```ts
export interface RoomContextResult {
  user: { id: string; email: string }
  profile: Profile
  room: Room
  member: RoomMember
  membership: MembershipContext
  roomCtx: RoomContext
  capabilities: Record<Capability, boolean>
}
export async function loadRoomContext(roomId: string): Promise<ValidationResult<RoomContextResult>>
export async function requireUser(): Promise<ValidationResult<{ id: string; email: string }>>
```

### `src/lib/validation/security-validator.ts`

```ts
export interface SecurityCheckInput {
  roomId: string
  action: Capability
  content?: string
  targetMemberId?: string
  nextRole?: Role
}
export interface SecurityContext extends RoomContextResult {
  injection: { score: number; findings: InjectionFinding[]; suspicious: boolean }
}
export async function validateSecurity(input: SecurityCheckInput): Promise<ValidationResult<SecurityContext>>
```
Order: authenticated -> membership row exists and is `active` -> room not locked
(for send) -> capability -> role-escalation guard -> rate limit -> length ->
injection heuristics. Every denial writes `security.denied` to the audit log.

### `src/lib/validation/functionality-validator.ts`

```ts
export interface StoredMessageCheck { messageId: string; roomId: string }
export async function verifyMessageStored(check: StoredMessageCheck): Promise<ValidationResult<Message>>
export function verifyClaudeRequest(request: ClaudeRequestShape): ValidationResult<ClaudeRequestShape>
export function verifyClaudeResponse(text: string, stopReason: string | null): ValidationResult<string>
export async function verifyAssistantPersisted(messageId: string): Promise<ValidationResult<Message>>
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; baseDelayMs?: number; retryable?: (e: unknown) => boolean },
): Promise<T>
```

### `src/lib/claude/prompt.ts`

```ts
export interface ContributionInput {
  corePrompterName: string
  senderName: string
  senderRole: Role
  senderEmail: string
  content: string
  roomName: string
  approvedBy?: string | null
  edited?: boolean
}
/** The `Primary user: ... Conversation participant: ...` block. */
export function buildStructuredContribution(input: ContributionInput): string
export function buildSystemPrompt(args: {
  roomName: string
  corePrompterName: string
  participants: { name: string; role: Role }[]
}): string
export interface ClaudeRequestShape {
  model: string
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens: number
}
export function buildClaudeRequest(args: {
  system: string
  history: MessageWithSender[]
  corePrompterName: string
  roomName: string
}): ClaudeRequestShape
```

Collaborator turns are always wrapped; Claude turns replay as `assistant`. The
Core Prompter's own turns are wrapped too, labelled as the primary user, so the
transcript never mixes framed and unframed user text.

### `src/lib/claude/client.ts`

```ts
export interface ClaudeTurnResult {
  text: string
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  model: string
}
export async function runClaudeTurn(request: ClaudeRequestShape): Promise<ClaudeTurnResult>
```
Uses `@anthropic-ai/sdk`, model `claude-opus-5`, `thinking: { type: 'adaptive' }`,
`output_config: { effort }`, and `client.messages.stream(...).finalMessage()`.
Never sets `temperature`/`top_p`/`top_k` (rejected on this model). Handles
`stop_reason === 'refusal'` before reading content.

### `src/lib/server/pipeline.ts`

```ts
export interface SubmitResult {
  message: Message
  queued: boolean
  assistantMessage: Message | null
  warnings: ValidationIssue[]
}
export async function submitContribution(args: {
  roomId: string
  content: string
}): Promise<ValidationResult<SubmitResult>>
export async function approveAndSend(args: {
  roomId: string
  messageId: string
  editedContent?: string
}): Promise<ValidationResult<SubmitResult>>
export async function combineAndSend(args: {
  roomId: string
  messageIds: string[]
  content?: string
}): Promise<ValidationResult<SubmitResult>>
export async function rejectContribution(args: {
  roomId: string
  messageId: string
  reason?: string
}): Promise<ValidationResult<Message>>
```

## HTTP API

All responses are JSON. Failures use `{ error, code?, issues? }` with the status
from the `ValidationResult`.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/rooms` | `{ name, collaboration_mode? }` | creates room + owner membership + claude session |
| PATCH | `/api/rooms/[roomId]` | `{ name?, collaboration_mode?, is_locked?, allow_collaborator_messages? }` | |
| DELETE | `/api/rooms/[roomId]` | – | Core Prompter only |
| GET | `/api/rooms/[roomId]/members` | – | `{ members: RoomMemberWithProfile[], invitations: InvitationSummary[] }` |
| POST | `/api/rooms/[roomId]/members` | `{ email, role }` | creates invitation, returns `invite_url` |
| PATCH | `/api/rooms/[roomId]/members/[memberId]` | `{ role }` | |
| DELETE | `/api/rooms/[roomId]/members/[memberId]` | `?ban=1` optional | |
| POST | `/api/rooms/[roomId]/messages` | `{ content }` | runs the full pipeline |
| POST | `/api/rooms/[roomId]/messages/[messageId]/approve` | `{ content? }` | |
| POST | `/api/rooms/[roomId]/messages/[messageId]/reject` | `{ reason? }` | |
| POST | `/api/rooms/[roomId]/messages/combine` | `{ messageIds, content? }` | |
| POST | `/api/invitations/accept` | `{ token }` | `{ room_id }` |

## Client surface

### `src/hooks/useRoomRealtime.ts`

```ts
export interface RoomRealtimeState {
  messages: MessageWithSender[]
  members: RoomMemberWithProfile[]
  typing: TypingIndicator[]
  connection: 'connecting' | 'connected' | 'error'
  error: string | null
}
export function useRoomRealtime(args: {
  roomId: string
  currentUserId: string
  currentUserName: string
  initialMessages: MessageWithSender[]
  initialMembers: RoomMemberWithProfile[]
}): RoomRealtimeState & {
  broadcastTyping: () => void
  /** Optimistically append; replaced when the realtime INSERT lands. */
  addOptimistic: (message: MessageWithSender) => void
  removeOptimistic: (id: string) => void
  refreshMembers: () => Promise<void>
}
```
`postgres_changes` on `messages` and `room_members` filtered by `room_id`, plus a
presence channel for online status and a broadcast channel for typing. When the
current user's membership row flips away from `active`, the hook sets
`error: 'access_revoked'` so the page can eject them immediately.

### UI primitives — `src/components/ui/`

```
Avatar.tsx    <Avatar name={string} src?={string|null} size?={'sm'|'md'|'lg'} />
Button.tsx    <Button variant?={'primary'|'secondary'|'ghost'|'danger'} size?={'sm'|'md'} loading?={boolean} ...ButtonHTMLAttributes />
Modal.tsx     <Modal open title onClose footer?>{children}</Modal>
Spinner.tsx   <Spinner size?={'sm'|'md'} label?={string} />
Banner.tsx    <Banner tone={'error'|'warning'|'info'|'success'} title? onDismiss?>{children}</Banner>
Badge.tsx     <Badge tone={'core'|'admin'|'collab'|'viewer'|'neutral'}>{children}</Badge>
Field.tsx     <Field label htmlFor hint? error?>{children}</Field> and <TextInput/>, <Select/>, <Textarea/>
```
All are client components, styled with Tailwind utility classes, dark UI
(`bg-neutral-950` shell, `bg-neutral-900` panels, `border-neutral-800`).

### Feature components

```
src/components/sidebar/Sidebar.tsx        <Sidebar rooms currentRoomId profile />
src/components/sidebar/RoomList.tsx
src/components/sidebar/CreateRoomDialog.tsx
src/components/sidebar/ProfileCard.tsx
src/components/sidebar/RoomSettings.tsx   <RoomSettings room capabilities />
src/components/chat/ChatArea.tsx          the whole centre column (client)
src/components/chat/MessageList.tsx
src/components/chat/MessageBubble.tsx
src/components/chat/Composer.tsx
src/components/chat/TypingRow.tsx
src/components/chat/PendingQueue.tsx
src/components/access/AccessPanel.tsx     <AccessPanel roomId members capabilities currentUserId ownerId isLocked />
src/components/access/MemberRow.tsx
src/components/access/InviteDialog.tsx
```

`ChatArea` owns the realtime hook and passes state down. `AccessPanel` receives
members from the same hook via the room page so both columns stay in sync.

## Page composition

```
src/app/layout.tsx                 html/body + globals.css
src/app/page.tsx                   redirect -> /rooms
src/app/login/page.tsx             password + magic link
src/app/auth/callback/route.ts     exchanges the code, then redirects
src/app/auth/signout/route.ts      POST -> signOut -> /login
src/app/invite/[token]/page.tsx    shows the invite, accepts it, redirects
src/app/rooms/page.tsx             sidebar + empty state
src/app/rooms/[roomId]/page.tsx    three-column shell, server-fetches initial data
src/app/rooms/layout.tsx           holds the sidebar so it persists across rooms
```
