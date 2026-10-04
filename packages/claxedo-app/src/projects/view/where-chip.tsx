import type { JSX } from "solid-js"
import { placementId, type Placement } from "@/server"
import { settingsPath, useShellRoute } from "@/shell"
import { ClaxedoIcon as Icon, SemanticIcon } from "@/ui"
import type { DraftContext } from "../draft-context"
import { entryPlace, groupedPlaces, type WhereEntry, type WherePlace } from "../draft-where"
import { useProjectsText, type ProjectsKey, type ProjectsText } from "../i18n"
import type { ContextChip, ContextChipOption } from "./context-row"
import { NewCloudWorkspacePanel } from "./new-cloud-workspace-panel"

const CONNECT_COMPUTER = "connect-computer"

const PLACE_GROUP: Record<WherePlace, ProjectsKey> = { computer: "projects.chip.self", cloud: "projects.chip.cloud", machine: "projects.chip.machines" }

function whereEntryLabel(t: ProjectsText, entry: { readonly place: WherePlace; readonly placement: Placement }): string {
  return entry.place === "computer" && entry.placement.kind === "folder" ? t("projects.chip.main") : entry.placement.label
}

function whereEntryDetail(context: DraftContext, entry: { readonly place: WherePlace; readonly placement: Placement }): string | undefined {
  if (entry.place === "cloud") return entry.placement.id
  if (entry.place === "machine") return (entry.placement.machineId && context.machineName(entry.placement.machineId)) ?? entry.placement.path
  return undefined
}

function whereOption(t: ProjectsText, context: DraftContext, entry: WhereEntry, grouped: ReadonlySet<WherePlace>): ContextChipOption {
  const group = grouped.has(entryPlace(entry)) ? { group: t(PLACE_GROUP[entryPlace(entry)]) } : {}
  if (entry.kind === "connectComputer") return { value: CONNECT_COMPUTER, label: t("projects.chip.connect"), detail: t("projects.chip.connect.detail"), ...group }
  const detail = whereEntryDetail(context, entry)
  return { value: entry.placement.id, label: whereEntryLabel(t, entry), ...(detail ? { detail } : {}), ...group }
}

function whereIcon(context: DraftContext): JSX.Element {
  const creating = context.creating()
  if (creating === "cloud") return <Icon name="cloud-upload" size="small" />
  if (creating === "worktree") return <SemanticIcon concept="isolationWorktree" size="small" />
  const current = context.current()
  if (current?.kind === "cloud") return <Icon name="cloud" size="small" />
  return current?.kind === "worktree" ? <SemanticIcon concept="isolationWorktree" size="small" /> : <Icon name="monitor" size="small" />
}

function whereLabel(t: ProjectsText, context: DraftContext): string {
  const choice = context.choice()
  if (choice.kind === "newCloud") return t("projects.chip.newCloud.named", { name: choice.name })
  if (choice.kind === "newWorktree") return t("projects.chip.newWorktree")
  const entry = context.entries().find((item) => item.kind === "placement" && item.placement.id === context.current()?.id)
  return entry?.kind === "placement" ? whereEntryLabel(t, entry) : ""
}

export function useWhereChip(context: DraftContext): () => ContextChip {
  const t = useProjectsText()
  const route = useShellRoute()
  return () => {
    const entries = context.entries()
    const grouped = groupedPlaces(entries)
    const current = context.creating() ? undefined : context.current()
    return {
      slot: "context-chip-where",
      icon: whereIcon(context),
      label: whereLabel(t, context),
      ...(current?.kind === "cloud" ? { title: current.id } : {}),
      ariaLabel: t("projects.chip.where"),
      search: { placeholder: t("projects.chip.where.search") },
      emptyMessage: t("projects.chip.where.empty"),
      current: current?.id,
      options: entries.map((entry) => whereOption(t, context, entry, grouped)),
      onSelect: (value) => (value === CONNECT_COMPUTER ? route.navigate(settingsPath("machines")) : context.choose({ kind: "placement", id: placementId(value) })),
      ...(context.canCreateWorktree() ? { action: { label: t("projects.chip.newWorktree"), onSelect: () => context.choose({ kind: "newWorktree" }) } } : {}),
      ...(context.canCreateCloud()
        ? { panel: { label: t("projects.chip.newCloud"), render: (input) => <NewCloudWorkspacePanel {...input} onName={context.choose} /> } }
        : {}),
    }
  }
}
