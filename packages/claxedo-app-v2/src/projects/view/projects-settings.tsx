import { A, useSearchParams } from "@solidjs/router"
import { createUniqueId, For, Match, Show, Switch, type JSX } from "solid-js"
import { projectId, type Project } from "@/server"
import { SettingsEmpty, SettingsIntro, SettingsList, SettingsNote } from "@/settings"
import type { SettingsSection } from "@/shell"
import { ClaxedoIcon as Icon, ProjectAvatar } from "@/ui"
import { useProjectsText } from "../i18n"
import { sourceLabel } from "../project-source"
import { projectSettingsPath } from "../routes"
import { useProjects } from "../store"
import { ProjectSettings } from "./project-settings"
import "./projects.css"

function ProjectLink(props: { readonly project: Project }): JSX.Element {
  const detailId = createUniqueId()
  return (
    <A
      href={projectSettingsPath(props.project.id)}
      class="projects-settings-row"
      aria-label={props.project.name}
      aria-describedby={detailId}
      data-project-id={props.project.id}
    >
      <ProjectAvatar aria-hidden="true" fallback={props.project.name} src={props.project.icon?.override} variant="outline" />
      <span class="projects-settings-row-text">
        <span class="projects-settings-row-name">{props.project.name}</span>
        <span id={detailId} class="projects-settings-row-detail">{sourceLabel(props.project.source)}</span>
      </span>
      <Icon name="chevron-right" />
    </A>
  )
}

function ProjectsList(): JSX.Element {
  const t = useProjectsText()
  const projects = useProjects()
  const failed = () => {
    const state = projects()
    return state.kind === "failed" ? state.error : undefined
  }
  const rows = () => {
    const state = projects()
    return state.kind === "ready" ? state.data : undefined
  }
  return (
    <div class="settings-body" data-component="settings-projects">
      <SettingsIntro description={t("projects.settings.description")} />
      <Switch>
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
        <Match when={rows()}>
          {(items) => (
            <Show when={items().length > 0} fallback={<SettingsEmpty>{t("projects.empty")}</SettingsEmpty>}>
              <SettingsList>
                <For each={items()}>{(project) => <ProjectLink project={project} />}</For>
              </SettingsList>
            </Show>
          )}
        </Match>
      </Switch>
    </div>
  )
}

function ProjectsSettings(): JSX.Element {
  const [params] = useSearchParams<{ project?: string }>()
  return (
    <Show when={params.project} keyed fallback={<ProjectsList />}>
      {(id) => <ProjectSettings id={projectId(id)} />}
    </Show>
  )
}

export const projectsSettingsSection: SettingsSection = {
  id: "projects",
  title: () => useProjectsText()("projects.title"),
  group: "workspace",
  order: 10,
  view: ProjectsSettings,
}
