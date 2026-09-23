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
  /** The workspace's pending diff — the boxed ±, shared with the review tab this
   *  row opens (`workspacePanel.open({ mode: "review" })`). One destination, one
   *  mark. */
  changes: "changes",
  /** File browsing — Codex's overlapping-folder explorer glyph. */
  files: "folders",
  /** Running processes — the panel's Processes tab. */
  processes: "process",
  /** An interactive terminal. */
  terminal: "terminal",
  /** A project / repository directory. The folder glyph belongs to this concept only. */
  project: "folder",
  /** A git branch. */
  branch: "branch",
  /** Session isolation — the main local checkout. Shares the folder glyph with
   *  `project` on purpose: both name a directory on disk, and they never appear
   *  as glyphs on the same surface. `isolationWorktree` is the alternative
   *  value of this same field, so it must stay a different glyph. */
  isolationLocal: "folder",
  /** Session isolation — a dedicated git worktree (a forked-off working tree). */
  isolationWorktree: "worktree",
  /** Session isolation — a sandbox on a machine that is not this one. */
  isolationCloud: "server",
  /** A source repository hosted on GitHub. */
  repository: "github",
  /** Opens a destination outside the app (external / web link). */
  openExternal: "open-external",
  /** The index — files already staged for the next commit. */
  staged: "check-small",
  /** Recording a commit. */
  commit: "circle-check",
  /** Sending local commits to the remote (push / publish). */
  push: "arrow-up",
  /** A pull request on the hosting forge. */
  pullRequest: "fork",
  /** Adding a file to the index. */
  stage: "plus-small",
  /** Removing a file from the index. */
  unstage: "dash",
} as const satisfies Record<string, IconName>

export type SemanticIconConcept = keyof typeof SEMANTIC_ICON

export function SemanticIcon(props: { concept: SemanticIconConcept; size?: IconSize; class?: string }) {
  return <Icon name={SEMANTIC_ICON[props.concept]} size={props.size} class={props.class} />
}
