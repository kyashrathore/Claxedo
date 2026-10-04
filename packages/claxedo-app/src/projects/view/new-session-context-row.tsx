import { createEffect, createMemo, type JSX } from "solid-js"
import { projectId, useServer, type Project, type ProjectId } from "@/server"
import { ClaxedoIcon as Icon, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { primaryPlacement } from "../open"
import { inCatalogOrder } from "../project-order"
import { useProjects } from "../store"
import { createDraftContext, type DraftPlacementResolver, type DraftTarget } from "../draft-context"
import type { WhereCreation } from "../draft-where"
import { useBranchChip } from "./branch-chip"
import { useWhereChip } from "./where-chip"
import { SessionContextRow, type ContextChip, type ContextChipAvatar } from "./context-row"
import { DialogCreateProject } from "./create-project-dialog"
import { sourceLabel } from "../project-source"

function projectDetail(project: Project): string | undefined {
  const source = sourceLabel(project.source)
  return source || project.directory
}

function avatarOf(project: Project | undefined, fallback: string): ContextChipAvatar {
  return { fallback: project?.name ?? fallback, ...(project?.icon?.override ? { src: project.icon.override } : {}) }
}

function useProjectChoices() {
  const projects = useProjects()
  return createMemo(() => {
    const state = projects()
    return state.kind === "ready" ? inCatalogOrder(state.data) : []
  })
}

export function NewSessionContextRow(
  props: DraftTarget & {
    readonly resolver: DraftPlacementResolver
    readonly onOpen: (target: DraftTarget) => void
    readonly branch?: boolean
    readonly onCreatingChange?: (creating: WhereCreation | undefined) => void
  },
): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const choices = useProjectChoices()
  const current = createMemo(() => choices().find((project) => project.id === props.projectId))
  const openProject = (id: ProjectId) => {
    if (id === props.projectId) return
    const placement = primaryPlacement(server.placements.list(), id)
    if (placement) props.onOpen({ projectId: id, placementId: placement.id })
  }
  const projectChip = (): ContextChip => ({
    slot: "context-chip-project",
    icon: <Icon name="folder" size="small" />,
    avatar: avatarOf(current(), ""),
    label: current()?.name ?? "",
    ariaLabel: t("projects.chip.project"),
    search: { placeholder: t("projects.chip.search") },
    groupLabel: t("projects.title"),
    emptyMessage: t("projects.empty"),
    current: props.projectId,
    options: choices().map((project) => {
      const detail = projectDetail(project)
      return { value: project.id, label: project.name, ...(detail ? { detail } : {}), avatar: avatarOf(project, project.name) }
    }),
    onSelect: (value) => openProject(projectId(value)),
    actions: [{ label: t("projects.chip.create"), onSelect: () => dialog.show(() => <DialogCreateProject onCreated={(project) => openProject(project.id)} />) }],
  })
  const context = createDraftContext(() => ({ projectId: props.projectId, placementId: props.placementId }))
  props.resolver.attach(context)
  createEffect(() => props.onCreatingChange?.(context.creating()))
  const whereChip = useWhereChip(context)
  const branchChip = useBranchChip(context)
  const chips = createMemo((): ContextChip[] => [projectChip(), whereChip(), ...(props.branch === false ? [] : [branchChip()])])
  return <SessionContextRow chips={chips()} />
}
