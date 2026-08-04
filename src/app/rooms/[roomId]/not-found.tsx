import Link from 'next/link'

/**
 * Rendered when the room page calls `notFound()`.
 *
 * The wording covers "no such room" and "you are not a member of this room"
 * without distinguishing them, mirroring `ROOM_NOT_FOUND` in
 * `src/lib/server/room-context.ts`. That ambiguity is the point: a page that
 * said "this room exists but you cannot see it" would turn a walk of room ids
 * into a directory of every room in the deployment.
 */
export default function RoomNotFound() {
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">Room unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          That room does not exist, or you do not have access to it. If you were expecting an
          invitation, open the link that was sent to your email address — an invitation only redeems
          for the account it was addressed to.
        </p>
        <Link
          href="/rooms"
          className="mt-5 inline-flex h-9 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 px-3.5 text-[13px] font-medium text-neutral-100 transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
        >
          Back to your rooms
        </Link>
      </div>
    </main>
  )
}
