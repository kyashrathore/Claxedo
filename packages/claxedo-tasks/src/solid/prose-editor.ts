import type { JSX } from "solid-js"

/**
 * The host's prose editor for a markdown field.
 *
 * A component, like `configurationEditor`, because the editor lives in the app:
 * it is the Documents rich editor, and the kit carries no editor dependency of
 * its own. Markdown crosses this boundary in both directions — `value` is the
 * stored string and `onChange` is handed the same — so whichever surface the
 * host mounts, the record stays markdown.
 */
export type ProseEditorProps = {
  value: string
  placeholder: string
  ariaLabel: string
  /** Carried onto whichever control the host mounts, so a test can find the field. */
  testId: string
  onChange: (markdown: string) => void
}

export type ProseEditor = (props: ProseEditorProps) => JSX.Element
