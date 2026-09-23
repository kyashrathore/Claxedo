import { MARK_COLOR, MARK_TEXT_COLOR } from "./marks"

export function ImageMarkBadge(props: { number: number }) {
  return (
    <span
      data-slot="image-mark-badge"
      class="shrink-0 mt-px size-4 rounded-full flex items-center justify-center text-10-medium tabular-nums"
      style={{ background: MARK_COLOR, color: MARK_TEXT_COLOR }}
    >
      {props.number}
    </span>
  )
}
