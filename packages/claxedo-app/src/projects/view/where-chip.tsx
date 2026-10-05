import type { JSX } from "solid-js"
import { cloudFailureReason, useCloudCommandFailureText, useCloudStatusText, useCloudWorkspaces, type CloudWorkspaces } from "@/cloud"
import { placementId, type Placement } from "@/server"
import { useConnectMachine } from "@/settings"
import { ClaxedoIcon as Icon, useDialog } from "@/ui"
import type { DraftContext } from "../draft-context"
import { groupedPlaces, type WhereEntry, type WherePlace } from "../draft-where"
import { useProjectsText, type ProjectsKey, type ProjectsText } from "../i18n"
import type { ContextChip, ContextChipAction, ContextChipOption } from "./context-row"
import { DialogNewCloudWorkspace } from "./new-cloud-workspace-dialog"

const PLACE_GROUP: Record<WherePlace, ProjectsKey> = { machine: "projects.chip.machines", cloud: "projects.chip.cloud" }

type Words = {
  readonly t: ProjectsText
  readonly context: DraftContext
  readonly cloudStatus: (placement: Placement) => string | undefined
}

function placementOnline(words: Words, placement: Placement): string {
  const machine = words.context.machineOf(placement)
  if (machine?.paused) return words.t("projects.where.paused")
  const online = machine ? machine.online : placement.reachable
  return words.t(online ? "projects.where.online" : "projects.where.offline")
}

function entryDetail(words: Words, placement: Placement): string | undefined {
  if (placement.kind === "cloud") return [words.cloudStatus(placement), placement.branch].filter(Boolean).join(" · ") || undefined
  return [words.context.machineOf(placement)?.name, placementOnline(words, placement)].filter(Boolean).join(" · ")
}

function whereOption(words: Words, entry: WhereEntry, grouped: ReadonlySet<WherePlace>): ContextChipOption {
  const detail = entryDetail(words, entry.placement)
  return {
    value: entry.placement.id,
    label: entry.placement.label,
    ...(detail ? { detail } : {}),
    ...(grouped.has(entry.place) ? { group: words.t(PLACE_GROUP[entry.place]) } : {}),
  }
}

function whereIcon(context: DraftContext): JSX.Element {
  const kind = context.creating() === "worktree" ? "worktree" : context.current()?.kind
  if (kind === "cloud") return <Icon name="cloud" size="small" />
  return <Icon name={kind === "worktree" ? "worktree" : "server"} size="small" />
}

function whereLabel(words: Words): string {
  const { t, context } = words
  const choice = context.choice()
  if (choice.kind === "newWorktree") return t("projects.chip.newWorktree.pending")
  const current = context.current()
  return current?.label ?? choice.pendingName ?? ""
}

function createActions(words: Words, openCloud: () => void, connect: () => void): readonly ContextChipAction[] {
  const { t, context } = words
  const worktrees = context.worktreeRoots().map((root) => ({
    label: t("projects.chip.newWorktree", { machine: context.machineOf(root)?.name ?? root.label }),
    onSelect: () => context.choose({ kind: "newWorktree", root: root.id }),
  }))
  const cloud = context.canCreateCloud() ? [{ label: t("projects.chip.newCloud"), onSelect: openCloud }] : []
  const machine = context.machinesLoaded() && !context.hasMachine() ? [{ label: t("projects.where.connectMachine"), onSelect: connect }] : []
  return [...worktrees, ...cloud, ...machine]
}

function useCloudStatus(cloud: CloudWorkspaces): Words["cloudStatus"] {
  const status = useCloudStatusText()
  const commandFailure = useCloudCommandFailureText()
  return (placement) => {
    const list = cloud.list()
    const row = list.kind === "ready" ? list.rows.find((item) => item.id === placement.id) : undefined
    return row ? [status(row.state), cloudFailureReason(row.state), commandFailure(row.commandFailure)].filter(Boolean).join(" — ") : undefined
  }
}

export function useWhereChip(context: DraftContext): () => ContextChip {
  const t = useProjectsText()
  const dialog = useDialog()
  const connect = useConnectMachine()
  const cloud = useCloudWorkspaces(context.projectId, context.canCreateCloud)
  const words: Words = { t, context, cloudStatus: useCloudStatus(cloud) }
  const openCloud = () =>
    dialog.show(() => <DialogNewCloudWorkspace cloud={cloud} onCreated={(workspace) => context.choose({ kind: "placement", id: workspace.id, pendingName: workspace.name })} />)
  return () => {
    const entries = context.entries()
    const grouped = groupedPlaces(entries)
    const current = context.creating() ? undefined : context.current()
    return {
      slot: "context-chip-where",
      icon: whereIcon(context),
      label: whereLabel(words),
      ariaLabel: t("projects.chip.where"),
      search: { placeholder: t("projects.chip.where.search") },
      emptyMessage: t("projects.chip.where.empty"),
      current: current?.id,
      options: entries.map((entry) => whereOption(words, entry, grouped)),
      onSelect: (value) => context.choose({ kind: "placement", id: placementId(value) }),
      actions: createActions(words, openCloud, connect),
    }
  }
}
