import { Show, createMemo, createSignal } from "solid-js"
import type { ProseEditorProps } from "@/features/tasks/app-ports"
import { RichMode } from "@/features/documents/editor/rich-mode"
import { detectMarkdown, type MarkdownDetection, type RichMarkdown } from "@/features/documents/markdown/detector"
import { splitMarkdownEnvelope } from "@/features/documents/markdown/frontmatter"

/**
 * The Documents rich editor, driving a Tasks markdown field.
 *
 * The record stays a markdown string: the editor is given the body the envelope
 * splits off and hands back what it serialized, re-joined. The detector is the
 * same read-only gate Documents uses — it admits text only when this exact
 * extension set can parse AND re-serialize it unchanged — so anything it
 * classifies `source` or `rejected` gets the plain textarea rather than an
 * editor that would rewrite the user's bytes.
 *
 * Every value the field did not just emit is a replacement from outside — a
 * refetch, a rebase, a discard — and is put through the detector again, because
 * `RichMode` would otherwise `setContent` text the extensions cannot hold and
 * the next keystroke would save it back shorn of what was dropped. The value
 * the field emitted keeps the detection it was admitted under, so typing never
 * swaps the surface out mid-sentence.
 */
export function TasksProseEditor(props: ProseEditorProps) {
  // The emission carries its own detection: a replacement can restore the very
  // text the field last wrote, and matching it against the detection in force
  // by then would hand `RichMode` a document parsed from different text.
  let emitted: { markdown: string; detection: MarkdownDetection } | undefined
  // A task description is the app's own record, not a file the user owns, so
  // the first edit normalizing `* item` to `- item` is acceptable here and the
  // byte-exact gate Documents needs would only put this field in a textarea.
  const admitted = createMemo<MarkdownDetection>(() =>
    emitted && props.value === emitted.markdown ? emitted.detection : detectMarkdown(props.value, "normalizing"),
  )
  // A serializer that cannot write the tree belongs to the text that produced
  // it; a replacement is a different text and is owed its own attempt.
  const [failed, setFailed] = createSignal<MarkdownDetection>()
  const emit = (markdown: string) => {
    emitted = { markdown, detection: admitted() }
    props.onChange(markdown)
  }
  const rich = (): RichMarkdown | undefined => {
    const detection = admitted()
    if (detection.status !== "rich" || failed() === detection) return undefined
    // The envelope is re-split from the live value so a discard or a rebase
    // reaches the editor; `RichMode` ignores a body it just serialized itself.
    return { ...detection, envelope: splitMarkdownEnvelope(props.value) }
  }

  return (
    <Show
      when={rich()}
      fallback={
        <textarea
          data-testid={props.testId}
          aria-label={props.ariaLabel}
          placeholder={props.placeholder}
          value={props.value}
          onInput={(event) => emit(event.currentTarget.value)}
        />
      }
    >
      {(detection) => (
        <div data-testid={props.testId} data-prose-mode="rich">
          <RichMode
            detection={detection()}
            onInput={(markdown) => emit(markdown)}
            onBlur={() => {}}
            // A tree the serializer cannot write is the one case where staying
            // rich would lose text; the textarea below still holds every byte.
            onSerializationError={() => setFailed(() => admitted())}
          />
        </div>
      )}
    </Show>
  )
}
