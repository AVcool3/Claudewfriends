import Spinner from '@/components/ui/Spinner'

/**
 * The root suspense fallback, shown while a page's server data is in flight.
 * `text-neutral-500` is what the spinner picks up: it draws itself from
 * `currentColor`.
 */
export default function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-neutral-500">
      <Spinner size="md" label="Loading" />
    </div>
  )
}
