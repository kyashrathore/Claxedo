import { createMemo, For, Show, type JSX } from "solid-js"
import type { AppError, CodeHostConnection, CodeHostRepository } from "@/server"
import { Field } from "@/ui"
import { Select } from "@opencode-ai/ui/select"
import { useProjectsText } from "../i18n"

export type CreateFormLook = {
  readonly comfortable: boolean
  readonly label: string
  readonly box: string
  readonly field: string
  readonly hint: string
  readonly link: string
}

export function createFormLook(comfortable: boolean): CreateFormLook {
  const box = comfortable
    ? "h-10 rounded-lg border border-border-base bg-surface-inset-base px-3"
    : "h-8 rounded-md border border-border-base bg-surface-inset-base px-2.5"
  return {
    comfortable,
    label: comfortable ? "text-[length:var(--font-size-intermediate)] font-medium text-text-weak" : "text-12-medium text-text-weak",
    box,
    field: `${box} w-full min-w-0 ${comfortable ? "text-14-regular" : "text-13-regular"} text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`,
    hint: comfortable ? "text-12-regular text-text-weak" : "text-11-regular text-text-weak",
    link: `${comfortable ? "text-12-medium" : "text-11-medium"} text-text-weak underline-offset-2 hover:text-text-strong hover:underline focus-visible:underline focus-visible:outline-none`,
  }
}

export function UrlField(props: { look: CreateFormLook; url: string; onUrl: (url: string) => void; host: string | undefined; leadField?: (element: HTMLElement) => void }) {
  const t = useProjectsText()
  return (
    <label class="flex flex-col gap-1">
      <span class={props.look.label}>{t("projects.add.url")}</span>
      <input
        type="text"
        value={props.url}
        onInput={(event) => props.onUrl(event.currentTarget.value)}
        placeholder={t("projects.create.url.placeholder")}
        aria-label={t("projects.add.url")}
        spellcheck={false}
        class={props.look.field}
        ref={(element) => props.leadField?.(element)}
      />
      <span class={props.look.hint}>
        {props.host ? t("projects.create.url.hint.host", { host: props.host }) : t("projects.create.url.hint.none")}
      </span>
    </label>
  )
}

export function AccountSelect(props: { connections: readonly CodeHostConnection[]; current: CodeHostConnection; onSelect: (id: string) => void }) {
  const t = useProjectsText()
  const label = (connection: CodeHostConnection) => connection.accountLabel ?? connection.providerName
  return (
    <Field>
      <Field.Label>{t("projects.add.account")}</Field.Label>
      <Select options={[...props.connections]} current={props.current} value={(item) => item.id} label={label} onSelect={(next) => next && props.onSelect(next.id)} />
    </Field>
  )
}

type RepositoryListProps = {
  look: CreateFormLook
  repositories: readonly CodeHostRepository[] | undefined
  loading: boolean
  error: AppError | null
  query: string
  onQuery: (query: string) => void
  selected: string | undefined
  onSelect: (fullName: string) => void
  leadField?: (element: HTMLElement) => void
}

function RepositoryRows(props: RepositoryListProps & { matches: readonly CodeHostRepository[] }): JSX.Element {
  const t = useProjectsText()
  const row = () => (props.look.comfortable ? "text-13-regular" : "text-12-regular")
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
        class={`${props.look.box} ${props.look.comfortable ? "text-14-regular" : "text-13-regular"} w-full min-w-0 text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base`}
        ref={(element) => props.leadField?.(element)}
      />
      <div
        role="radiogroup"
        aria-label={t("projects.add.repositories")}
        class={`flex max-h-56 flex-col overflow-y-auto rounded-md border border-border-base ${props.look.comfortable ? "max-h-72" : ""}`}
      >
        <RepositoryRows {...props} matches={matches()} />
      </div>
    </div>
  )
}
