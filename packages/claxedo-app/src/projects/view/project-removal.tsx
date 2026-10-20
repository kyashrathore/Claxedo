import { useNavigate } from "@solidjs/router"
import { Show, type JSX } from "solid-js"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, type AppError, type ProjectId } from "@/server"
import { SettingsList, SettingsNote, SettingsRow } from "@/settings"
import { Button, requestConfirm, useDialog } from "@/ui"
import { useProjectsText, type ProjectsText } from "../i18n"
import { projectSettingsPath } from "../routes"
import { useProjectCommands } from "../store"

function removalMessage(t: ProjectsText, error: AppError): string {
  return error.class === "conflict" ? `${error.message} ${t("projects.remove.cloudFirst")}` : error.message
}

export function ProjectRemoval(props: { readonly id: ProjectId; readonly name: string }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const navigate = useNavigate()
  const commands = useProjectCommands()
  const removal = createFlow<"removing", void>()
  const removing = () => removal.state().kind === "running"
  const failure = () => {
    const state = removal.state()
    return state.kind === "failed" ? removalMessage(t, state.error) : undefined
  }
  const remove = async () => {
    const confirmed = await requestConfirm(dialog, {
      title: t("projects.remove.title"),
      body: t("projects.remove.confirm", { name: props.name }),
      confirmLabel: t("projects.remove"),
      cancelLabel: t("projects.cancel"),
      destructive: true,
    })
    if (!confirmed || removing()) return
    await runFlow(removal, "removing", () => commands.remove(props.id), toAppError)
    if (removal.state().kind === "done") navigate(projectSettingsPath())
  }
  return (
    <>
      <SettingsList>
        <SettingsRow title={t("projects.remove.title")} description={t("projects.settings.remove.description")}>
          <Button variant="neutral" size="small" disabled={removing()} onClick={() => void remove()}>
            {t("projects.remove")}
          </Button>
        </SettingsRow>
      </SettingsList>
      <Show when={failure()}>{(message) => <SettingsNote tone="danger">{message()}</SettingsNote>}</Show>
    </>
  )
}
