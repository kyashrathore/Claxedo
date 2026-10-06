import { createMemo, createSignal, Show, type Accessor, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { codeHostConnections, codeHostIntegrations, toAppError, useServer, type Project, type ProjectSource } from "@/server"
import { Button, ClaxedoIcon as Icon, SegmentedControl, SegmentedControlItem, TextField } from "@/ui"
import { useProjectsText } from "../i18n"
import { draftProjectName } from "../project-source"
import { ConnectCodeHost } from "./project-create-connect"
import { AccountSelect, FIELD_BOX, RepositoryList } from "./project-create-repository"

type Submit =
  | { onSubmit: (source: ProjectSource, name: string | undefined) => void | Promise<void>; submitLabel?: string; onCreated?: undefined }
  | { onSubmit?: undefined; onCreated: (project: Project) => void }

export type ProjectCreateFormProps = {
  folderMachine?: string
  namedByRepository?: boolean
  pickFolder?: () => Promise<string | undefined>
  onCancel?: () => void
} & Submit

type SourceMode = "folder" | "repository"
type RepositoryEntry = "list" | "url"

function FolderField(props: { machine: string; folder: string; onChoose: () => void }) {
  const t = useProjectsText()
  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-[length:var(--font-size-intermediate)] font-medium text-text-weak">{t("projects.create.folder.label", { machine: props.machine })}</span>
      <button
        type="button"
        aria-label={t("projects.create.folder.choose")}
        title={props.folder || undefined}
        class={`${FIELD_BOX} flex w-full min-w-0 items-center gap-2 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none`}
        onClick={() => props.onChoose()}
      >
        <Icon name="folder" size="small" class="shrink-0 text-icon-weak-base" />
        <span class="min-w-0 flex-1 truncate font-mono text-13-regular" classList={{ "text-text-strong": !!props.folder, "text-text-weak": !props.folder }}>
          {props.folder || t("projects.create.folder.placeholder")}
        </span>
        <span class="shrink-0 text-12-medium text-text-weak">{props.folder ? t("projects.create.folder.change") : t("projects.add.folder.browse")}</span>
      </button>
    </div>
  )
}

function createRepositoryChoice(active: Accessor<boolean>) {
  const server = useServer()
  const connectionsServed = () => server.capabilities()?.features.connections === true
  const offered = useQuery(() => ({ ...server.queries.integrations.codeHosts(), enabled: active() && connectionsServed() }))
  const integration = () => codeHostIntegrations(offered.data)[0]
  const usable = createMemo(() => codeHostConnections(offered.data).filter((connection) => connection.status !== "broken"))
  const [chosenId, setChosenId] = createSignal<string>()
  const connection = createMemo(() => usable().find((item) => item.id === chosenId()) ?? usable()[0])
  const [entry, setEntry] = createSignal<RepositoryEntry>("list")
  const view = (): "checking" | "url" | "connect" | "list" | "failed" => {
    if (!connectionsServed()) return "url"
    if (offered.isPending) return "checking"
    if (offered.error) return "failed"
    if (!integration()) return "url"
    if (entry() === "url") return "url"
    return connection() ? "list" : "connect"
  }
  const repositories = useQuery(() => {
    const id = connection()?.id ?? ""
    return { ...server.queries.codeHost.repositories(id), enabled: active() && view() === "list" && id !== "" }
  })
  const switchable = () => integration() !== undefined
  return { integration, usable, connection, setChosenId, entry, setEntry, view, repositories, switchable, error: () => offered.error, retry: () => offered.refetch() }
}

type RepositoryChoice = ReturnType<typeof createRepositoryChoice>

function RepositoryStatus(props: { choice: RepositoryChoice }): JSX.Element {
  const t = useProjectsText()
  return (
    <>
      <Show when={props.choice.view() === "checking"}>
        <span class="text-12-regular text-text-weak">{t("projects.create.checking")}</span>
      </Show>
      <Show when={props.choice.view() === "failed"}>
        <p role="alert" class="text-12-regular text-icon-warning-base">{toAppError(props.choice.error()).message}</p>
        <Button type="button" variant="neutral" class="self-start" onClick={() => void props.choice.retry()}>{t("projects.create.retry")}</Button>
      </Show>
      <Show when={props.choice.view() === "connect" ? props.choice.integration() : undefined}>
        {(integration) => <ConnectCodeHost integration={integration()} />}
      </Show>
    </>
  )
}

