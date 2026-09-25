import { createMemo, createSignal, Show, type Accessor, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { codeHostConnections, codeHostIntegrations, toAppError, useServer, type Project, type ProjectSource } from "@/server"
import { useProjectsText } from "../i18n"
import { ConnectCodeHost } from "./project-create-connect"
import { AccountSelect, createFormLook, RepositoryList, UrlField, type CreateFormLook } from "./project-create-repository"
import { ClaxedoIcon as Icon, Button } from "@/ui"

type Submit =
  | { onSubmit: (source: ProjectSource, name: string | undefined) => void | Promise<void>; submitLabel?: string; onCreated?: undefined }
  | { onSubmit?: undefined; onCreated: (project: Project) => void }

export type ProjectCreateFormProps = {
  size?: "compact" | "comfortable"
  localExecution: boolean
  pickFolder?: () => Promise<string | undefined>
  onCancel?: () => void
} & Submit

function FolderField(props: { look: CreateFormLook; folder: string; onChoose: () => void }) {
  const t = useProjectsText()
  const text = () => (props.look.comfortable ? "text-14-regular" : "text-13-regular")
  return (
    <div class="flex flex-col gap-1">
      <span class={props.look.label}>{t("projects.add.folder")}</span>
      <button
        type="button"
        aria-label={t("projects.create.folder.choose")}
        title={props.folder || undefined}
        class={`${props.look.box} flex w-full min-w-0 items-center gap-2 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none`}
        onClick={() => props.onChoose()}
      >
        <Icon name="folder" size="small" class="shrink-0 text-icon-weak-base" />
        <Show when={props.folder} fallback={<span class={`min-w-0 flex-1 truncate ${text()} text-text-weak/60`}>{t("projects.create.folder.placeholder")}</span>}>
          <span class={`min-w-0 flex-1 truncate font-mono text-text-strong ${props.look.comfortable ? "text-13-regular" : "text-12-regular"}`}>
            {props.folder}
          </span>
        </Show>
        <span class={`shrink-0 ${props.look.comfortable ? "text-12-medium" : "text-11-medium"} text-text-weak`}>
          {props.folder ? t("projects.create.folder.change") : t("projects.add.folder.browse")}
        </span>
      </button>
      <span class={props.look.hint}>{t("projects.create.folder.hint")}</span>
    </div>
  )
}

function NameField(props: { look: CreateFormLook; name: string; onName: (name: string) => void }) {
  const t = useProjectsText()
  return (
    <label class="flex flex-col gap-1">
      <span class={props.look.label}>{t("projects.add.name")}</span>
      <input type="text" value={props.name} onInput={(event) => props.onName(event.currentTarget.value)} aria-label={t("projects.add.name")} spellcheck={false} class={props.look.field} />
      <span class={props.look.hint}>{t("projects.add.name.hint")}</span>
    </label>
  )
}

function createRepositoryChoice(active: Accessor<boolean>) {
  const server = useServer()
  const offered = useQuery(() => ({ ...server.queries.integrations.catalog(), enabled: active() }))
  const integration = () => codeHostIntegrations(offered.data)[0]
  const usable = createMemo(() => codeHostConnections(offered.data).filter((connection) => connection.status !== "broken"))
  const [chosenId, setChosenId] = createSignal<string>()
  const connection = createMemo(() => usable().find((item) => item.id === chosenId()) ?? usable()[0])
  const [entry, setEntry] = createSignal<"list" | "url">("list")
  const view = (): "checking" | "url" | "connect" | "list" => {
    if (offered.isPending) return "checking"
    if (!integration() || entry() === "url") return "url"
    return connection() ? "list" : "connect"
  }
  const repositories = useQuery(() => {
    const id = connection()?.id ?? ""
    return { ...server.queries.codeHost.repositories(id), enabled: active() && view() === "list" && id !== "" }
  })
  return { integration, usable, connection, setChosenId, entry, setEntry, view, repositories }
}

type RepositoryChoice = ReturnType<typeof createRepositoryChoice>

function RepositorySection(props: {
  look: CreateFormLook
  choice: RepositoryChoice
  url: string
  onUrl: (url: string) => void
  query: string
  onQuery: (query: string) => void
  selected: string | undefined
  onSelect: (fullName: string) => void
  onEntry: () => void
}): JSX.Element {
  const t = useProjectsText()
  const host = () => props.choice.integration()?.name
  return (
    <div class="flex flex-col gap-3">
      <Show when={props.choice.view() === "checking"}>
        <span class={props.look.hint}>{t("projects.create.checking")}</span>
      </Show>
      <Show when={props.choice.view() === "connect" ? props.choice.integration() : undefined}>
        {(integration) => <ConnectCodeHost look={props.look} integration={integration()} />}
      </Show>
      <Show when={props.choice.view() === "list" ? props.choice.connection() : undefined}>
        {(connection) => (
          <>
            <Show when={props.choice.usable().length > 1}>
              <AccountSelect connections={props.choice.usable()} current={connection()} onSelect={props.choice.setChosenId} />
            </Show>
            <RepositoryList
              look={props.look}
              repositories={props.choice.repositories.data}
              loading={props.choice.repositories.isPending}
              error={props.choice.repositories.error}
              query={props.query}
              onQuery={props.onQuery}
              selected={props.selected}
              onSelect={props.onSelect}
            />
          </>
        )}
      </Show>
      <Show when={props.choice.view() === "url"}>
        <UrlField look={props.look} url={props.url} onUrl={props.onUrl} host={host()} />
      </Show>
      <Show when={host()}>
        {(name) => (
          <button type="button" class={`${props.look.link} self-start`} onClick={() => props.onEntry()}>
            {props.choice.entry() === "url" ? t("projects.create.choose", { host: name() }) : t("projects.add.pasteUrl")}
          </button>
        )}
      </Show>
    </div>
  )
}

function createFormState(props: ProjectCreateFormProps) {
  const [name, setName] = createSignal("")
  const [folder, setFolder] = createSignal("")
  const [repoUrl, setRepoUrl] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [source, setSource] = createSignal<"folder" | "repository">("folder")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const offersFolder = () => props.localExecution && Boolean(props.pickFolder)
  const mode = () => (offersFolder() ? source() : "repository")
  const choice = createRepositoryChoice(() => mode() === "repository")
  const chosen = (): ProjectSource | undefined => {
    if (mode() === "folder") return folder() ? { kind: "folder", path: folder() } : undefined
    const connection = choice.connection()
    if (choice.view() === "list") return connection && selected() ? { kind: "connectedRepository", connectionId: connection.id, fullName: selected() ?? "" } : undefined
    if (choice.view() !== "url") return undefined
    return repoUrl().trim() ? { kind: "repository", url: repoUrl().trim() } : undefined
  }
  return { name, setName, folder, setFolder, repoUrl, setRepoUrl, busy, setBusy, error, setError, source, setSource, query, setQuery, selected, setSelected, offersFolder, mode, choice, chosen }
}

export function ProjectCreateForm(props: ProjectCreateFormProps) {
  const t = useProjectsText()
  const server = useServer()
  const form = createFormState(props)
  const look = createMemo(() => createFormLook(props.size === "comfortable"))
  const canSubmit = () => !form.busy() && Boolean(form.chosen())
  const submit = async (event: Event) => {
    event.preventDefault()
    const picked = form.chosen()
    if (!picked || !canSubmit()) return
    const name = form.name().trim() || undefined
    form.setBusy(true)
    form.setError("")
    try {
      if (props.onSubmit) return void (await props.onSubmit(picked, name))
      props.onCreated(await server.projects.create({ source: picked, ...(name ? { name } : {}) }))
    } catch (cause) {
      form.setError(toAppError(cause).message)
    } finally {
      form.setBusy(false)
    }
  }
  const chooseFolder = async () => {
    const picked = await props.pickFolder?.()
    if (picked) form.setFolder(picked)
  }
  const submitLabel = () => (props.onSubmit ? (props.submitLabel ?? t("projects.create.continue")) : form.busy() ? t("projects.create.creating") : t("projects.add.create"))
  const control = (): "normal" | "small" => (look().comfortable ? "normal" : "small")
  return (
    <form onSubmit={(event) => void submit(event)} class={look().comfortable ? "flex w-full flex-col gap-4" : "flex w-[340px] max-w-full flex-col gap-3"}>
      <Show when={form.offersFolder()}>
        <div class="-mb-2 flex justify-end">
          <button
            type="button"
            class={look().link}
            onClick={() => {
              form.setError("")
              form.setSource(form.source() === "folder" ? "repository" : "folder")
            }}
          >
            {form.mode() === "folder" ? t("projects.create.clone") : t("projects.create.folderInstead")}
          </button>
        </div>
      </Show>
      <Show
        when={form.mode() === "folder"}
        fallback={
          <RepositorySection
            look={look()}
            choice={form.choice}
            url={form.repoUrl()}
            onUrl={form.setRepoUrl}
            query={form.query()}
            onQuery={form.setQuery}
            selected={form.selected()}
            onSelect={form.setSelected}
            onEntry={() => {
              form.setError("")
              form.choice.setEntry(form.choice.entry() === "url" ? "list" : "url")
            }}
          />
        }
      >
        <FolderField look={look()} folder={form.folder()} onChoose={() => void chooseFolder()} />
      </Show>
      <NameField look={look()} name={form.name()} onName={form.setName} />
      <Show when={form.error()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          {form.error()}
        </p>
      </Show>
      <div class="flex justify-end gap-2 pt-1">
        <Show when={props.onCancel}>
          <Button type="button" variant="ghost" size={control()} onClick={() => props.onCancel?.()}>
            {t("projects.cancel")}
          </Button>
        </Show>
        <Button type="submit" variant="primary" size={control()} disabled={!canSubmit()}>
          {submitLabel()}
        </Button>
      </div>
    </form>
  )
}
