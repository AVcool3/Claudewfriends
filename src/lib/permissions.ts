/**
 * The single source of truth for "who may do what".
 *
 * Every capability here is mirrored by a Row Level Security policy or a
 * `SECURITY DEFINER` helper in `supabase/migrations/0001_init.sql`. The
 * functions in this file are used by the server to produce good error
 * messages and by the UI to hide controls — they are a convenience layer, not
 * the enforcement boundary. The database is the enforcement boundary.
 */

import type { CollaborationMode, MemberStatus, Role, Room, RoomMember } from './types'

export type Capability =
  | 'room.view'
  | 'room.send_message'
  | 'room.invite'
  | 'room.remove_member'
  | 'room.change_role'
  | 'room.lock'
  | 'room.delete'
  | 'room.change_mode'
  | 'room.toggle_messaging'
  | 'room.approve_message'
  | 'room.configure_claude'
  | 'room.connect_repo'
  | 'room.repo_read'
  | 'room.repo_write'

const ROLE_RANK: Record<Role, number> = {
  core_prompter: 3,
  administrator: 2,
  collaborator: 1,
  viewer: 0,
}

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

/** The membership facts a capability check needs. */
export interface MembershipContext {
  role: Role
  status: MemberStatus
  isOwner: boolean
}

/** The room facts a capability check needs. */
export interface RoomContext {
  isLocked: boolean
  collaborationMode: CollaborationMode
  allowCollaboratorMessages: boolean
}

export function membershipContext(member: RoomMember, room: Pick<Room, 'owner_id'>): MembershipContext {
  return {
    role: member.role,
    status: member.status,
    isOwner: member.user_id === room.owner_id,
  }
}

export function roomContext(room: Room): RoomContext {
  return {
    isLocked: room.is_locked,
    collaborationMode: room.collaboration_mode,
    allowCollaboratorMessages: room.allow_collaborator_messages,
  }
}

/**
 * Resolve a capability.
 *
 * `status` gates everything: a removed or banned member has no capabilities at
 * all, which is what makes "removal takes effect immediately" true.
 */
export function can(
  capability: Capability,
  membership: MembershipContext,
  room: RoomContext,
): boolean {
  if (membership.status !== 'active') return false

  const isCore = membership.role === 'core_prompter'
  const isAdmin = membership.role === 'administrator'

  switch (capability) {
    case 'room.view':
      return true

    case 'room.send_message': {
      if (membership.role === 'viewer') return false
      if (isCore) return true
      // A locked room freezes every contribution except the owner's.
      if (room.isLocked) return false
      if (!room.allowCollaboratorMessages) return false
      return true
    }

    case 'room.invite':
    case 'room.remove_member':
    case 'room.change_role':
      return isCore || isAdmin

    case 'room.lock':
    case 'room.change_mode':
    case 'room.toggle_messaging':
    case 'room.approve_message':
      // Administrators manage "most room settings" but the Core Prompter alone
      // controls the Claude session's gate.
      if (capability === 'room.approve_message') return isCore
      if (capability === 'room.lock') return isCore || isAdmin
      return isCore

    case 'room.delete':
    case 'room.configure_claude':
      return isCore

    // Connecting a repository binds someone else's GitHub installation to this
    // room, so it is the owner's decision alone — an administrator manages
    // people, not the code the room can reach.
    case 'room.connect_repo':
      return isCore

    // Reading follows the ability to contribute: whoever can put a message in
    // front of Claude can cause it to look at the repository, so gating reads
    // any tighter would be theatre.
    case 'room.repo_read':
      return can('room.send_message', membership, room)

    /*
     * Writes are the Core Prompter's alone, in every collaboration mode.
     *
     * A collaborator's text reaches Claude as data, but it still steers what
     * Claude decides to do. If a collaborator could cause a pull request, a
     * successful prompt injection would end in a branch pushed to the owner's
     * repository. Approval mode does not close that gap either — it gates which
     * *messages* reach Claude, not what Claude does once one has.
     */
    case 'room.repo_write':
      return isCore

    default:
      return false
  }
}

