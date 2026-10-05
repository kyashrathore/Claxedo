import { ClaxedoIcon as Icon } from "@/ui"
import type { DraftContext } from "../draft-context"
import { useProjectsText } from "../i18n"
import type { ContextChip } from "./context-row"

function branchLabel(t: ReturnType<typeof useProjectsText>, context: DraftContext, selected: string | undefined): string {
  const state = context.branches()
  const known = context.current()?.branch
  if (state.kind !== "ready") {
    if (known && !context.creating()) return known
    return state.kind === "failed" ? t("projects.chip.branch.unavailable") : t("projects.chip.branch.loading")
  }
  if (context.creating()) return t("projects.chip.branch.from", { branch: selected ?? t("projects.chip.branch.currentCommit") })
  const branch = state.current ?? t("projects.chip.branch.detached")
  return state.dirty ? t("projects.chip.branch.dirty", { branch }) : branch
}

function unknowable(context: DraftContext): boolean {
  return context.branches().kind === "failed" && !context.creating() && !context.current()?.branch
}

export function useBranchChip(context: DraftContext): () => ContextChip | undefined {
  const t = useProjectsText()
  return () => {
    if (unknowable(context)) return undefined
    const state = context.branches()
    const selected = context.branch()
    return {
      slot: "context-chip-branch",
      icon: <Icon name="branch" size="small" />,
      label: branchLabel(t, context, selected),
      ariaLabel: t(context.creating() !== undefined ? "projects.chip.branch" : "projects.chip.branch.current"),
      search: { placeholder: t("projects.chip.branch.search") },
      groupLabel: t("projects.chip.branch.group"),
      emptyMessage: state.kind === "failed" ? t("projects.chip.branch.failed") : t("projects.chip.branch.empty"),
      current: selected,
      options: state.kind === "ready" ? state.branches.map((name) => ({ value: name, label: name })) : [],
      onSelect: context.chooseBranch,
      disabled: context.creating() === undefined || state.kind !== "ready",
    }
  }
}
