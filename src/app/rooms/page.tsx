'use client'

/**
 * The empty state: what you see at /rooms with no room selected.
 *
 * A client component so the call to action can open the same CreateRoomDialog
 * the sidebar uses — the alternative, telling the reader to go and find a button
 * somewhere else on the page, is not a call to action.
 */

import { useState } from 'react'

import CreateRoomDialog from '@/components/sidebar/CreateRoomDialog'
import Button from '@/components/ui/Button'

const POINTS: { title: string; body: string }[] = [
  {
    title: 'One conversation, several people',
    body: 'Everyone in a room reads the same Claude thread. Contributions arrive in the order they are sent, and nobody has to relay anything by hand.',
  },
  {
    title: 'Attributed to the Core Prompter',
    body: 'Whoever creates a room owns its Claude session. Every collaborator message is framed as a contribution to that person’s conversation, with the author named inside it, so Claude always knows who is speaking without losing the thread.',
  },
  {
    title: 'Private by default',
    body: 'A room is visible only to the accounts invited to it. Invitations are single-use links bound to one email address, and roles decide who may write, who may only read, and who may invite.',
  },
]

export default function RoomsIndexPage() {
  const [creating, setCreating] = useState(false)

  return (
    <main className="scrollbar-thin flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-lg rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl shadow-black/30">
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          Collaborative Claude
        </p>
        <h1 className="mt-1 text-lg font-semibold text-neutral-100">
          Select a room, or start your own
        </h1>

        <dl className="mt-5 flex flex-col gap-4">
          {POINTS.map((point) => (
            <div key={point.title}>
              <dt className="text-sm font-medium text-neutral-200">{point.title}</dt>
              <dd className="mt-1 text-[13px] leading-6 text-neutral-400">{point.body}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-6 border-t border-neutral-800 pt-5">
          <Button className="w-full" onClick={() => setCreating(true)}>
            Create a room
          </Button>
          <p className="mt-2 text-[11px] leading-4 text-neutral-500">
            You become its Core Prompter and decide who may join.
          </p>
        </div>
      </div>

      <CreateRoomDialog open={creating} onClose={() => setCreating(false)} />
    </main>
  )
}
