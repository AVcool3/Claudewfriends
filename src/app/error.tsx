'use client'

/**
 * The application-wide error boundary. It replaces everything below the root
 * layout, so it renders its own full-height page rather than a column of the
 * shell.
 */

import { useEffect } from 'react'
import Link from 'next/link'

import Button from '@/components/ui/Button'

export interface AppErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function AppError({ error, reset }: AppErrorProps) {
  useEffect(() => {
    // The browser console is the only place this reaches a developer: an error
    // boundary is not a route handler and has no server log of its own.
    console.error('[app/error]', error)
  }, [error])

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl shadow-black/30">
        <h1 className="text-lg font-semibold text-neutral-100">Something went wrong</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          This page could not finish rendering. Nothing you sent has been lost — messages that
          reached the room are stored server-side, so trying again is safe.
        </p>

        {/*
         * Next.js replaces the message of a server-side error with a generic
         * string in production and exposes only `digest`, so printing it here
         * cannot leak internals; in development it is the actual cause and is
         * exactly what a developer needs to see.
         */}
        {error.message ? (
          <p className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] leading-5 break-words text-neutral-500">
            {error.message}
          </p>
        ) : null}

        {error.digest ? (
          <p className="mt-2 text-[11px] text-neutral-600">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}

        <div className="mt-6 flex items-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Link
            href="/rooms"
            className="inline-flex h-10 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800 px-4 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
          >
            Back to your rooms
          </Link>
        </div>
      </div>
    </main>
  )
}
