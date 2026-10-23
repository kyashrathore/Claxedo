import { createMemo, createSignal, Show } from "solid-js"
import { useErrorCopy, useI18n, useTranslator } from "@/i18n"
import { useServer, type MintedInvitation, type ServerConnectCommands } from "@/server"
import { Button, Tabs, TextField } from "@/ui"
import { settingsDictionary } from "../i18n"
import { createServerCommand, isServerFolder } from "../server-invitation"
import { CommandLine } from "./command-line"

type CommandForm = keyof ServerConnectCommands

const FORMS: readonly CommandForm[] = ["cloudInit", "posix", "windows"]

const isCommandForm = (value: string): value is CommandForm => (FORMS as readonly string[]).includes(value)

function ServerCommands(props: { readonly invitation: MintedInvitation }) {
  const t = useTranslator(settingsDictionary)
  const i18n = useI18n()
  const [form, setForm] = createSignal<CommandForm>("cloudInit")
  const until = createMemo(() => new Intl.DateTimeFormat(i18n.intlTag(), { hour: "numeric", minute: "2-digit" }).format(props.invitation.expiresAt))
  return (
    <>
      <Tabs class="settings-connect-method" value={form()} onChange={(value) => isCommandForm(value) && setForm(value)}>
        <Tabs.List aria-label={t("settings.machines.server.form")}>
          <Tabs.Trigger value="cloudInit">{t("settings.machines.server.cloudInit")}</Tabs.Trigger>
          <Tabs.Trigger value="posix">{t("settings.machines.connect.posix")}</Tabs.Trigger>
          <Tabs.Trigger value="windows">{t("settings.machines.connect.windows")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="cloudInit" forceMount class="settings-connect-panel">
          <CommandLine command={props.invitation.commands.cloudInit} label={t("settings.machines.server.copySnippet")} snippet />
        </Tabs.Content>
        <Tabs.Content value="posix" forceMount class="settings-connect-panel">
          <CommandLine command={props.invitation.commands.posix} label={t("settings.machines.connect.copy")} />
        </Tabs.Content>
        <Tabs.Content value="windows" forceMount class="settings-connect-panel">
          <CommandLine command={props.invitation.commands.windows} label={t("settings.machines.connect.copy")} />
        </Tabs.Content>
      </Tabs>
      <p class="settings-row-description">{t("settings.machines.server.validUntil", { time: until() })}</p>
    </>
  )
}

export function ServerConnect() {
  const t = useTranslator(settingsDictionary)
  const errorCopy = useErrorCopy("machines")
  const server = useServer()
  const command = createServerCommand(server.machines)
  const [name, setName] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    command.edited()
  }
  const minting = () => command.state().kind === "minting"
  const minted = () => {
    const state = command.state()
    return state.kind === "minted" ? state.invitation : undefined
  }
  const failure = () => {
    const state = command.state()
    return state.kind === "failed" ? state.error : undefined
  }
  return (
    <section class="settings-server-connect" aria-label={t("settings.machines.server.title")}>
      <span class="settings-row-title">{t("settings.machines.server.title")}</span>
      <span class="settings-row-description">{t("settings.machines.server.description")}</span>
      <TextField label={t("settings.machines.server.name")} value={name()} onChange={edit(setName)} autocomplete="off" />
      <TextField label={t("settings.machines.server.folder")} placeholder="/srv/app" value={folder()} onChange={edit(setFolder)} autocomplete="off" />
      <span class="settings-row-description">{t("settings.machines.server.folderHint")}</span>
      <div class="settings-inline">
        <Button size="small" variant="neutral" disabled={minting() || !isServerFolder(folder())} onClick={() => void command.mint({ name: name(), folder: folder() })}>
          {t(minting() ? "settings.machines.server.minting" : "settings.machines.server.mint")}
        </Button>
      </div>
      <Show when={failure()}>
        {(error) => <p class="settings-note" data-tone="danger" role="alert">{t("settings.machines.server.mintFailed", { reason: errorCopy(error()).title })}</p>}
      </Show>
      <Show when={minted()} keyed>
        {(invitation) => <ServerCommands invitation={invitation} />}
      </Show>
    </section>
  )
}
