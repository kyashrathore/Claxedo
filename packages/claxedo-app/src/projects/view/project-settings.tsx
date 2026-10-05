import { A, useNavigate } from "@solidjs/router"
import { Match, Show, Switch, type JSX } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, useServer, type MissingCheckout, type Project, type ProjectId } from "@/server"
import { SettingsGroup, SettingsList, SettingsNote, SettingsRow } from "@/settings"
import { ClaxedoIcon as Icon, useDialog, Button, Avatar } from "@/ui"
import { useProjectsText } from "../i18n"
import { sourceLabel } from "../project-source"
import { getAvatarColors } from "../project-avatar"
import { projectSettingsPath } from "../routes"
import { useProject, useProjectCommands, useProjectEnvironment } from "../store"
import { DialogEditProject } from "./edit-project-dialog"
import { DrawerProjectEnvironment } from "./project-environment-drawer"
import { WhereItRuns } from "./where-it-runs"
import { RemoveProjectDialog } from "./remove-project-dialog"

function MissingCheckoutSection(props: { readonly id: ProjectId; readonly checkout: MissingCheckout }): JSX.Element {
  const t = useProjectsText()
  const commands = useProjectCommands()
  const reclone = createFlow<"cloning", Project>()
  const cloning = () => reclone.state().kind === "running"
  const failure = () => {
    const state = reclone.state()
    return state.kind === "failed" ? state.error.message : undefined
  }
  const start = () => {
    if (cloning()) return
    void runFlow(reclone, "cloning", () => commands.reclone(props.id), toAppError)
  }
  return (
    <SettingsGroup
      title={t("projects.checkout.missing")}
      description={t("projects.checkout.missing.description", { directory: props.checkout.directory })}
    >
      <SettingsList>
        <Show
          when={props.checkout.remote}
          fallback={<SettingsRow title={t("projects.checkout.remote")} description={t("projects.checkout.remote.none")} />}
        >
          {(remote) => (
            <SettingsRow title={t("projects.checkout.remote")} description={remote()}>
              <Button variant="contrast" size="small" disabled={cloning()} onClick={start} data-testid="project-reclone">
                {cloning() ? t("projects.checkout.cloning") : t("projects.checkout.clone")}
              </Button>
            </SettingsRow>
          )}
        </Show>
      </SettingsList>
      <Show when={failure()}>{(message) => <SettingsNote tone="danger">{message()}</SettingsNote>}</Show>
    </SettingsGroup>
  )
}

function ProjectFields(props: { readonly project: Project; readonly editable: boolean }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const image = () => props.project.icon?.override
  const color = () => props.project.icon?.color || "pink"
  return (
    <SettingsGroup
      action={
        props.editable ? (
          <Button variant="neutral" size="small" onClick={() => dialog.show(() => <DialogEditProject project={props.project} />)}>
            {t("projects.edit.action")}
          </Button>
        ) : undefined
      }
    >
      <SettingsList>
        <SettingsRow title={t("projects.edit.name")} description={props.project.name} />
        <SettingsRow title={t("projects.edit.icon")}>
          <Show when={image()} fallback={<Avatar fallback={props.project.name} {...getAvatarColors(color())} size="large" kind="org" />}>
            {(src) => <img src={src()} alt={t("projects.edit.icon.alt")} class="size-8 rounded object-cover" />}
          </Show>
        </SettingsRow>
        <Show when={!image()}>
          <SettingsRow title={t("projects.edit.color")} description={color()} />
        </Show>
      </SettingsList>
    </SettingsGroup>
  )
}

function ProjectEnvironmentSection(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const environment = useProjectEnvironment(() => props.project.id)
  const ready = () => {
    const state = environment()
    return state.kind === "ready" ? state.data : undefined
  }
  const failure = () => {
    const state = environment()
    return state.kind === "failed" ? state.error.message : undefined
  }
  return (
    <SettingsGroup
      title={t("projects.environment.title")}
      description={t("projects.environment.summary")}
      action={
        <Show when={ready()}>
          {(loaded) => (
            <Button
              variant="neutral"
              size="small"
              data-testid="project-environment-edit"
              onClick={() => dialog.show(() => <DrawerProjectEnvironment project={props.project} environment={loaded()} />)}
            >
              {t("projects.environment.edit")}
            </Button>
          )}
        </Show>
      }
    >
      <SettingsList>
        <SettingsRow
          title={t("projects.edit.environment")}
          description={ready() ? ready()!.names.join(", ") || t("projects.settings.none") : t("projects.loading")}
        />
      </SettingsList>
      <Show when={failure()}>{(message) => <SettingsNote tone="danger">{t("projects.environment.failed")}: {message()}</SettingsNote>}</Show>
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

function ProjectSettingsHeader(props: { readonly project: Project }): JSX.Element {
  return (
    <header class="projects-settings-row-text">
      <h2 class="projects-settings-name">{props.project.name}</h2>
      <span class="projects-settings-row-detail">{sourceLabel(props.project.source)}</span>
    </header>
  )
}

export function ProjectSettings(props: { readonly id: ProjectId }): JSX.Element {
  const t = useProjectsText()
  const server = useServer()
  const configurable = () => server.projects.configurationAvailable()
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
              <ProjectSettingsHeader project={row()} />
              <Show when={row().missingCheckout}>{(checkout) => <MissingCheckoutSection id={props.id} checkout={checkout()} />}</Show>
              <ProjectFields project={row()} editable={configurable()} />
              <WhereItRuns project={row()} />
              <ProjectEnvironmentSection project={row()} />
              <Show when={configurable()}>
                <ProjectRemoval id={props.id} name={row().name} />
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
