/**
 * The kit's own marks. The package ships without the host's icon set, and a
 * row needs something at its left edge that is not the status dot, which is
 * already spoken for by the status column.
 */
export function TaskGlyph(props: { subtask?: boolean }) {
  return (
    <svg class="tsk-glyph" viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="9" rx="2.5" stroke="currentColor" stroke-width="1.2" />
      {props.subtask ? <path d="M4 6h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /> : null}
    </svg>
  )
}
