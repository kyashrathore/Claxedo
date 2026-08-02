import { For, createMemo } from "solid-js"
import { diffLines } from "diff"

export type ChangedOnDiskDiffLine = Readonly<{
  kind: "equal" | "delete" | "insert"
  text: string
}>

export function unifiedChangedOnDiskDiff(before: string, after: string): ChangedOnDiskDiffLine[] {
  return diffLines(before, after).map((change) => ({
    kind: change.added ? "insert" : change.removed ? "delete" : "equal",
    text: prefixLines(change.value, change.added ? "+" : change.removed ? "-" : " "),
  }))
}

export function ChangedOnDiskDiff(props: { before: string; after: string }) {
  const changes = createMemo(() => unifiedChangedOnDiskDiff(props.before, props.after))
  return (
    <div>
      <pre
        class="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-border-weak-base bg-background-base p-3 font-mono text-xs leading-5"
        aria-label="Unified changed-on-disk diff"
      >
        <For each={changes()}>
          {(change) => (
            <span
              style={{
                color:
                  change.kind === "insert"
                    ? "var(--text-diff-add-base)"
                    : change.kind === "delete"
                      ? "var(--text-diff-delete-base)"
                      : "var(--text-weak-base)",
              }}
            >
              {change.text}
            </span>
          )}
        </For>
      </pre>
      <pre class="sr-only" aria-label="Your draft">
        {props.before}
      </pre>
      <pre class="sr-only" aria-label="Current disk version">
        {props.after}
      </pre>
    </div>
  )
}

function prefixLines(value: string, prefix: string) {
  return (
    value
      .match(/[^\n]*(?:\n|$)/g)
      ?.filter(Boolean)
      .map((line) => prefix + line)
      .join("") ?? ""
  )
}
