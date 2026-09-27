import type { MarkdownToken } from "./markdown-worker-protocol"

export type RenderedCodeState = {
  render: "tokens" | "plain"
  language: string
  generation: number
  stableCount: number
  unstable: MarkdownToken[]
  raw: string
}

export function sameToken(left: MarkdownToken, right: MarkdownToken | undefined) {
  return !!right && left[0] === right[0] && left[1] === right[1]
}

export function sameRenderedCode(previous: RenderedCodeState | undefined, next: RenderedCodeState) {
  return (
    !!previous &&
    previous.render === next.render &&
    previous.language === next.language &&
    previous.generation === next.generation &&
    previous.stableCount === next.stableCount &&
    previous.raw === next.raw &&
    previous.unstable.length === next.unstable.length &&
    previous.unstable.every((token, index) => sameToken(token, next.unstable[index]))
  )
}

export function shouldResetCodeTokens(
  previous: RenderedCodeState | undefined,
  next: { language: string; generation: number; stableCount: number; raw: string },
) {
  return (
    !previous ||
    previous.render !== "tokens" ||
    previous.language !== next.language ||
    previous.generation !== next.generation ||
    next.stableCount < previous.stableCount ||
    !next.raw.startsWith(previous.raw)
  )
}
