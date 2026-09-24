import { createMemo, createSignal, For, Match, Show, Switch, type Component } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type CodeHostConnection, type ProjectSource } from "@/server"
import { Field, RadioGroup, RadioItem, Select, TextInput } from "@/ui"
import { useProjectsText } from "../i18n"

type RepositorySource = Extract<ProjectSource, { kind: "repository" | "connectedRepository" }>

function urlSource(url: string): RepositorySource | undefined {
  const trimmed = url.trim()
  return trimmed ? { kind: "repository", url: trimmed } : undefined
}

function accountLabel(connection: CodeHostConnection): string {
  return connection.accountLabel ?? connection.providerName
}

const UrlField: Component<{ url: string; onUrl: (url: string) => void; hint: string }> = (props) => {
  const t = useProjectsText()
  return (
    <Field>
      <Field.Label>{t("projects.add.url")}</Field.Label>
      <Field.Control>
        <TextInput
          type="url"
          value={props.url}
          placeholder="https://github.com/owner/repo"
          spellcheck={false}
          onInput={(event) => props.onUrl(event.currentTarget.value)}
        />
      </Field.Control>
      <span class="projects-hint">{props.hint}</span>
    </Field>
  )
}

const RepositoryList: Component<{
  connection: CodeHostConnection
  selected: string | undefined
  onPick: (fullName: string) => void
}> = (props) => {
  const t = useProjectsText()
  const server = useServer()
  const repositories = useQuery(() => server.queries.codeHost.repositories(props.connection.id))
  const [query, setQuery] = createSignal("")
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const all = repositories.data ?? []
    return needle ? all.filter((repository) => repository.fullName.toLowerCase().includes(needle)) : all
  })

  return (
    <div class="flex flex-col gap-2">
      <TextInput
        type="search"
        value={query()}
        placeholder={t("projects.add.search")}
        aria-label={t("projects.add.search")}
        autocomplete="off"
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <Switch>
        <Match when={repositories.isPending}>
          <span class="projects-hint projects-placeholder">{t("projects.add.repositories.loading")}</span>
        </Match>
        <Match when={repositories.error}>
          {(error) => (
            <p class="projects-alert m-0" role="alert">
              {t("projects.add.repositories.failed")}: {error().message}
            </p>
          )}
        </Match>
        <Match when={repositories.data}>
          <RadioGroup class="projects-choices" aria-label={t("projects.add.repositories")} value={props.selected ?? ""} onChange={props.onPick}>
            <For each={matches()} fallback={<span class="projects-hint">{t("projects.add.repositories.empty")}</span>}>
              {(repository) => (
                <RadioItem value={repository.fullName} label={repository.fullName} description={repository.private ? t("projects.add.private") : undefined} />
              )}
            </For>
          </RadioGroup>
        </Match>
      </Switch>
    </div>
  )
}

export const RepositoryPicker: Component<{
  source: ProjectSource | undefined
  onSource: (source: ProjectSource | undefined) => void
}> = (props) => {
  const t = useProjectsText()
  const server = useServer()
  const connections = useQuery(() => server.queries.codeHost.connections())
  const usable = createMemo(() => (connections.data ?? []).filter((connection) => connection.status !== "broken"))
  const [chosenId, setChosenId] = createSignal<string>()
  const connection = createMemo(() => usable().find((item) => item.id === chosenId()) ?? usable()[0])
  const [url, setUrl] = createSignal(props.source?.kind === "repository" ? props.source.url : "")
  const [pasting, setPasting] = createSignal(props.source?.kind === "repository")
  const showList = () => connection() !== undefined && !pasting()
  const picked = () => (props.source?.kind === "connectedRepository" ? props.source.fullName : undefined)

  const typeUrl = (value: string) => {
    setUrl(value)
    setPasting(true)
    props.onSource(urlSource(value))
  }
  const togglePasting = () => {
    const next = !pasting()
    setPasting(next)
    props.onSource(next ? urlSource(url()) : undefined)
  }
  const pick = (item: CodeHostConnection, fullName: string) =>
    props.onSource({ kind: "connectedRepository", connectionId: item.id, fullName })

  return (
    <div class="flex flex-col gap-3" data-slot="repository-picker">
      <Show when={connections.isPending}>
        <span class="projects-hint projects-placeholder">{t("projects.loading")}</span>
      </Show>
      <Show
        when={showList() ? connection() : undefined}
        fallback={<UrlField url={url()} onUrl={typeUrl} hint={connection() ? t("projects.add.url.hint") : t("projects.add.connect.hint")} />}
      >
        {(item) => (
          <>
            <Show when={usable().length > 1}>
              <Field>
                <Field.Label>{t("projects.add.account")}</Field.Label>
                <Select options={usable()} current={item()} value={(candidate) => candidate.id} label={accountLabel} onSelect={(next) => setChosenId(next?.id)} />
              </Field>
            </Show>
            <RepositoryList connection={item()} selected={picked()} onPick={(fullName) => pick(item(), fullName)} />
          </>
        )}
      </Show>
      <Show when={connection()}>
        {(item) => (
          <button type="button" class="projects-link" onClick={togglePasting}>
            {pasting() ? t("projects.add.chooseFromAccount", { account: accountLabel(item()) }) : t("projects.add.pasteUrl")}
          </button>
        )}
      </Show>
    </div>
  )
}
