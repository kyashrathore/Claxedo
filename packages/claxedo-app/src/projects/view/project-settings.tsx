import { A, useNavigate } from "@solidjs/router"
import { Match, Show, Switch, type JSX } from "solid-js"
import { CloudWorkspacesSection } from "@/cloud"
import type { Project, ProjectId } from "@/server"
import { SettingsGroup, SettingsList, SettingsNote, SettingsRow } from "@/settings"
import { ClaxedoIcon as Icon, useDialog, Button, Avatar } from "@/ui"
import { useProjectsText } from "../i18n"
import { usePlacementOpener } from "../open"
import { sourceLabel } from "../project-source"
import { getAvatarColors } from "../project-avatar"
import { projectSettingsPath } from "../routes"
import { useProject } from "../store"
import { DialogEditProject } from "./edit-project-dialog"
import { PlacementList } from "./placement-list"
import { RemoveProjectDialog } from "./remove-project-dialog"

function ProjectFields(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const image = () => props.project.icon?.override
  const color = () => props.project.icon?.color || "pink"
  const variables = () => Object.keys(props.project.env).join(", ")
  return (
    <SettingsGroup
      title={t("projects.settings.group")}
      action={
        <Button variant="neutral" size="small" onClick={() => dialog.show(() => <DialogEditProject project={props.project} />)}>
          {t("projects.edit.action")}
        </Button>
      }
    >
      <SettingsList>
        <SettingsRow title={t("projects.edit.name")} description={props.project.name} />
        <SettingsRow title={t("projects.edit.icon")}>
          <Show when={image()} fallback={<Avatar fallback={props.project.name} {...getAvatarColors(color())} class="size-8" />}>
            {(src) => <img src={src()} alt={t("projects.edit.icon.alt")} class="size-8 rounded object-cover" />}
          </Show>
        </SettingsRow>
        <Show when={!image()}>
          <SettingsRow title={t("projects.edit.color")} description={color()} />
        </Show>
        <SettingsRow title={t("projects.edit.startup")} description={props.project.commands?.start || t("projects.settings.none")} />
        <SettingsRow title={t("projects.edit.environment")} description={variables() || t("projects.settings.none")} />
      </SettingsList>
    </SettingsGroup>
  )
}

function ProjectPlacements(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const open = usePlacementOpener()
  return (
    <SettingsGroup title={t("projects.placements")}>
      <PlacementList projectId={() => props.project.id} />
      <Show when={props.project.source?.kind !== "folder"}>
        <CloudWorkspacesSection projectId={() => props.project.id} onOpen={open} />
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
        <Button variant="neutral" size="small" onClick={remove}>
          {t("projects.remove")}
        </Button>
      </SettingsRow>
    </SettingsList>
  )
}

function ProjectHeader(props: { readonly project: Project }): JSX.Element {
  return (
    <header class="projects-settings-row-text">
      <h2 class="projects-settings-name">{props.project.name}</h2>
      <span class="projects-settings-row-detail">{sourceLabel(props.project.source)}</span>
    </header>
  )
}

export function ProjectSettings(props: { readonly id: ProjectId }): JSX.Element {
  const t = useProjectsText()
  const view = useProject(() => props.id)
  const project = () => {
    const state = view()
    return state.kind === "ready" ? state.project : undefined
  }
  const failed = () => {
    const state = view()
    return state.kind === "failed" ? state.error : undefined
  }
  return (
    <div class="settings-body" data-project-id={props.id}>
      <A href={projectSettingsPath()} class="projects-settings-back">
        <Icon name="arrow-left" />
        <span>{t("projects.settings.all")}</span>
      </A>
      <Switch fallback={<SettingsNote tone="danger">{t("projects.missing")}</SettingsNote>}>
        <Match when={view().kind === "loading"}>
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
              <ProjectFields project={row()} />
              <ProjectPlacements project={row()} />
              <ProjectRemoval id={props.id} name={row().name} />
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
