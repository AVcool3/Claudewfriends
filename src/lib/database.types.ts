/**
 * Hand-maintained mirror of the Postgres schema in
 * `supabase/migrations/0001_init.sql`. Regenerate with
 * `supabase gen types typescript --local` once you have the CLI wired up; the
 * shape below is the contract the rest of the app codes against.
 */

import type {
  ApprovalStatus,
  AuditAction,
  ClaudeConversationState,
  CollaborationMode,
  MemberStatus,
  Role,
  SenderType,
} from './types'

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          display_name: string
          avatar_url: string | null
          created_at: string
        }
        Insert: {
          id: string
          email: string
          display_name: string
          avatar_url?: string | null
          created_at?: string
        }
        Update: {
          email?: string
          display_name?: string
          avatar_url?: string | null
        }
      }
      rooms: {
        Row: {
          id: string
          name: string
          owner_id: string
          collaboration_mode: CollaborationMode
          is_locked: boolean
          allow_collaborator_messages: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          owner_id: string
          collaboration_mode?: CollaborationMode
          is_locked?: boolean
          allow_collaborator_messages?: boolean
        }
        Update: {
          name?: string
          collaboration_mode?: CollaborationMode
          is_locked?: boolean
          allow_collaborator_messages?: boolean
          updated_at?: string
        }
      }
      room_members: {
        Row: {
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
        Insert: {
          id?: string
          room_id: string
          user_id: string
          role?: Role
          status?: MemberStatus
          invited_by?: string | null
          joined_at?: string | null
          last_seen_at?: string | null
        }
        Update: {
          role?: Role
          status?: MemberStatus
          joined_at?: string | null
          last_seen_at?: string | null
        }
      }
      invitations: {
        Row: {
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
        Insert: {
          id?: string
          room_id: string
          email: string
          role?: Role
          token: string
          expires_at: string
          invited_by: string
        }
        Update: {
          accepted_at?: string | null
          revoked_at?: string | null
          role?: Role
          expires_at?: string
        }
      }
      messages: {
        Row: {
          id: string
          room_id: string
          sender_id: string | null
          sender_type: SenderType
          original_content: string
          processed_content: string | null
          approval_status: ApprovalStatus
          approved_by: string | null
          approved_at: string | null
          edited_content: string | null
          error: string | null
          created_at: string
        }
        Insert: {
          id?: string
          room_id: string
          sender_id?: string | null
          sender_type: SenderType
          original_content: string
          processed_content?: string | null
          approval_status?: ApprovalStatus
          approved_by?: string | null
          approved_at?: string | null
          edited_content?: string | null
          error?: string | null
        }
        Update: {
          processed_content?: string | null
          approval_status?: ApprovalStatus
          approved_by?: string | null
          approved_at?: string | null
          edited_content?: string | null
          error?: string | null
        }
      }
      claude_sessions: {
        Row: {
          id: string
          room_id: string
          owner_id: string
          conversation_state: ClaudeConversationState
          model: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          room_id: string
          owner_id: string
          conversation_state?: ClaudeConversationState
          model?: string
        }
        Update: {
          conversation_state?: ClaudeConversationState
          model?: string
          updated_at?: string
        }
      }
      audit_logs: {
        Row: {
          id: string
          room_id: string | null
          actor_id: string | null
          action: AuditAction
          target_id: string | null
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          room_id?: string | null
          actor_id?: string | null
          action: AuditAction
          target_id?: string | null
          metadata?: Json
        }
        Update: never
      }
    }
    Views: Record<string, never>
    Functions: {
      /** Returns the caller's active role in a room, or null. Used by RLS. */
      current_member_role: {
        Args: { p_room_id: string }
        Returns: Role | null
      }
      /** True when the caller has an `active` membership row for the room. */
      is_active_member: {
        Args: { p_room_id: string }
        Returns: boolean
      }
      /** True when the caller owns the room. */
      is_room_owner: {
        Args: { p_room_id: string }
        Returns: boolean
      }
      /** True when the caller is the owner or an active administrator. */
      is_room_admin: {
        Args: { p_room_id: string }
        Returns: boolean
      }
      /** Atomically redeems an invitation for the calling user. */
      accept_invitation: {
        Args: { p_token: string }
        Returns: { room_id: string; role: Role }[]
      }
    }
    Enums: {
      room_role: Role
      member_status: MemberStatus
      collaboration_mode: CollaborationMode
      sender_type: SenderType
      approval_status: ApprovalStatus
    }
  }
}
