import { Match, Show, Switch, type JSX } from "solid-js"
import { useErrorCopy } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { Project } from "@/server"
import { SettingsGroup, SettingsList, SettingsListSkeleton, SettingsRow } from "@/settings"
import { Button, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { useProjectEnvironment } from "../store"
import { DrawerProjectEnvironment } from "./project-environment-drawer"

export function ProjectEnvironmentSection(props: { readonly project: Project }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const errorCopy = useErrorCopy("projects")
  const environment = useProjectEnvironment(() => props.project.id)
  const ready = () => {
    const state = environment.state()
    return state.kind === "ready" ? state.data : undefined
  }
  const failed = () => {
    const state = environment.state()
    return state.kind === "failed" ? state.error : undefined
  }
  const editable = () => (ready()?.editable ? ready() : undefined)
  return (
    <SettingsGroup
      title={t("projects.environment.title")}
      description={t("projects.environment.summary")}
      action={
        <Show when={editable()}>
          {(loaded) => (
            <Button
              variant="neutral"
              size="small"
              data-testid="project-environment-edit"
              onClick={() => dialog.show(() => <DrawerProjectEnvironment project={props.project} names={loaded().names} />)}
            >
              {t("projects.environment.edit")}
            </Button>
          )}
        </Show>
      }
    >
      <Switch fallback={<SettingsListSkeleton rows={1} />}>
        <Match when={ready()}>
          {(loaded) => (
            <SettingsList>
              <SettingsRow title={t("projects.edit.environment")} description={loaded().names.join(", ") || t("projects.settings.none")} />
            </SettingsList>
          )}
        </Match>
        <Match when={failed()}>
          {(error) => <FailureNotice title={t("projects.environment.failed")} message={errorCopy(error()).message} retryLabel={errorCopy(error()).retry} onRetry={environment.retry} />}
        </Match>
      </Switch>
    </SettingsGroup>
  )
}
