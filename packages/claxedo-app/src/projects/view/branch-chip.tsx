import { ClaxedoIcon as Icon } from "@/ui"
import type { DraftContext } from "../draft-context"
import { useProjectsText } from "../i18n"
import type { ContextChip } from "./context-row"

function branchLabel(t: ReturnType<typeof useProjectsText>, context: DraftContext, selected: string | undefined): string {
  const state = context.branches()
  if (state.kind !== "ready") return state.kind === "failed" ? t("projects.chip.branch.unavailable") : t("projects.chip.branch.loading")
  if (context.creating()) {
    const branch = selected ?? t(context.creating() === "cloud" ? "projects.chip.branch.default" : "projects.chip.branch.currentCommit")
    return t("projects.chip.branch.from", { branch })
  }
  const branch = state.current ?? t("projects.chip.branch.detached")
  return state.dirty ? t("projects.chip.branch.dirty", { branch }) : branch
}

export function useBranchChip(context: DraftContext): () => ContextChip {
  const t = useProjectsText()
  return () => {
    const state = context.branches()
    const selected = context.creating() === "cloud" ? context.base() : context.branch()
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
