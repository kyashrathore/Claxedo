import { createMemo } from "solid-js"

/**
 * AgentGlyph (T12) — a deterministic little two-tone mark that gives each subagent a
 * stable visual identity, seeded by its child sessionId (D§3.8). FNV-1a picks one of
 * ten geometric shapes; the caller supplies the accent color (from the agent palette).
 * While the child runs, a slow scan/pulse plays (reduced-motion gated in CSS).
 */
function fnv1a(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

// Ten tiny glyph paths on a 0 0 16 16 viewBox — gems, flowers, and stars.
const GLYPHS: string[] = [
  "M8 2l6 6-6 6-6-6z",
  "M8 2l4 3v6l-4 3-4-3V5z",
  "M8 3a5 5 0 100 10 5 5 0 000-10zM8 6a2 2 0 110 4 2 2 0 010-4z",
  "M8 2l1.8 3.9L14 6.4l-3 3 .8 4.2L8 11.6 4.2 13.6 5 9.4l-3-3 4.2-.5z",
  "M4 4h8v8H4zM6 6v4h4V6z",
  "M8 2c2 2 4 2 6 0-2 2-2 4 0 6-2-2-4-2-6 0 0-2-2-4 0-6-2 2-4 2-6 0 2 2 2 4 0 6 2-2 4-2 6 0z",
  "M8 2l5 2.5v7L8 14 3 11.5v-7z",
  "M3 8a5 5 0 015-5v10a5 5 0 01-5-5z",
  "M8 2l2 4 4 .5-3 3 .8 4L8 11.5 4.2 13.5 5 9.5 2 6.5 6 6z",
  "M8 2c3 0 6 3 6 6s-3 6-6 6V2z",
]

export function AgentGlyph(props: { seed: string; color?: string; active?: boolean; size?: number }) {
  const size = () => props.size ?? 14
  const index = createMemo(() => fnv1a(props.seed || "agent") % GLYPHS.length)
  const color = () => props.color ?? "var(--icon-base)"
  return (
    <span
      data-component="agent-glyph" class="ui-agent-glyph"
      data-active={props.active ? "true" : undefined}
      style={{ width: `${size()}px`, height: `${size()}px`, color: color() }}
    >
      <svg width={size()} height={size()} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d={GLYPHS[index()]} fill="currentColor" fill-opacity="0.35" />
        <path d={GLYPHS[index()]} stroke="currentColor" stroke-width="1" stroke-linejoin="round" />
      </svg>
    </span>
  )
}
