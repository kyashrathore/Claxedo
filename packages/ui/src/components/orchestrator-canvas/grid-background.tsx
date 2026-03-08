// ---------------------------------------------------------------------------
// SVG dot-grid pattern background for the canvas (theme-aware)
// ---------------------------------------------------------------------------

export function GridBackground() {
  return (
    <>
      <defs>
        <pattern
          id="oc-canvas-grid"
          width="20"
          height="20"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r="0.5" fill="var(--border-weaker-base)" />
        </pattern>
      </defs>
      <rect
        width="10000"
        height="10000"
        x="-5000"
        y="-5000"
        fill="url(#oc-canvas-grid)"
      />
    </>
  )
}
