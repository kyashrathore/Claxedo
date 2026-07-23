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
  /** Session isolation — the main local checkout. Shares the folder glyph with
   *  `project` on purpose: both name a directory on disk, and they never appear
   *  as glyphs on the same surface. */
  isolationLocal: "folder",
  /** Session isolation — a dedicated git worktree (a forked-off working tree). */
  isolationWorktree: "fork",
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
