import { Icon } from "@opencode-ai/ui/icon"
import type { ComponentProps } from "solid-js"

type IconName = ComponentProps<typeof Icon>["name"]
type IconSize = ComponentProps<typeof Icon>["size"]

/**
 * One authoritative glyph per domain concept.
 *
 * Surfaces MUST render these concepts through `<SemanticIcon>` (or look the
 * name up here) instead of picking raw icon names at call sites. The same
 * concept drifting across glyphs — folder vs page for "files", diff-lines vs
 * the boxed ± for "changes" — breaks recognition across surfaces and reads as
 * noise. If a new concept needs a glyph, add it HERE with a doc line, never
 * inline at the call site.
 */
export const SEMANTIC_ICON = {
  /** The workspace's pending diff — the panel's Review/Changes tab (boxed ±). */
  changes: "review",
  /** File browsing — the panel's Files tab. The page glyph, never the folder. */
  files: "file",
  /** Running processes — the panel's Processes tab. */
  processes: "console",
  /** An interactive terminal. */
  terminal: "terminal",
  /** A project / repository directory. The folder glyph belongs to this concept only. */
  project: "folder",
  /** A git branch. */
  branch: "branch",
} as const satisfies Record<string, IconName>

export type SemanticIconConcept = keyof typeof SEMANTIC_ICON

export function SemanticIcon(props: { concept: SemanticIconConcept; size?: IconSize; class?: string }) {
  return <Icon name={SEMANTIC_ICON[props.concept]} size={props.size} class={props.class} />
}
