import { createEffect, createMemo, Show } from "solid-js"

function splitAt(text: string, line: number | undefined) {
  const lines = text.split("\n")
  if (line === undefined || line < 1 || line > lines.length) return { before: text, focus: undefined, after: "" }
  const before = lines.slice(0, line - 1).join("\n")
  const after = lines.slice(line).join("\n")
  return { before: before ? `${before}\n` : "", focus: lines[line - 1], after: after ? `\n${after}` : "" }
}

export function TextLines(props: { readonly text: string; readonly line?: number; readonly label: string }) {
  let mark: HTMLElement | undefined
  const parts = createMemo(() => splitAt(props.text, props.line))
  createEffect(() => {
    if (parts().focus === undefined) return
    mark?.scrollIntoView({ block: "center" })
  })
  return (
    <pre
      aria-label={props.label}
      class="m-0 min-h-full overflow-auto whitespace-pre px-3 py-2 font-mono text-12-regular leading-5 text-text-base"
      data-focus-line={props.line}
    >
      {parts().before}
      <Show when={parts().focus !== undefined}>
        <mark ref={mark} aria-current="true" class="rounded-sm bg-surface-base-active text-text-strong">
          {parts().focus}
        </mark>
      </Show>
      {parts().after}
    </pre>
  )
}
