import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'

import Sidebar, { type RoomSummary } from '@/components/sidebar/Sidebar'
import Banner from '@/components/ui/Banner'
import { createServerSupabase, getSessionUser } from '@/lib/supabase/server'
import type { Profile, Room, RoomMember } from '@/lib/types'

/** The two columns the member tally needs; selecting the whole row is waste. */
type RosterRow = Pick<RoomMember, 'room_id' | 'user_id'>

/**
 * The application shell: a fixed-height flex row that never scrolls itself, so
 * the sidebar, the transcript and the access column each own their own
 * scrollbar. `h-dvh` rather than `h-screen` because mobile browsers shrink the
 * viewport when the address bar collapses.
 */
function Shell({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh overflow-hidden bg-neutral-950">{children}</div>
}

/**
 * Stands in for the room list when its read fails. The column keeps its width so
 * the room already on screen does not jump, and the failure is stated instead of
 * being rendered as "you have no rooms", which would be a lie.
 */
function SidebarUnavailable() {
  return (
    <aside
      aria-label="Rooms"
      className="flex h-full w-72 shrink-0 flex-col gap-3 border-r border-neutral-800 bg-neutral-900 p-4"
    >
      <p className="text-sm font-semibold text-neutral-100">Collaborative Claude</p>
      <Banner tone="error" title="Room list unavailable">
        Your rooms could not be loaded. Anything already open still works — reload the page to try
        again.
      </Banner>
    </aside>
  )
}

export default async function RoomsLayout({ children }: { children: ReactNode }) {
  // The middleware already bounces anonymous traffic, but a session can expire
  // between that check and this render and every query below assumes a caller.
  const user = await getSessionUser()
  if (!user) redirect('/login')

  // User-scoped client throughout: these reads are exactly the ones RLS is
  // written to constrain, so proving access here is the point rather than a
  // formality. The service-role client would return every room in the database.
  const supabase = await createServerSupabase()

  // Explicit row types on `returns`/`maybeSingle`: postgrest-js cannot infer them
  // from `database.types.ts` (no `Relationships` key), and the inferred type
  // collapses to `never`. See the note in `src/lib/server/room-context.ts`.
  const [profileResponse, membershipResponse] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle<Profile>(),
    supabase
      .from('room_members')
      .select('*')
      .eq('user_id', user.id)
      // Only active memberships are rooms: an invited row has not been accepted,
      // and removed/banned rows are history the sidebar must not offer to open.
      .eq('status', 'active')
      .returns<RoomMember[]>(),
  ])

  const profile = profileResponse.data
  if (profileResponse.error || !profile) {
    // The signup trigger writes this row. Its absence is a half-provisioned
    // account, and every child page depends on it, so say so rather than render
    // a shell with a nameless user in it.
    console.error('[rooms/layout] profile read failed', {
      userId: user.id,
      message: profileResponse.error?.message,
    })
    return (
      <main className="flex h-dvh items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6">
          <h1 className="text-lg font-semibold text-neutral-100">Your profile is not set up yet</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-400">
            Your account exists but its profile row is missing, so rooms cannot be loaded. Sign out
            and back in — if this persists, an administrator needs to look at the account.
          </p>
        </div>
      </main>
    )
  }

  const memberships = membershipResponse.data ?? []
  const roomIds = [...new Set(memberships.map((membership) => membership.room_id))]

  if (membershipResponse.error) {
    console.error('[rooms/layout] membership read failed', {
      userId: user.id,
      message: membershipResponse.error.message,
    })
    return (
      <Shell>
        <SidebarUnavailable />
        {children}
      </Shell>
    )
  }

  // The rooms and the roster tally both key off the id list above, so they can
  // only be issued once it has resolved — hence the second wave rather than one
  // big Promise.all.
  const [roomsResponse, rosterResponse] =
    roomIds.length === 0
      ? [
          { data: [] as Room[], error: null },
          { data: [] as RosterRow[], error: null },
        ]
      : await Promise.all([
          supabase
            .from('rooms')
            .select('*')
            .in('id', roomIds)
            .order('created_at', { ascending: false })
            .returns<Room[]>(),
          supabase
            .from('room_members')
            .select('room_id, user_id')
            .in('room_id', roomIds)
            .eq('status', 'active')
            .returns<RosterRow[]>(),
        ])

  if (roomsResponse.error) {
    console.error('[rooms/layout] room read failed', {
      userId: user.id,
      message: roomsResponse.error.message,
    })
    return (
      <Shell>
        <SidebarUnavailable />
        {children}
      </Shell>
    )
  }

  const rooms = roomsResponse.data ?? []

  // Counted client-side from one roster read rather than a `count` query per
  // room: N round trips for a number rendered in a 288px column is not a trade
  // worth making. A failed roster read degrades to the rows we already hold —
  // the viewer's own memberships — so each room reports at least one member.
  if (rosterResponse.error) {
    console.error('[rooms/layout] roster read failed', {
      userId: user.id,
      message: rosterResponse.error.message,
    })
  }
  const rosterRows: RosterRow[] = rosterResponse.data ?? memberships
  const memberCounts = new Map<string, number>()
  for (const row of rosterRows) {
    memberCounts.set(row.room_id, (memberCounts.get(row.room_id) ?? 0) + 1)
  }

  const roleByRoom = new Map(memberships.map((membership) => [membership.room_id, membership.role]))

  const ownerIds = [...new Set(rooms.map((room) => room.owner_id))]
  const ownersResponse =
    ownerIds.length === 0
      ? { data: [] as Profile[], error: null }
      : await supabase.from('profiles').select('*').in('id', ownerIds).returns<Profile[]>()

  if (ownersResponse.error) {
    // Non-fatal: the room list is still navigable without the owner's name.
    console.error('[rooms/layout] owner profile read failed', {
      message: ownersResponse.error.message,
    })
  }
  const ownerNames = new Map((ownersResponse.data ?? []).map((owner) => [owner.id, owner.display_name]))

  const summaries: RoomSummary[] = rooms.flatMap((room) => {
    const role = roleByRoom.get(room.id)
    // A room with no membership row for this viewer cannot happen (the ids came
    // from that very list), but the map lookup is optional and `role` is not.
    if (!role) return []
    return [
      {
        room,
        role,
        ownerName:
          ownerNames.get(room.owner_id) ??
          (room.owner_id === user.id ? profile.display_name : 'Unknown'),
        memberCount: memberCounts.get(room.id) ?? 1,
      },
    ]
  })

  return (
    <Shell>
      {/*
       * `currentRoomId` is null by construction: this layout sits above the
       * `[roomId]` segment, and a Next.js layout only receives params from its
       * own segment and the ones above it. The open room is therefore identified
       * in the centre column's header, and the room's settings panel is rendered
       * by RoomWorkspace instead of by the sidebar's own branch for it.
       */}
      <Sidebar rooms={summaries} currentRoomId={null} profile={profile} />
      {children}
    </Shell>
  )
}
