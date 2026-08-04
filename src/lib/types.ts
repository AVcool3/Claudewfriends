/**
 * Domain types shared by the database layer, the server actions, the API
 * routes and the React components. The string unions here mirror the Postgres
 * enums declared in `supabase/migrations/0001_init.sql` exactly.
 */

export const ROLES = ['core_prompter', 'administrator', 'collaborator', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const MEMBER_STATUSES = ['invited', 'active', 'removed', 'banned'] as const
export type MemberStatus = (typeof MEMBER_STATUSES)[number]

export const COLLABORATION_MODES = ['open', 'approval_required'] as const
export type CollaborationMode = (typeof COLLABORATION_MODES)[number]

export const SENDER_TYPES = ['core_prompter', 'collaborator', 'assistant', 'system'] as const
export type SenderType = (typeof SENDER_TYPES)[number]

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'sent'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** Human readable labels used across the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  core_prompter: 'Core Prompter',
  administrator: 'Administrator',
  collaborator: 'Collaborator',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  core_prompter: 'Owns the room and the Claude session. Full control.',
  administrator: 'Can invite and remove collaborators and manage most settings.',
  collaborator: 'Can read the conversation and contribute messages.',
  viewer: 'Read-only access to the conversation.',
}

/** Roles an owner/admin is allowed to hand out. `core_prompter` is not assignable. */
export const ASSIGNABLE_ROLES: Role[] = ['administrator', 'collaborator', 'viewer']

export interface Profile {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  created_at: string
}

export interface Room {
  id: string
  name: string
  owner_id: string
  collaboration_mode: CollaborationMode
  is_locked: boolean
  allow_collaborator_messages: boolean
  created_at: string
  updated_at: string
}

export interface RoomMember {
  id: string
  room_id: string
  user_id: string
  role: Role
  status: MemberStatus
  invited_by: string | null
  joined_at: string | null
  created_at: string
  last_seen_at: string | null
}

/** A membership row joined with the member's profile, as rendered in the access panel. */
export interface RoomMemberWithProfile extends RoomMember {
  profile: Profile | null
  is_online: boolean
}

export interface Invitation {
  id: string
  room_id: string
  email: string
  role: Role
  token: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  invited_by: string
  created_at: string
}

/** Invitation shape safe to return to an administrator (token withheld). */
export type InvitationSummary = Omit<Invitation, 'token'> & { invite_url?: string }

export interface Message {
  id: string
  room_id: string
  sender_id: string | null
  sender_type: SenderType
  original_content: string
  /** The structured contribution actually handed to Claude. Null for Claude's own turns. */
  processed_content: string | null
  approval_status: ApprovalStatus
  approved_by: string | null
  approved_at: string | null
  /** Set when a Core Prompter edits a pending contribution before approving it. */
  edited_content: string | null
  error: string | null
  created_at: string
}

export interface MessageWithSender extends Message {
  sender: Profile | null
  sender_role: Role | null
}

export interface ClaudeSession {
  id: string
  room_id: string
  owner_id: string
  conversation_state: ClaudeConversationState
  model: string
  created_at: string
  updated_at: string
}

/** Bookkeeping we keep alongside the room's Claude session. */
export interface ClaudeConversationState {
  turn_count: number
  last_message_id: string | null
  total_input_tokens: number
  total_output_tokens: number
  last_error: string | null
}

export interface AuditLog {
  id: string
  room_id: string | null
  actor_id: string | null
  action: AuditAction
  target_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export const AUDIT_ACTIONS = [
  'room.created',
  'room.deleted',
  'room.locked',
  'room.unlocked',
  'room.mode_changed',
  'room.messaging_toggled',
  'member.invited',
  'member.joined',
  'member.removed',
  'member.banned',
  'member.role_changed',
  'invitation.revoked',
  'message.sent',
  'message.approved',
  'message.rejected',
  'message.edited',
  'claude.request',
  'claude.response',
  'claude.error',
  'security.denied',
  'security.prompt_injection_suspected',
  'security.rate_limited',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export interface TypingIndicator {
  user_id: string
  display_name: string
  at: number
}

// ---------------------------------------------------------------------------
// Validation contracts — shared by the two validator subsystems.
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'info' | 'warning' | 'critical'

export interface ValidationIssue {
  code: string
  message: string
  severity: ValidationSeverity
}

export interface ValidationResult<T = undefined> {
  ok: boolean
  /** Present when `ok` is true. */
  data?: T
  issues: ValidationIssue[]
  /** Suggested HTTP status when `ok` is false. */
  status?: number
}

export function validationFailure(
  code: string,
  message: string,
  status = 400,
  severity: ValidationSeverity = 'critical',
): ValidationResult<never> {
  return { ok: false, issues: [{ code, message, severity }], status }
}

export function validationSuccess<T>(data: T, issues: ValidationIssue[] = []): ValidationResult<T> {
  return { ok: true, data, issues }
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string
  code?: string
  issues?: ValidationIssue[]
}

export const MAX_MESSAGE_LENGTH = 8000
export const MAX_ROOM_NAME_LENGTH = 80
export const MAX_DISPLAY_NAME_LENGTH = 60
/** Number of prior messages replayed to Claude on each turn. */
export const CLAUDE_HISTORY_LIMIT = 60
