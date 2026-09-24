import { createMemo, onCleanup, type JSX } from "solid-js"
import { projectId, useServer, type Placement, type PlacementId, type Project, type ProjectId } from "@/server"
import { ClaxedoIcon as Icon, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { pickProjectFolderWith } from "../pick-project-folder"
import { useProjectList } from "../project-list"
import { useProjects } from "../store"
import { SessionContextRow, type ContextChip, type ContextChipAvatar } from "./context-row"
import { ProjectCreateForm } from "./project-create-form"

function primaryPlacement(placements: readonly Placement[], project: ProjectId): Placement | undefined {
  const own = placements.filter((placement) => placement.projectId === project)
  return own.find((placement) => placement.kind === "folder") ?? own[0]
}

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
    return state.kind === "ready" ? [...state.data].sort((a, b) => b.updatedAt - a.updatedAt) : []
  })
}

export type DraftTarget = { readonly projectId: ProjectId; readonly placementId: PlacementId }

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

export function NewSessionContextRow(props: DraftTarget & { readonly onOpen: (target: DraftTarget) => void }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const dialog = useDialog()
  const list = useProjectList()
  const choices = useProjectChoices()
  onCleanup(list.registerCreateSurface())
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
    openPanel: { pending: list.createPending, answer: list.answerCreate },
    options: choices().map((project) => ({ value: project.id, label: project.name, detail: projectDetail(project, server.placements.list()), avatar: avatarOf(project, project.name) })),
    onSelect: (value) => openProject(projectId(value)),
    panel: {
      label: t("projects.chip.create"),
      render: (input) => <CreateProjectPanel {...input} pickFolder={pickFolder} onCreated={(project) => openProject(project.id)} />,
    },
  })
  const chips = createMemo((): ContextChip[] => [projectChip()])
  return <SessionContextRow chips={chips()} />
}
