import { createMemo, type JSX } from "solid-js"

const MARQUEE_MS_PER_PIXEL = 28

export function SessionTitle(props: { readonly title: string; readonly hovered: boolean }): JSX.Element {
  let clip: HTMLSpanElement | undefined
  const overflow = createMemo(() => (props.hovered && props.title && clip ? Math.max(0, clip.scrollWidth - clip.clientWidth) : 0))
  return (
    <span
      ref={clip}
      data-marquee={overflow() > 0 ? "true" : undefined}
      class="ui-session-navigation-title ui-session-title leading-tight flex-1 min-w-0"
      style={{ "--session-title-distance": `${overflow()}px`, "--session-title-duration": `${overflow() * MARQUEE_MS_PER_PIXEL}ms` }}
    >
      <span class="ui-session-title-text">{props.title}</span>
    </span>
  )
}
