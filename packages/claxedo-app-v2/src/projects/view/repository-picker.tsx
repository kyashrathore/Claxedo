import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useProjectsServer, type CodeHostConnection } from "../api"
import type { AddProjectFlow } from "../add-project"
import { projectsText } from "../i18n"

const UrlField: Component<{ url: string; onUrl: (url: string) => void; hint: string }> = (props) => (
  <label class="flex flex-col gap-1">
    <span class="projects-label">{projectsText("projects.add.url")}</span>
    <input
      type="url"
      class="projects-field"
      value={props.url}
      placeholder="https://github.com/owner/repo"
      aria-label={projectsText("projects.add.url")}
      spellcheck={false}
      onInput={(event) => props.onUrl(event.currentTarget.value)}
    />
    <span class="projects-hint">{props.hint}</span>
  </label>
)

const RepositoryList: Component<{ flow: AddProjectFlow; connection: CodeHostConnection }> = (props) => {
  const server = useProjectsServer()
  const repositories = useQuery(() => server.queries.codeHost.repositories(props.connection.id))
  const [query, setQuery] = createSignal("")
  const matches = createMemo(() => {
    const needle = query().trim().toLowerCase()
    const all = repositories.data ?? []
    return needle ? all.filter((repository) => repository.fullName.toLowerCase().includes(needle)) : all
  })
  const selected = () => {
    const source = props.flow.draft.source
    return source?.kind === "connectedRepository" ? source.fullName : undefined
  }

  return (
    <div class="flex flex-col gap-2">
      <input
        type="search"
        class="projects-field"
        value={query()}
        placeholder={projectsText("projects.add.search")}
        aria-label={projectsText("projects.add.search")}
        autocomplete="off"
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      <div role="radiogroup" aria-label={projectsText("projects.add.repositories")} class="projects-list">
        <Show when={repositories.isPending}>
          <span class="projects-hint projects-placeholder px-3 py-2">{projectsText("projects.add.repositories.loading")}</span>
        </Show>
        <Show when={repositories.error}>
          {(error) => (
            <p class="projects-alert px-3 py-2" role="alert">
              {projectsText("projects.add.repositories.failed")}: {error().message}
            </p>
          )}
        </Show>
        <Show when={repositories.data && matches().length === 0}>
          <span class="projects-hint px-3 py-2">{projectsText("projects.add.repositories.empty")}</span>
        </Show>
        <For each={matches()}>
          {(repository) => (
            <button
              type="button"
              role="radio"
              aria-checked={selected() === repository.fullName}
              onClick={() =>
                props.flow.setDraft("source", {
                  kind: "connectedRepository",
                  connectionId: props.connection.id,
                  fullName: repository.fullName,
                })
              }
            >
              <span class="min-w-0 flex-1 truncate">{repository.fullName}</span>
              <Show when={repository.private}>
                <span class="projects-hint shrink-0">{projectsText("projects.add.private")}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

export const RepositoryPicker: Component<{
  flow: AddProjectFlow
  pasting: boolean
  onPasting: (pasting: boolean) => void
  onConnected: (connected: boolean) => void
  url: string
  onUrl: (url: string) => void
}> = (props) => {
  const server = useProjectsServer()
  const connections = useQuery(() => server.queries.codeHost.connections())
  const usable = createMemo(() => (connections.data ?? []).filter((connection) => connection.status !== "broken"))
  const [chosenId, setChosenId] = createSignal<string>()
  const connection = createMemo(() => usable().find((item) => item.id === chosenId()) ?? usable()[0])
  createEffect(() => props.onConnected(connection() !== undefined))
  const accountLabel = (item: CodeHostConnection) => item.accountLabel ?? item.providerName

  return (
    <div class="flex flex-col gap-3" data-slot="repository-picker">
      <Show when={connections.isPending}>
        <span class="projects-hint projects-placeholder">{projectsText("projects.loading")}</span>
      </Show>
      <Show when={connection() && !props.pasting} fallback={<UrlField url={props.url} onUrl={props.onUrl} hint={connection() ? projectsText("projects.add.url.hint") : projectsText("projects.add.connect.hint")} />}>
        {(_) => (
          <>
            <Show when={usable().length > 1}>
              <label class="flex flex-col gap-1">
                <span class="projects-label">{projectsText("projects.add.account")}</span>
                <select class="projects-field" value={connection()?.id} onChange={(event) => setChosenId(event.currentTarget.value)}>
                  <For each={usable()}>{(item) => <option value={item.id}>{accountLabel(item)}</option>}</For>
                </select>
              </label>
            </Show>
            <RepositoryList flow={props.flow} connection={connection()!} />
          </>
        )}
      </Show>
      <Show when={connection()}>
        {(item) => (
          <button type="button" class="projects-hint min-h-11 self-start underline underline-offset-2" onClick={() => props.onPasting(!props.pasting)}>
            {props.pasting ? projectsText("projects.add.chooseFromAccount", { account: accountLabel(item()) }) : projectsText("projects.add.pasteUrl")}
          </button>
        )}
      </Show>
    </div>
  )
}
