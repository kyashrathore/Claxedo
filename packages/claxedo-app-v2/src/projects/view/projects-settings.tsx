import { A, useSearchParams } from "@solidjs/router"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { For, Match, Show, Switch, type JSX } from "solid-js"
import { projectId, type EngineProject } from "@/server"
import { SettingsEmpty, SettingsIntro, SettingsList, SettingsNote } from "@/settings"
import type { SettingsSection } from "@/shell"
import { Icon } from "@/ui"
import { useProjectsText } from "../i18n"
import { projectAvatarSource, projectDetail, projectLabel } from "../project-display"
import { projectSettingsPath } from "../routes"
import { useEngineProjects } from "../store"
import { ProjectSettings } from "./project-settings"
import "./projects.css"

function ProjectLink(props: { readonly project: EngineProject }): JSX.Element {
  return (
    <A href={projectSettingsPath(projectId(props.project.id))} class="projects-settings-row" data-project-id={props.project.id}>
      <ProjectAvatar aria-hidden="true" fallback={projectLabel(props.project)} src={projectAvatarSource(props.project.icon)} variant="outline" />
      <span class="projects-settings-row-text">
        <span class="projects-settings-row-name">{projectLabel(props.project)}</span>
        <span class="projects-settings-row-detail">{projectDetail(props.project)}</span>
      </span>
      <Icon name="chevron-right" />
    </A>
  )
}

function ProjectsList(): JSX.Element {
  const t = useProjectsText()
  const projects = useEngineProjects()
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
