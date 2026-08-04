'use client'

/**
 * The "… is typing" line between the transcript and the composer.
 *
 * Rendered at a fixed height whether or not anyone is typing: letting the row
 * collapse would shift the message list up and down every couple of seconds,
 * which is far more distracting than the indicator is useful.
 */

import type { TypingIndicator } from '@/lib/types'

export interface TypingRowProps {
  typing: TypingIndicator[]
  currentUserId: string
}

function sentence(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`
  return `${names.length} people are typing…`
}

export function TypingRow({ typing, currentUserId }: TypingRowProps) {
  // Own events are already suppressed at the channel, but a second tab signed in
  // as the same account would still arrive here.
  const names = typing
    .filter((entry) => entry.user_id !== currentUserId)
    .map((entry) => entry.display_name)

  return (
    <div className="h-5 shrink-0 px-5" aria-live="polite">
      {names.length > 0 ? (
        <p className="flex items-center gap-1.5 truncate text-[11px] leading-5 text-neutral-500">
          <span aria-hidden="true" className="flex shrink-0 items-end gap-0.5">
            <span className="h-1 w-1 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.3s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.15s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-neutral-500" />
          </span>
          {sentence(names)}
        </p>
      ) : null}
    </div>
  )
}

export default TypingRow
