import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
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
  /** The workspace's pending diff — Codex's document-and-branch Changes glyph. */
  changes: "changes",
  /** File browsing — Codex's overlapping-folder explorer glyph. */
  files: "folders",
  /** Running processes — the panel's Processes tab. */
  processes: "console",
  /** An interactive terminal. */
  terminal: "terminal",
  /** A project / repository directory. The folder glyph belongs to this concept only. */
  project: "folder",
  /** A git branch. */
  branch: "branch",
  /** Session isolation — the main local checkout. Codex uses the Worktree
   *  glyph for this row even when its value is "Main". */
  isolationLocal: "worktree",
  /** Session isolation — a dedicated git worktree. */
  isolationWorktree: "worktree",
  /** Session isolation — a remote cloud / user-hosted sandbox. */
  isolationCloud: "server",
  /** A source repository hosted on GitHub. */
  repository: "github",
  /** Opens a destination outside the app (external / web link). */
  openExternal: "square-arrow-top-right",
} as const satisfies Record<string, IconName>

export type SemanticIconConcept = keyof typeof SEMANTIC_ICON

export function SemanticIcon(props: { concept: SemanticIconConcept; size?: IconSize; class?: string }) {
  return <Icon name={SEMANTIC_ICON[props.concept]} size={props.size} class={props.class} />
}
