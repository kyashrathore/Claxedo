import { createEffect, createMemo, type JSX } from "solid-js"
import { projectId, useServer, type Placement, type Project, type ProjectId } from "@/server"
import { ClaxedoIcon as Icon, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { pickProjectFolderWith } from "../pick-project-folder"
import { primaryPlacement } from "../open"
import { inCatalogOrder } from "../project-order"
import { useProjects } from "../store"
import { createDraftContext, type DraftPlacementResolver, type DraftTarget } from "../draft-context"
import { useBranchChip, useEnvironmentChip, useWorkspaceChip } from "./context-chips"
import { SessionContextRow, type ContextChip, type ContextChipAvatar } from "./context-row"
import { ProjectCreateForm } from "./project-create-form"

export type DraftCreation = "worktree" | "cloud"

function projectDetail(project: Project, placements: readonly Placement[]): string {
  const hosted = placements.some((placement) => placement.projectId === project.id && placement.kind === "cloud")
  return hosted || !project.directory ? project.id : project.directory
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

type CreatePanelInput = { close: () => void; back: () => void; hold: (active: boolean) => void }

function CreateProjectPanel(props: CreatePanelInput & { readonly pickFolder: () => Promise<string | undefined>; readonly onCreated: (project: Project) => void }): JSX.Element {
  const server = useServer()
  return (
    <ProjectCreateForm
      localExecution={server.capabilities()?.thisMachine !== undefined}
      pickFolder={async () => {
        props.hold(true)
        try {
          return await props.pickFolder()
        } finally {
          props.hold(false)
        }
      }}
      onCreated={(project) => {
        props.close()
        props.onCreated(project)
      }}
      onCancel={props.back}
    />
  )
}

export function NewSessionContextRow(
  props: DraftTarget & {
    readonly resolver: DraftPlacementResolver
    readonly onOpen: (target: DraftTarget) => void
    readonly branch?: boolean
    readonly onCreatingChange?: (creating: DraftCreation | undefined) => void
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
  const pickFolder = pickProjectFolderWith(dialog)
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
    options: choices().map((project) => ({ value: project.id, label: project.name, detail: projectDetail(project, server.placements.list()), avatar: avatarOf(project, project.name) })),
    onSelect: (value) => openProject(projectId(value)),
    panel: {
      label: t("projects.chip.create"),
      render: (input) => <CreateProjectPanel {...input} pickFolder={pickFolder} onCreated={(project) => openProject(project.id)} />,
    },
  })
  const context = createDraftContext(() => ({ projectId: props.projectId, placementId: props.placementId }))
  props.resolver.attach(context)
  createEffect(() => props.onCreatingChange?.(context.creating() ? (context.hostKind() === "provisioner" ? "cloud" : "worktree") : undefined))
  const environmentChip = useEnvironmentChip(context)
  const workspaceChip = useWorkspaceChip(context)
  const branchChip = useBranchChip(context)
  const chips = createMemo((): ContextChip[] => {
    const environment = environmentChip()
    const branch = props.branch === false ? [] : [branchChip()]
    return [projectChip(), ...(environment ? [environment] : []), workspaceChip(), ...branch]
  })
  return <SessionContextRow chips={chips()} />
}
