'use client'

import type { ReactNode } from 'react'

export type BadgeTone = 'core' | 'admin' | 'collab' | 'viewer' | 'neutral'

export interface BadgeProps {
  tone: BadgeTone
  children: ReactNode
  className?: string
}

const TONES: Record<BadgeTone, string> = {
  core: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  admin: 'border-brand-500/40 bg-brand-500/10 text-brand-200',
  collab: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  viewer: 'border-neutral-600/60 bg-neutral-700/30 text-neutral-300',
  neutral: 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
}

export function Badge({ tone, children, className = '' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

export default Badge
