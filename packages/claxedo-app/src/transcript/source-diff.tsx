import { createMemo, Show, type JSX } from "solid-js"
import type { DiffSource } from "./diff-source"
import { File } from "./file"
import { resolveFileDiff } from "./session-diff"

type DiffPair = { readonly name: string; readonly contents: string }

export type SourceDiffProps = {
  readonly source: DiffSource | undefined
  readonly fallback?: { readonly before: DiffPair; readonly after: DiffPair }
  readonly lineInfoSeparators?: boolean
  readonly virtualize?: boolean
  readonly tokenizeMaxLength?: number
  readonly onRendered?: () => void
}

export function SourceDiff(props: SourceDiffProps): JSX.Element {
  const resolved = createMemo(() => {
    try {
      return props.source ? resolveFileDiff(props.source) : undefined
    } catch (error) {
      console.warn("An edit's diff could not be resolved; its before and after show instead", { error })
      return undefined
    }
  })
  const separators = () => {
    const fileDiff = resolved()
    if (!fileDiff || !props.lineInfoSeparators) return undefined
    return fileDiff.isPartial ? "simple" : "line-info-basic"
  }
  const fallback = () => {
    if (!props.fallback) throw new Error("A diff without a source needs its before and after contents")
    return props.fallback
  }
  return (
    <Show
      when={resolved()}
      fallback={
        <File mode="diff" before={fallback().before} after={fallback().after} virtualize={props.virtualize} tokenizeMaxLength={props.tokenizeMaxLength} onRendered={props.onRendered} />
      }
    >
      {(fileDiff) => (
        <File mode="diff" fileDiff={fileDiff()} hunkSeparators={separators()} virtualize={props.virtualize} tokenizeMaxLength={props.tokenizeMaxLength} onRendered={props.onRendered} />
      )}
    </Show>
  )
}
