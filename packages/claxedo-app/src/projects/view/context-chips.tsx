import type { JSX } from "solid-js"
import { placementId, useServer } from "@/server"
import { ClaxedoIcon as Icon, SemanticIcon } from "@/ui"
import type { DraftContext } from "../draft-context"
import { CREATE_WORKSPACE, MAIN_WORKSPACE, workspaceChoice, type HostKind } from "../draft-workspaces"
import { useProjectsText } from "../i18n"
import type { ContextChip } from "./context-row"

function useLabels() {
  const t = useProjectsText()
  const server = useServer()
  return {
    environment: (kind: HostKind) => (kind === "provisioner" ? t("projects.chip.cloud") : t("projects.chip.self")),
    workspace: (value: string) => (value === MAIN_WORKSPACE ? t("projects.chip.main") : (server.placements.byId(placementId(value))?.label ?? value)),
    create: (kind: HostKind) => (kind === "provisioner" ? t("projects.chip.newSandbox") : t("projects.chip.newWorktree")),
  }
}

export function useEnvironmentChip(context: DraftContext): () => ContextChip | undefined {
  const t = useProjectsText()
  const labels = useLabels()
  return () => {
    const options = context.environments()
    if (options.length === 0) return undefined
    const kind = context.hostKind()
    return {
      slot: "context-chip-environment",
      icon: <Icon name={kind === "provisioner" ? "cloud" : "monitor"} size="small" />,
      label: labels.environment(kind),
      ariaLabel: t("projects.chip.environment"),
      emptyMessage: t("projects.chip.environment.empty"),
      current: kind,
      options: options.map((option) => ({
        value: option,
        label: labels.environment(option),
        detail: option === "provisioner" ? t("projects.chip.cloud.detail") : t("projects.chip.self.detail"),
      })),
      onSelect: (value) => context.chooseHostKind(value === "provisioner" ? "provisioner" : "self"),
    }
  }
}

function workspaceIcon(context: DraftContext): JSX.Element {
  return context.creating() && context.hostKind() === "provisioner" ? <Icon name="cloud-upload" size="small" /> : <SemanticIcon concept="isolationWorktree" size="small" />
}

export function useWorkspaceChip(context: DraftContext): () => ContextChip {
  const t = useProjectsText()
  const labels = useLabels()
  return () => {
    const current = context.current()
    const create = labels.create(context.hostKind())
    return {
      slot: "context-chip-worktree",
      icon: workspaceIcon(context),
      label: context.creating() ? create : current ? labels.workspace(current) : "",
      ariaLabel: t("projects.chip.workspace"),
      search: { placeholder: t("projects.chip.workspace.search") },
      emptyMessage: t("projects.chip.workspace.empty"),
      current: context.creating() ? undefined : current,
      options: context.options().map((value) => ({ value, label: labels.workspace(value) })),
      onSelect: (value) => context.chooseWorkspace(workspaceChoice(value)),
      action: { label: create, onSelect: () => context.chooseWorkspace(CREATE_WORKSPACE) },
    }
  }
}

function branchLabel(t: ReturnType<typeof useProjectsText>, context: DraftContext, selected: string | undefined): string {
  const state = context.branches()
  if (state.kind !== "ready") return state.kind === "failed" ? t("projects.chip.branch.unavailable") : t("projects.chip.branch.loading")
  if (context.creating()) {
    const branch = selected ?? t(context.hostKind() === "provisioner" ? "projects.chip.branch.default" : "projects.chip.branch.currentCommit")
    return t("projects.chip.branch.from", { branch })
  }
  const branch = state.current ?? t("projects.chip.branch.detached")
  return state.dirty ? t("projects.chip.branch.dirty", { branch }) : branch
}

export function useBranchChip(context: DraftContext): () => ContextChip {
  const t = useProjectsText()
  return () => {
    const state = context.branches()
    const selected = context.hostKind() === "provisioner" ? context.base() : context.branch()
    return {
      slot: "context-chip-branch",
      icon: <Icon name="branch" size="small" />,
      label: branchLabel(t, context, selected),
      ariaLabel: t(context.creating() ? "projects.chip.branch" : "projects.chip.branch.current"),
      search: { placeholder: t("projects.chip.branch.search") },
      groupLabel: t("projects.chip.branch.group"),
      emptyMessage: state.kind === "failed" ? t("projects.chip.branch.failed") : t("projects.chip.branch.empty"),
      current: selected,
      options: state.kind === "ready" ? state.branches.map((name) => ({ value: name, label: name })) : [],
      onSelect: context.chooseBranch,
      disabled: !context.creating() || state.kind !== "ready",
    }
  }
}
