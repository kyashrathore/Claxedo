import { createMemo, For, Show, type JSX } from "solid-js"
import type { AppError, CodeHostConnection, CodeHostRepository } from "@/server"
import { Field, Select } from "@/ui"
import { useProjectsText } from "../i18n"

export const FIELD_BOX = "h-10 rounded-lg border border-border-base bg-surface-inset-base px-3"

export function AccountSelect(props: { connections: readonly CodeHostConnection[]; current: CodeHostConnection; onSelect: (id: string) => void }) {
  const t = useProjectsText()
  const label = (connection: CodeHostConnection) => connection.accountLabel ?? connection.providerName
  return (
    <Field>
      <Field.Label>{t("projects.add.account")}</Field.Label>
      <Select
        options={[...props.connections]}
        current={props.current}
        value={(item) => item.id}
        label={label}
        onSelect={(next) => next && props.onSelect(next.id)}
        triggerProps={{ "aria-label": t("projects.add.account") }}
      />
    </Field>
  )
}

type RepositoryListProps = {
  repositories: readonly CodeHostRepository[] | undefined
  loading: boolean
  error: AppError | null
  query: string
  onQuery: (query: string) => void
  selected: string | undefined
  onSelect: (fullName: string) => void
}

function RepositoryRows(props: RepositoryListProps & { matches: readonly CodeHostRepository[] }): JSX.Element {
  const t = useProjectsText()
  const row = () => "text-13-regular"
  return (
    <>
      <Show when={props.loading}>
        <span class={`px-2.5 py-2 ${row()} text-text-weak`}>{t("projects.add.repositories.loading")}</span>
      </Show>
      <Show when={props.error}>
        {(error) => (
          <p class={`px-2.5 py-2 ${row()} text-icon-warning-base`} role="alert">
            {error().message}
          </p>
        )}
      </Show>
      <Show when={props.repositories && props.matches.length === 0}>
        <span class={`px-2.5 py-2 ${row()} text-text-weak`}>
          {props.query.trim() ? t("projects.add.repositories.empty") : t("projects.create.repositories.none")}
        </span>
      </Show>
      <For each={props.matches}>
        {(repository) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.selected === repository.fullName}
            class={`flex items-center gap-2 px-2.5 py-1.5 text-left ${row()} text-text-strong hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover focus-visible:outline-none aria-checked:bg-surface-raised-base-active`}
            onClick={() => props.onSelect(repository.fullName)}
          >
            <span class="min-w-0 flex-1 truncate">{repository.fullName}</span>
            <Show when={repository.private}>
              <span class="shrink-0 rounded-sm border border-border-base px-1 text-10-medium text-text-weak">{t("projects.add.private")}</span>
            </Show>
          </button>
        )}
      </For>
    </>
  )
}

export function RepositoryList(props: RepositoryListProps) {
  const t = useProjectsText()
  const matches = createMemo(() => {
    const needle = props.query.trim().toLowerCase()
    const all = props.repositories ?? []
    return needle ? all.filter((repository) => repository.fullName.toLowerCase().includes(needle)) : all
  })
  return (
    <div class="flex flex-col gap-2">
      <input
        type="search"
        value={props.query}
        onInput={(event) => props.onQuery(event.currentTarget.value)}
        placeholder={t("projects.add.search")}
        aria-label={t("projects.add.search")}
        autocomplete="off"
        spellcheck={false}
        class={`${FIELD_BOX} text-14-regular w-full min-w-0 text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`}
      />
      <div
        role="radiogroup"
        aria-label={t("projects.add.repositories")}
        class="flex max-h-60 flex-col overflow-y-auto rounded-md border border-border-base"
      >
        <RepositoryRows {...props} matches={matches()} />
      </div>
    </div>
  )
}