function RepositorySection(props: { choice: RepositoryChoice; url: string; onUrl: (url: string) => void; query: string; onQuery: (query: string) => void; selected: string | undefined; onSelect: (fullName: string) => void }): JSX.Element {
  const t = useProjectsText()
  const host = () => props.choice.integration()?.name
  return (
    <div class="flex flex-col gap-3">
      <Show when={props.choice.switchable() ? host() : undefined}>
        {(name) => (
          <SegmentedControl class="segmented-control-v2--fit" aria-label={t("projects.create.entry")} value={props.choice.entry()} onChange={(value) => (value === "list" || value === "url") && props.choice.setEntry(value)}>
            <SegmentedControlItem value="list">{t("projects.create.choose", { host: name() })}</SegmentedControlItem>
            <SegmentedControlItem value="url">{t("projects.add.pasteUrl")}</SegmentedControlItem>
          </SegmentedControl>
        )}
      </Show>
      <RepositoryStatus choice={props.choice} />
      <Show when={props.choice.view() === "list" ? props.choice.connection() : undefined}>
        {(connection) => (
          <>
            <Show when={props.choice.usable().length > 1}>
              <AccountSelect connections={props.choice.usable()} current={connection()} onSelect={props.choice.setChosenId} />
            </Show>
            <RepositoryList repositories={props.choice.repositories.data} loading={props.choice.repositories.isPending} error={props.choice.repositories.error} query={props.query} onQuery={props.onQuery} selected={props.selected} onSelect={props.onSelect} />
          </>
        )}
      </Show>
      <Show when={props.choice.view() === "url"}>
        <TextField
          label={t("projects.add.url")}
          description={host() && props.choice.connection() ? t("projects.create.url.hint.host", { host: host() ?? "" }) : t("projects.create.url.hint.none")}
          placeholder={t("projects.create.url.placeholder")}
          value={props.url}
          onChange={props.onUrl}
          spellcheck={false}
        />
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
  const [source, setSource] = createSignal<SourceMode>("folder")
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string>()
  const offersFolder = () => props.folderMachine !== undefined && Boolean(props.pickFolder)
  const mode = (): SourceMode => (offersFolder() ? source() : "repository")
  const choice = createRepositoryChoice(() => mode() === "repository")
  const chosen = (): ProjectSource | undefined => {
    if (mode() === "folder") return folder() ? { kind: "folder", path: folder() } : undefined
    const connection = choice.connection()
    if (choice.view() === "list") return connection && selected() ? { kind: "connectedRepository", connectionId: connection.id, fullName: selected() ?? "" } : undefined
    if (choice.view() !== "url") return undefined
    return repoUrl().trim() ? { kind: "repository", url: repoUrl().trim() } : undefined
  }
  return { name, setName, folder, setFolder, repoUrl, setRepoUrl, busy, setBusy, error, setError, setSource, query, setQuery, selected, setSelected, offersFolder, mode, choice, chosen }
}

type FormState = ReturnType<typeof createFormState>

function SourceSwitch(props: { form: FormState }) {
  const t = useProjectsText()
  return (
    <SegmentedControl
      class="segmented-control-v2--fit"
      aria-label={t("projects.create.source")}
      value={props.form.mode()}
      onChange={(value) => {
        if (value !== "folder" && value !== "repository") return
        props.form.setError("")
        props.form.setSource(value)
      }}
    >
      <SegmentedControlItem value="folder">{t("projects.create.source.folder")}</SegmentedControlItem>
      <SegmentedControlItem value="repository">{t("projects.create.source.repository")}</SegmentedControlItem>
    </SegmentedControl>
  )
}

function useProjectCreateSubmit(props: ProjectCreateFormProps, form: FormState) {
  const server = useServer()
  return async (event: Event) => {
    event.preventDefault()
    const picked = form.chosen()
    if (!picked || form.busy()) return
    const name = form.name().trim() || undefined
    form.setBusy(true)
    form.setError("")
    try {
      if (props.onSubmit) return await props.onSubmit(picked, name)
      props.onCreated(await server.projects.create({ source: picked, ...(name ? { name } : {}) }))
    } catch (cause) {
      form.setError(toAppError(cause).message)
    } finally {
      form.setBusy(false)
    }
  }
}

export function ProjectCreateForm(props: ProjectCreateFormProps) {
  const t = useProjectsText()
  const form = createFormState(props)
  const submit = useProjectCreateSubmit(props, form)
  const chooseFolder = async () => {
    const picked = await props.pickFolder?.()
    if (picked) form.setFolder(picked)
  }
  const submitLabel = () => (props.onSubmit ? (props.submitLabel ?? t("projects.create.continue")) : form.busy() ? t("projects.create.creating") : t("projects.add.create"))
  const namePlaceholder = () => {
    const picked = form.chosen()
    return picked ? draftProjectName(picked) : ""
  }
  return (
    <form onSubmit={(event) => void submit(event)} class="flex w-full flex-col gap-4">
      <Show when={form.offersFolder()}>
        <SourceSwitch form={form} />
      </Show>
      <Show
        when={form.mode() === "folder" ? props.folderMachine : undefined}
        fallback={
          <RepositorySection choice={form.choice} url={form.repoUrl()} onUrl={form.setRepoUrl} query={form.query()} onQuery={form.setQuery} selected={form.selected()} onSelect={form.setSelected} />
        }
      >
        {(machine) => <FolderField machine={machine()} folder={form.folder()} onChoose={() => void chooseFolder()} />}
      </Show>
      <Show when={!props.namedByRepository}>
        <TextField label={t("projects.add.name")} placeholder={namePlaceholder()} value={form.name()} onChange={form.setName} spellcheck={false} />
      </Show>
      <Show when={form.error()}>
        <p class="text-12-regular text-icon-warning-base" role="alert">{form.error()}</p>
      </Show>
      <div class="flex justify-end gap-2 pt-1">
        <Show when={props.onCancel}>
          <Button type="button" variant="ghost" size="normal" onClick={() => props.onCancel?.()}>{t("projects.cancel")}</Button>
        </Show>
        <Button type="submit" variant="contrast" size="normal" disabled={form.busy() || !form.chosen()}>{submitLabel()}</Button>
      </div>
    </form>
  )
}
