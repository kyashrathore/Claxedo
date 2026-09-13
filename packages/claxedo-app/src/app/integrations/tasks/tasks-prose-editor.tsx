import { Show, createSignal } from "solid-js"
import type { ProseEditorProps } from "@claxedo/tasks/solid"
import { RichMode } from "@/features/documents/editor/rich-mode"
import { detectMarkdown, type RichMarkdown } from "@/features/documents/markdown/detector"
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
 * The mode is decided once per field. Re-detecting on every keystroke would
 * swap the surface out from under someone mid-sentence the moment they typed
 * something the subset does not cover.
 */
export function TasksProseEditor(props: ProseEditorProps) {
  // A task description is the app's own record, not a file the user owns, so
  // the first edit normalizing `* item` to `- item` is acceptable here and the
  // byte-exact gate Documents needs would only put this field in a textarea.
  const admitted = detectMarkdown(props.value, "normalizing")
  const [failed, setFailed] = createSignal(false)
  const rich = (): RichMarkdown | undefined => {
    if (admitted.status !== "rich" || failed()) return undefined
    // The envelope is re-split from the live value so a discard or a rebase
    // reaches the editor; `RichMode` ignores a body it just serialized itself.
    return { ...admitted, envelope: splitMarkdownEnvelope(props.value) }
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
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      }
    >
      {(detection) => (
        <div data-testid={props.testId} data-prose-mode="rich">
          <RichMode
            detection={detection()}
            onInput={(markdown) => props.onChange(markdown)}
            onBlur={() => {}}
            // A tree the serializer cannot write is the one case where staying
            // rich would lose text; the textarea below still holds every byte.
            onSerializationError={() => setFailed(true)}
          />
        </div>
      )}
    </Show>
  )
}
