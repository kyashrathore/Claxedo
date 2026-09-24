import { A, useNavigate } from "@solidjs/router"
import { Avatar } from "@opencode-ai/ui/avatar"
import { createMemo, Match, Show, Switch, type JSX } from "solid-js"
import { CloudWorkspacesSection } from "@/cloud"
import type { EngineProject, Project, ProjectId } from "@/server"
import { SettingsGroup, SettingsList, SettingsNote, SettingsRow } from "@/settings"
import { Button, Icon, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { usePlacementOpener } from "../open"
import { getAvatarColors, projectDetail, projectLabel } from "../project-display"
import { projectSettingsPath } from "../routes"
import { useEngineProjects, useProject } from "../store"
import { DialogEditProject } from "./edit-project-dialog"
import { PlacementList } from "./placement-list"
import { RemoveProjectDialog } from "./remove-project-dialog"

function ProjectFields(props: { readonly project: EngineProject; readonly record: Project | undefined }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const label = () => projectLabel(props.project)
  const image = () => props.project.icon?.override
  const color = () => props.project.icon?.color || "pink"
  const variables = () => Object.keys(props.record?.env ?? {}).join(", ")
  return (
    <SettingsGroup
      title={t("projects.settings.group")}
      action={
        <Button variant="outline" onClick={() => dialog.show(() => <DialogEditProject project={props.project} />)}>
          {t("projects.edit.action")}
        </Button>
      }
    >
      <SettingsList>
        <SettingsRow title={t("projects.edit.name")} description={label()} />
        <SettingsRow title={t("projects.edit.icon")}>
          <Show when={image()} fallback={<Avatar fallback={label()} {...getAvatarColors(color())} class="size-8" />}>
            {(src) => <img src={src()} alt={t("projects.edit.icon.alt")} class="size-8 rounded object-cover" />}
          </Show>
        </SettingsRow>
        <Show when={!image()}>
          <SettingsRow title={t("projects.edit.color")} description={color()} />
        </Show>
        <SettingsRow title={t("projects.edit.startup")} description={props.project.commands?.start || t("projects.settings.none")} />
        <Show when={props.record}>
          <SettingsRow title={t("projects.edit.environment")} description={variables() || t("projects.settings.none")} />
        </Show>
      </SettingsList>
    </SettingsGroup>
  )
}

function ProjectPlacements(props: { readonly id: ProjectId; readonly record: Project | undefined }): JSX.Element {
  const t = useProjectsText()
  const open = usePlacementOpener()
  return (
    <SettingsGroup title={t("projects.placements")}>
      <PlacementList projectId={() => props.id} />
      <Show when={props.record?.source?.kind !== "folder"}>
        <CloudWorkspacesSection projectId={() => props.id} onOpen={open} />
      </Show>
    </SettingsGroup>
  )
}

function ProjectRemoval(props: { readonly id: ProjectId; readonly name: string }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const navigate = useNavigate()
  const remove = () => dialog.show(() => <RemoveProjectDialog id={props.id} name={props.name} onRemoved={() => navigate(projectSettingsPath())} />)
  return (
    <SettingsList>
      <SettingsRow title={t("projects.remove.title")} description={t("projects.settings.remove.description")}>
        <Button variant="danger" onClick={remove}>
          {t("projects.remove")}
        </Button>
      </SettingsRow>
    </SettingsList>
  )
}

function ProjectHeader(props: { readonly project: EngineProject }): JSX.Element {
  return (
    <header class="projects-settings-row-text">
      <h2 class="projects-settings-name">{projectLabel(props.project)}</h2>
      <span class="projects-settings-row-detail">{projectDetail(props.project)}</span>
    </header>
  )
}

export function ProjectSettings(props: { readonly id: ProjectId }): JSX.Element {
  const t = useProjectsText()
  const projects = useEngineProjects()
  const view = useProject(() => props.id)
  const project = createMemo(() => {
    const state = projects()
    return state.kind === "ready" ? state.data.find((item) => item.id === props.id) : undefined
  })
  const record = () => {
    const state = view()
    return state.kind === "ready" ? state.project : undefined
  }
  const failed = () => {
    const state = projects()
    return state.kind === "failed" ? state.error : undefined
  }
  return (
    <div class="settings-body" data-component="settings-project" data-project-id={props.id}>
      <A href={projectSettingsPath()} class="projects-settings-back">
        <Icon name="arrow-left" />
        <span>{t("projects.settings.all")}</span>
      </A>
      <Switch fallback={<SettingsNote tone="danger">{t("projects.missing")}</SettingsNote>}>
        <Match when={projects().kind === "loading"}>
          <p class="projects-hint projects-placeholder m-0">{t("projects.loading")}</p>
        </Match>
        <Match when={failed()}>
          {(error) => (
            <SettingsNote tone="danger">
              {t("projects.failed")}: {error().message}
            </SettingsNote>
          )}
        </Match>
        <Match when={project()}>
          {(row) => (
            <>
              <ProjectHeader project={row()} />
              <ProjectFields project={row()} record={record()} />
              <ProjectPlacements id={props.id} record={record()} />
              <Show when={record()}>
                <ProjectRemoval id={props.id} name={projectLabel(row())} />
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
