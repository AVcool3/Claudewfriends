import Link from 'next/link'

/** The 404 for anything outside a room — an unknown path, or a stale bookmark. */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl shadow-black/30">
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">404</p>
        <h1 className="mt-1 text-lg font-semibold text-neutral-100">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          There is nothing at this address. The rooms you belong to are all reachable from the room
          list.
        </p>
        <Link
          href="/rooms"
          className="mt-5 inline-flex h-10 items-center justify-center rounded-lg border border-brand-500 bg-brand-500 px-4 text-sm font-medium text-white transition-colors hover:border-brand-400 hover:bg-brand-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
        >
          Go to your rooms
        </Link>
      </div>
    </main>
  )
}
