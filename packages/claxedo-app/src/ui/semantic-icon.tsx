import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import type { ComponentProps } from "solid-js"

type IconName = ComponentProps<typeof Icon>["name"]
type IconSize = ComponentProps<typeof Icon>["size"]

export const SEMANTIC_ICON = {
  changes: "changes",
  files: "folders",
  terminal: "terminal",
  project: "folder",
  branch: "branch",
  isolationLocal: "folder",
  isolationWorktree: "worktree",
  isolationCloud: "server",
  repository: "github",
  openExternal: "open-external",
  staged: "check-small",
  commit: "circle-check",
  push: "arrow-up",
  pullRequest: "fork",
  stage: "plus-small",
  unstage: "dash",
} as const satisfies Record<string, IconName>

export type SemanticIconConcept = keyof typeof SEMANTIC_ICON

export function SemanticIcon(props: { concept: SemanticIconConcept; size?: IconSize; class?: string }) {
  return <Icon name={SEMANTIC_ICON[props.concept]} size={props.size} class={props.class} />
}
