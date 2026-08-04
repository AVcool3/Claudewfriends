'use client'

export interface SpinnerProps {
  size?: 'sm' | 'md'
  /** Announced to screen readers; omit inside a control that already labels itself. */
  label?: string
}

const SIZE_CLASSES: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'h-3.5 w-3.5 border-[1.5px]',
  md: 'h-5 w-5 border-2',
}

export function Spinner({ size = 'md', label }: SpinnerProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent opacity-80 ${SIZE_CLASSES[size]}`}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

export default Spinner
