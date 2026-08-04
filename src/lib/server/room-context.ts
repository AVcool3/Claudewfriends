/**
 * Auth + membership + capability loader.
 *
 * Every server entry point that touches a room starts here. The room, the
 * caller's membership row and the caller's profile are all read with the
 * *user-scoped* client so Row Level Security actually runs: this function
 * proves the caller's access rather than asserting it. The service-role client
 * is never used for these reads — doing so would move the enforcement boundary
 * out of the database and into this file.
 */

import { createServerSupabase } from '@/lib/supabase/server'
import {
  capabilitySet,
  denialReason,
  membershipContext,
  roomContext,
} from '@/lib/permissions'
import type { Capability, MembershipContext, RoomContext } from '@/lib/permissions'
import { validationFailure, validationSuccess } from '@/lib/types'
import type { Profile, Room, RoomMember, ValidationResult } from '@/lib/types'

export interface RoomContextResult {
  user: { id: string; email: string }
  profile: Profile
  room: Room
  member: RoomMember
  membership: MembershipContext
  roomCtx: RoomContext
  capabilities: Record<Capability, boolean>
}

/**
 * Shape check only — deliberately not version- or variant-specific, since the
 * job here is to stop a malformed id from reaching Postgres' uuid parser, not
 * to police which UUID version the database happens to mint.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * The single message used for "no such room" and "you are not a member of this
 * room". Both must be indistinguishable from outside, otherwise iterating room
 * ids tells an attacker which ones exist.
 */
const ROOM_NOT_FOUND = 'That room does not exist, or you do not have access to it.'

export async function requireUser(): Promise<ValidationResult<{ id: string; email: string }>> {
  const supabase = await createServerSupabase()
  // `getUser()` re-validates the JWT with Supabase. `getSession()` would trust
  // whatever is in the cookie, which is forgeable.
  const { data, error } = await supabase.auth.getUser()

  if (error || !data.user) {
    return validationFailure('auth.required', 'You must be signed in to do that.', 401)
  }

  return validationSuccess({ id: data.user.id, email: data.user.email ?? '' })
}

export async function loadRoomContext(roomId: string): Promise<ValidationResult<RoomContextResult>> {
  const auth = await requireUser()
  if (!auth.ok || !auth.data) {
    return { ok: false, issues: auth.issues, status: auth.status }
  }
  const user = auth.data

  // Postgres raises `22P02 invalid input syntax for type uuid` on a malformed
  // id, which would surface as a 500. This is a client bug, not an access
  // question, so it gets its own status and does not use the shared 404 text.
  if (!isUuid(roomId)) {
    return validationFailure('room.invalid_id', 'That room id is not valid.', 400)
  }

  const supabase = await createServerSupabase()

  // The three reads are independent, so they go out together — this is on the
  // hot path for every room render.
  //
  // The explicit row type on `maybeSingle<T>()` is not decoration: postgrest-js
  // 2.112 requires every table in the schema mirror to declare a
  // `Relationships` key, and `database.types.ts` does not, so the inferred row
  // type collapses to `never`. Naming the type restores checking here; fixing
  // `database.types.ts` would let these be inferred again.
  const [roomResponse, memberResponse, profileResponse] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).maybeSingle<Room>(),
    supabase
      .from('room_members')
      .select('*')
      .eq('room_id', roomId)
      .eq('user_id', user.id)
      .maybeSingle<RoomMember>(),
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle<Profile>(),
  ])

  if (roomResponse.error || memberResponse.error || profileResponse.error) {
    const message =
      roomResponse.error?.message ?? memberResponse.error?.message ?? profileResponse.error?.message
    console.error('[room-context] load failed', { roomId, message })
    return validationFailure('room.load_failed', 'Could not load this room right now.', 500)
  }

  const { data: room } = roomResponse
  const { data: member } = memberResponse

  // RLS returns nothing for a room that does not exist AND for a room the
  // caller cannot see, so these two cases are already indistinguishable at the
  // data layer. Collapsing them here keeps them indistinguishable at the API.
  if (!room || !member) {
    return validationFailure('room.not_found', ROOM_NOT_FOUND, 404)
  }

  const membership = membershipContext(member, room)
  const roomCtx = roomContext(room)

  // A membership row that is visible but not `active` is a different situation:
  // the caller demonstrably belongs to the room's history, so telling them why
  // they are locked out leaks nothing and is the only way "you were removed"
  // can be shown in the UI.
  if (member.status !== 'active') {
    return validationFailure(
      `membership.${member.status}`,
      denialReason('room.view', membership, roomCtx),
      403,
    )
  }

  const { data: profile } = profileResponse
  if (!profile) {
    // The signup trigger creates this row; its absence means the account is in
    // a half-provisioned state that we must not paper over with a placeholder,
    // because the placeholder would then be shown to other members as a name.
    console.error('[room-context] profile row missing', { userId: user.id })
    return validationFailure('profile.missing', 'Your profile is not set up yet.', 500)
  }

  return validationSuccess({
    user,
    profile,
    room,
    member,
    membership,
    roomCtx,
    capabilities: capabilitySet(membership, roomCtx),
  })
}
