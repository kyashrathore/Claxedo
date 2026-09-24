import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { t } from "../i18n"
import { commentRangeLabel } from "../model"
import { parsePatch, rangeOf, selectable, type PatchLine } from "../patch"
import { useReview } from "../store"
import { LineCommentEditor } from "./line-comment-editor"

type Selection = { readonly from: number; readonly to: number }

const ROW_CLASS: Readonly<Record<PatchLine["kind"], string>> = {
  hunk: "bg-surface-base text-text-weak",
  context: "text-text-base",
  add: "bg-[color-mix(in_srgb,var(--text-diff-add-base)_12%,transparent)] text-text-base",
  del: "bg-[color-mix(in_srgb,var(--text-diff-delete-base)_12%,transparent)] text-text-base",
  note: "text-text-weaker italic",
}

const SIGN: Readonly<Record<PatchLine["kind"], string>> = { hunk: "", context: " ", add: "+", del: "−", note: "" }

function withinSelection(selection: Selection | undefined, index: number) {
  if (!selection) return false
  return index >= Math.min(selection.from, selection.to) && index <= Math.max(selection.from, selection.to)
}

export function PatchView(props: { readonly file: string; readonly patch: string }): JSX.Element {
  const review = useReview()
  const lines = createMemo(() => parsePatch(props.patch))
  const [selection, setSelection] = createSignal<Selection>()
  const range = createMemo(() => {
    const current = selection()
    return current ? rangeOf(lines(), current.from, current.to) : undefined
  })
  const editorAt = () => {
    const current = selection()
    return current ? Math.max(current.from, current.to) : -1
  }
  const pick = (line: PatchLine, extend: boolean) => {
    const current = selection()
    setSelection(current && extend ? { from: current.from, to: line.index } : { from: line.index, to: line.index })
  }
  const submit = (text: string) => {
    const picked = range()
    if (!picked) return
    review.addComment({ file: props.file, start: picked.start, end: picked.end, side: picked.side, text, preview: picked.preview })
    setSelection(undefined)
  }
  return (
    <div data-component="patch-view" class="overflow-x-auto font-mono text-12-regular leading-5">
      <For each={lines()}>
        {(line) => (
          <>
            <PatchRow line={line} selected={withinSelection(selection(), line.index)} onPick={(extend) => pick(line, extend)} />
            <Show when={editorAt() === line.index && range()}>
              {(picked) => (
                <LineCommentEditor
                  label={t("review.comment.on", { target: commentRangeLabel(picked()) })}
                  onSubmit={submit}
                  onCancel={() => setSelection(undefined)}
                />
              )}
            </Show>
          </>
        )}
      </For>
    </div>
  )
}

function PatchRow(props: { readonly line: PatchLine; readonly selected: boolean; readonly onPick: (extend: boolean) => void }) {
  const number = () => props.line.kind === "del" ? props.line.old : props.line.new
  return (
    <Show when={selectable(props.line)} fallback={<div class={`px-2 ${ROW_CLASS[props.line.kind]}`}>{props.line.text}</div>}>
      <button
        type="button"
        aria-pressed={props.selected}
        aria-label={`${t("review.comment.line", { line: number() ?? "" })}: ${props.line.text}`}
        data-line={number()}
        class={`flex w-full min-w-0 items-stretch text-left ${ROW_CLASS[props.line.kind]}`}
        classList={{ "outline outline-1 outline-border-strong-base": props.selected }}
        onClick={(event) => props.onPick(event.shiftKey)}
      >
        <span class="w-10 shrink-0 select-none pr-2 text-right text-text-weaker tabular-nums">{number()}</span>
        <span class="w-4 shrink-0 select-none text-text-weak">{SIGN[props.line.kind]}</span>
        <span class="whitespace-pre">{props.line.text}</span>
      </button>
    </Show>
  )
}
