'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'
import Spinner from '@/components/ui/Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Replaces the label with a spinner and blocks further clicks. */
  loading?: boolean
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60 focus-visible:ring-offset-2 ' +
  'focus-visible:ring-offset-neutral-950 disabled:cursor-not-allowed disabled:opacity-50'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-brand-500 bg-brand-500 text-white hover:bg-brand-400 hover:border-brand-400',
  secondary: 'border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700',
  ghost: 'border-transparent bg-transparent text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100',
  danger: 'border-red-600/70 bg-red-600/90 text-white hover:bg-red-500',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-10 px-4 text-sm',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, className = '', children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // Buttons inside a form default to `submit`; defaulting to `button`
      // stops an action button from accidentally submitting its parent form.
      type={type ?? 'button'}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner size="sm" /> : null}
      {children}
    </button>
  )
})

export default Button
