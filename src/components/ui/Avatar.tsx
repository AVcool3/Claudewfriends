'use client'

export type AvatarSize = 'sm' | 'md' | 'lg'

export interface AvatarProps {
  name: string
  src?: string | null
  size?: AvatarSize
  className?: string
}

const SIZES: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-[10px]',
  md: 'h-8 w-8 text-xs',
  lg: 'h-11 w-11 text-sm',
}

/**
 * Written out in full so Tailwind's class scanner can see every one of them —
 * a computed class name would be stripped from the generated stylesheet.
 */
const PALETTE = [
  'bg-rose-500/20 text-rose-200 ring-rose-400/30',
  'bg-amber-500/20 text-amber-200 ring-amber-400/30',
  'bg-emerald-500/20 text-emerald-200 ring-emerald-400/30',
  'bg-sky-500/20 text-sky-200 ring-sky-400/30',
  'bg-violet-500/20 text-violet-200 ring-violet-400/30',
  'bg-fuchsia-500/20 text-fuchsia-200 ring-fuchsia-400/30',
  'bg-teal-500/20 text-teal-200 ring-teal-400/30',
  'bg-orange-500/20 text-orange-200 ring-orange-400/30',
] as const

/**
 * Deterministic FNV-1a-ish hash. The colour must be identical on the server and
 * in the browser — anything random would render one colour in the HTML and
 * another after hydration, which React reports as a hydration mismatch.
 */
function hashName(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase()
}

export function Avatar({ name, src, size = 'md', className = '' }: AvatarProps) {
  const label = name.trim().length > 0 ? name : 'Unknown member'
  const shell = `relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 select-none ${SIZES[size]} ${className}`

  if (src) {
    return (
      // next/image would need every Supabase/Gravatar host allow-listed in
      // next.config.ts; a plain img keeps avatar sources open-ended.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={label} title={label} className={`${shell} bg-neutral-800 object-cover ring-white/10`} />
    )
  }

  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={`${shell} font-semibold ${PALETTE[hashName(label) % PALETTE.length]}`}
    >
      {initialsOf(label)}
    </span>
  )
}

export default Avatar
