'use client'

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ModalProps {
  open: boolean
  title: ReactNode
  onClose: () => void
  footer?: ReactNode
  children?: ReactNode
}

export function Modal({ open, title, onClose, footer, children }: ModalProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  // `document` only exists after mount, so the portal target is resolved in an
  // effect rather than during the (possibly server-side) first render.
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Held in a ref so the effect below depends on `open` alone. Call sites
  // routinely pass an inline arrow for onClose; if that identity were a
  // dependency the effect would re-run on every parent render and yank focus
  // out of whatever input the user is typing in.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    // `mounted` gates this too: on the very first pass the portal has not
    // rendered yet, so panelRef is still null and there is nothing to focus.
    if (!open || !mounted) return

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      // Returning focus to whatever opened the dialog is what keeps keyboard
      // users from being dumped at the top of the document on close.
      restoreFocusRef.current?.focus()
    }
  }, [open, mounted])

  if (!open || !mounted) return null

  function onBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    // Only a press that starts *and* lands on the backdrop closes; a drag that
    // began inside the panel (text selection) must not dismiss it.
    if (event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl focus:outline-none"
      >
        <div className="flex items-start gap-4 border-b border-neutral-800 px-5 py-4">
          <h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold text-neutral-100">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="-mr-1 h-6 w-6 shrink-0 rounded text-lg leading-none text-neutral-500 transition-colors hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/60"
          >
            &times;
          </button>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-neutral-200">
          {children}
        </div>

        {footer ? (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-800 bg-neutral-950/40 px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

export default Modal
