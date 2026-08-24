/**
 * Neutral placeholder while a lazily-loaded content surface chunk arrives.
 *
 * Its own module because both the local and the hosted surface sets need it,
 * and the whole point of splitting them is that the hosted module must not be
 * reachable from the local graph. Importing it from either direction would put
 * one back in the other's closure over a twelve-line spinner.
 */
export const SurfaceFallback = (props: { label?: string }) => (
  <div
    role="status"
    aria-label={props.label ?? "Loading content"}
    class="flex size-full items-center justify-center gap-3 bg-background-base text-14-regular text-text-weak"
  >
    <span class="size-4 animate-spin rounded-full border border-border-base border-t-transparent" aria-hidden="true" />
    <span>{props.label ?? "Loading…"}</span>
  </div>
)