/** Explains a denial in a sentence suitable for surfacing to the user. */
export function denialReason(
  capability: Capability,
  membership: MembershipContext,
  room: RoomContext,
): string {
  if (membership.status === 'banned') return 'You have been banned from this room.'
  if (membership.status === 'removed') return 'Your access to this room was removed.'
  if (membership.status === 'invited') return 'You have not accepted the invitation to this room yet.'

  if (capability === 'room.send_message') {
    if (membership.role === 'viewer') return 'Viewers can read the conversation but cannot send messages.'
    if (room.isLocked) return 'The Core Prompter has locked this room.'
    if (!room.allowCollaboratorMessages) {
      return 'The Core Prompter has paused collaborator messages.'
    }
  }

  if (capability === 'room.connect_repo') {
    return 'Only the Core Prompter can connect or change this room\'s repository.'
  }
  if (capability === 'room.repo_write') {
    return 'Only the Core Prompter can open pull requests from this room.'
  }

  return 'You do not have permission to perform this action.'
}

/**
 * Whether a message from this member needs Core Prompter approval before it
 * reaches Claude. The Core Prompter's own messages never queue.
 */
export function requiresApproval(membership: MembershipContext, room: RoomContext): boolean {
  if (membership.role === 'core_prompter') return false
  return room.collaborationMode === 'approval_required'
}

/**
 * Guards role changes. Nobody may create or displace a Core Prompter through
 * the members API, and an administrator may not touch another administrator's
 * role or the owner's.
 */
export function canChangeRole(
  actor: MembershipContext,
  target: MembershipContext,
  nextRole: Role,
): { allowed: boolean; reason?: string } {
  if (!can('room.change_role', actor, {
    isLocked: false,
    collaborationMode: 'open',
    allowCollaboratorMessages: true,
  })) {
    return { allowed: false, reason: 'You do not have permission to change roles in this room.' }
  }
  if (nextRole === 'core_prompter') {
    return { allowed: false, reason: 'The Core Prompter role cannot be assigned or transferred here.' }
  }
  if (target.isOwner || target.role === 'core_prompter') {
    return { allowed: false, reason: 'The Core Prompter cannot be demoted.' }
  }
  if (actor.role === 'administrator' && target.role === 'administrator') {
    return { allowed: false, reason: 'Administrators cannot change another administrator\'s role.' }
  }
  return { allowed: true }
}

/** Guards removals with the same shape as `canChangeRole`. */
export function canRemoveMember(
  actor: MembershipContext,
  target: MembershipContext,
): { allowed: boolean; reason?: string } {
  if (!can('room.remove_member', actor, {
    isLocked: false,
    collaborationMode: 'open',
    allowCollaboratorMessages: true,
  })) {
    return { allowed: false, reason: 'You do not have permission to remove members from this room.' }
  }
  if (target.isOwner || target.role === 'core_prompter') {
    return { allowed: false, reason: 'The Core Prompter cannot be removed from their own room.' }
  }
  if (actor.role === 'administrator' && target.role === 'administrator') {
    return { allowed: false, reason: 'Administrators cannot remove another administrator.' }
  }
  return { allowed: true }
}

/** Every capability resolved at once — handy for seeding the client UI. */
export function capabilitySet(
  membership: MembershipContext,
  room: RoomContext,
): Record<Capability, boolean> {
  const capabilities: Capability[] = [
    'room.view',
    'room.send_message',
    'room.invite',
    'room.remove_member',
    'room.change_role',
    'room.lock',
    'room.delete',
    'room.change_mode',
    'room.toggle_messaging',
    'room.approve_message',
    'room.configure_claude',
    'room.connect_repo',
    'room.repo_read',
    'room.repo_write',
  ]
  return capabilities.reduce(
    (acc, capability) => {
      acc[capability] = can(capability, membership, room)
      return acc
    },
    {} as Record<Capability, boolean>,
  )
}
