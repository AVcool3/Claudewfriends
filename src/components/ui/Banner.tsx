'use client'

import type { ReactNode } from 'react'

export type BannerTone = 'error' | 'warning' | 'info' | 'success'

export interface BannerProps {
  tone: BannerTone
  title?: ReactNode
  onDismiss?: () => void
  children?: ReactNode
  className?: string
}

const TONES: Record<BannerTone, string> = {
  error: 'border-red-800/70 bg-red-950/50 text-red-100',
  warning: 'border-amber-800/70 bg-amber-950/40 text-amber-100',
  info: 'border-neutral-700 bg-neutral-900 text-neutral-200',
  success: 'border-emerald-800/70 bg-emerald-950/40 text-emerald-100',
}

export function Banner({ tone, title, onDismiss, children, className = '' }: BannerProps) {
  // Errors and warnings interrupt; info/success are polite so they do not talk
  // over whatever the user is doing when they appear.
  const live = tone === 'error' || tone === 'warning' ? 'alert' : 'status'

  return (
    <div role={live} className={`flex gap-3 rounded-lg border px-3 py-2.5 text-sm ${TONES[tone]} ${className}`}>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-1 text-[13px] opacity-90' : ''}>{children}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-0.5 h-6 w-6 shrink-0 rounded text-lg leading-none opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          &times;
        </button>
      ) : null}
    </div>
  )
}

export default Banner
