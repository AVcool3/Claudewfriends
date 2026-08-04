'use client'

import {
  createContext,
  forwardRef,
  useContext,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

export interface FieldProps {
  label: ReactNode
  htmlFor: string
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
}

interface FieldControlContext {
  id: string
  describedBy: string | undefined
  invalid: boolean
}

/**
 * Lets the controls below pick up `id`, `aria-describedby` and `aria-invalid`
 * without every call site repeating them. Explicit props on a control always
 * win, so a caller can still wire things by hand.
 */
const FieldContext = createContext<FieldControlContext | null>(null)

export function Field({ label, htmlFor, hint, error, children, className = '' }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined
  const errorId = error ? `${htmlFor}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <FieldContext.Provider value={{ id: htmlFor, describedBy, invalid: Boolean(error) }}>
      <div className={`flex flex-col gap-1.5 ${className}`}>
        <label htmlFor={htmlFor} className="text-xs font-medium text-neutral-300">
          {label}
        </label>
        {children}
        {hint ? (
          <p id={hintId} className="text-[11px] leading-4 text-neutral-500">
            {hint}
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="text-[11px] leading-4 text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

const CONTROL_BASE =
  'w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 text-sm text-neutral-100 ' +
  'placeholder:text-neutral-500 transition-colors focus:border-brand-500 focus:outline-none ' +
  'focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-[invalid=true]:border-red-700 aria-[invalid=true]:focus:ring-red-500/30'

type AriaInvalid = InputHTMLAttributes<HTMLInputElement>['aria-invalid']

function useControlAria(explicit: {
  id: string | undefined
  describedBy: string | undefined
  invalid: AriaInvalid
}) {
  const ctx = useContext(FieldContext)
  return {
    id: explicit.id ?? ctx?.id,
    'aria-describedby': explicit.describedBy ?? ctx?.describedBy,
    'aria-invalid': explicit.invalid ?? (ctx?.invalid ? true : undefined),
  }
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className = '', id, type = 'text', ...rest }, ref) {
    const aria = useControlAria({
      id,
      describedBy: rest['aria-describedby'],
      invalid: rest['aria-invalid'],
    })
    return <input ref={ref} type={type} {...rest} {...aria} className={`${CONTROL_BASE} h-10 ${className}`} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', id, rows = 3, ...rest }, ref) {
    const aria = useControlAria({
      id,
      describedBy: rest['aria-describedby'],
      invalid: rest['aria-invalid'],
    })
    return (
      <textarea
        ref={ref}
        rows={rows}
        {...rest}
        {...aria}
        className={`${CONTROL_BASE} resize-y py-2 leading-6 ${className}`}
      />
    )
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', id, children, ...rest }, ref) {
    const aria = useControlAria({
      id,
      describedBy: rest['aria-describedby'],
      invalid: rest['aria-invalid'],
    })
    return (
      <select ref={ref} {...rest} {...aria} className={`${CONTROL_BASE} h-10 appearance-none pr-8 ${className}`}>
        {children}
      </select>
    )
  },
)

export default Field
