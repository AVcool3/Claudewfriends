'use client'

import Link from 'next/link'
import Badge, { type BadgeTone } from '@/components/ui/Badge'
import { ROLE_LABELS, type Role, type Room } from '@/lib/types'

/** One row of the sidebar: the room plus the facts the viewer needs about it. */
export interface RoomSummary {
  room: Room
  /** The *viewing* user's role in this room, not the owner's. */
  role: Role
  /** Display name of the room's Core Prompter (its `owner_id`). */
  ownerName: string
  memberCount: number
}

export interface RoomListProps {
  rooms: RoomSummary[]
  currentRoomId: string | null
}

const ROLE_TONE: Record<Role, BadgeTone> = {
  core_prompter: 'core',
  administrator: 'admin',
  collaborator: 'collab',
  viewer: 'viewer',
}

/** `Administrator` does not fit beside a room name in a 288px column. */
const ROLE_SHORT: Record<Role, string> = {
  core_prompter: 'Core',
  administrator: 'Admin',
  collaborator: 'Collab',
  viewer: 'Viewer',
}

function LockIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className={className}
    >
      <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" strokeLinecap="round" />
    </svg>
  )
}

export function RoomList({ rooms, currentRoomId }: RoomListProps) {
  if (rooms.length === 0) {
    return (
      <div className="min-h-0 flex-1 px-4 py-6">
        <p className="text-xs leading-5 text-neutral-500">
          No rooms yet. Create one to start a conversation — you become its Core Prompter and decide
          who may join.
        </p>
      </div>
    )
  }

  return (
    <nav aria-label="Your rooms" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <ul className="flex flex-col gap-0.5">
        {rooms.map(({ room, role, ownerName, memberCount }) => {
          const selected = room.id === currentRoomId
          return (
            <li key={room.id}>
              <Link
                href={`/rooms/${room.id}`}
                aria-current={selected ? 'page' : undefined}
                className={`block rounded-lg border-l-2 py-2 pr-2.5 pl-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 ${
                  selected
                    ? 'border-brand-500 bg-neutral-800'
                    : 'border-transparent hover:bg-neutral-800/50'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`min-w-0 flex-1 truncate text-sm font-medium ${
                      selected ? 'text-neutral-50' : 'text-neutral-200'
                    }`}
                  >
                    {room.name}
                  </span>

                  {room.is_locked ? (
                    <span className="inline-flex shrink-0 items-center text-amber-300" title="Locked">
                      <LockIcon className="h-3.5 w-3.5" />
                      <span className="sr-only">Locked</span>
                    </span>
                  ) : null}

                  <span className="shrink-0" title={ROLE_LABELS[role]}>
                    <Badge tone={ROLE_TONE[role]}>{ROLE_SHORT[role]}</Badge>
                  </span>
                </span>

                {/*
                 * Who owns the Claude session is the single most consequential
                 * fact about a room — every contribution is attributed to this
                 * person — so it is on the row itself rather than behind a click.
                 */}
                <span className="mt-1 block truncate text-[11px] leading-4 text-neutral-500">
                  Core Prompter: <span className="text-neutral-400">{ownerName}</span>
                </span>
                <span className="block text-[11px] leading-4 text-neutral-600">
                  {memberCount} {memberCount === 1 ? 'member' : 'members'}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

export default RoomList
