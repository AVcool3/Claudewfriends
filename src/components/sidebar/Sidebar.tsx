'use client'

import { useMemo, useState } from 'react'
import CreateRoomDialog from '@/components/sidebar/CreateRoomDialog'
import ProfileCard from '@/components/sidebar/ProfileCard'
import RoomList, { type RoomSummary } from '@/components/sidebar/RoomList'
import RoomSettings from '@/components/sidebar/RoomSettings'
import Button from '@/components/ui/Button'
import { capabilitySet, roomContext, type MembershipContext } from '@/lib/permissions'
import type { Profile } from '@/lib/types'

export type { RoomSummary }

export interface SidebarProps {
  rooms: RoomSummary[]
  currentRoomId: string | null
  profile: Profile
}

export function Sidebar({ rooms, currentRoomId, profile }: SidebarProps) {
  const [creating, setCreating] = useState(false)

  const current = useMemo(
    () => rooms.find((entry) => entry.room.id === currentRoomId) ?? null,
    [rooms, currentRoomId],
  )

  /*
   * The sidebar lives in the rooms *layout*, so it is not re-rendered by the
   * room page and never receives that page's server-resolved capability set. It
   * re-derives one from the same pure rules in @/lib/permissions using facts it
   * already has: the viewer's role in the room and the room's own flags. This
   * only decides which controls are worth rendering — RLS and the route
   * handlers remain the enforcement boundary, so a forced click still fails.
   */
  const capabilities = useMemo(() => {
    if (!current) return null
    const membership: MembershipContext = {
      role: current.role,
      // A room only appears in this list because the viewer has an active
      // membership row for it; an invited/removed/banned row is not listed.
      status: 'active',
      isOwner: current.room.owner_id === profile.id,
    }
    return capabilitySet(membership, roomContext(current.room))
  }, [current, profile.id])

  return (
    <aside
      aria-label="Rooms"
      className="flex h-full w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900"
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3.5">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full bg-brand-500 ring-4 ring-brand-500/15"
        />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-100">
          Collaborative Claude
        </p>
      </div>

      <div className="px-3 py-3">
        <Button size="sm" className="w-full" onClick={() => setCreating(true)}>
          <span aria-hidden="true" className="text-sm leading-none">
            +
          </span>
          New room
        </Button>
      </div>

      <RoomList rooms={rooms} currentRoomId={currentRoomId} />

      {current && capabilities ? (
        <RoomSettings room={current.room} capabilities={capabilities} />
      ) : null}

      <ProfileCard profile={profile} />

      <CreateRoomDialog open={creating} onClose={() => setCreating(false)} />
    </aside>
  )
}

export default Sidebar
