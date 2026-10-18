import { Show, type JSX } from "solid-js"
import { toAppError, type ProjectSource } from "@/server"
import { Button, ClaxedoIcon as Icon, Field, SegmentedControl, SegmentedControlItem, TextField } from "@/ui"
import { useProjectsText } from "../i18n"
import { draftProjectName, pastedRepositoryHint } from "../project-source"
import { ConnectCodeHost } from "./project-create-connect"
import { createProjectCreateDraft, type ProjectCreateDraft, type RepositoryChoice } from "./project-create-draft"
import { AccountSelect, RepositoryList } from "./project-create-repository"
import "./projects.css"

export type ProjectCreateFormProps = {
  readonly folderMachine?: string
  readonly namedByRepository?: boolean
  readonly pickFolder?: () => Promise<string | undefined>
  readonly submitLabel?: string
  readonly onSubmit: (source: ProjectSource, name: string | undefined) => void | Promise<void>
}

function FolderField(props: { machine: string; folder: string; onChoose: () => void }) {
  const t = useProjectsText()
  return (
    <Field>
      <Field.Label>{t("projects.create.folder.label", { machine: props.machine })}</Field.Label>
      <button type="button" aria-label={t("projects.create.folder.choose")} title={props.folder || undefined} class="project-create-folder" onClick={() => props.onChoose()}>
        <Icon name="folder" size="small" class="project-create-folder-icon" />
        <span class="project-create-folder-path" classList={{ "project-create-folder-path--empty": !props.folder }}>
          {props.folder || t("projects.create.folder.placeholder")}
        </span>
        <span class="project-create-folder-action">{props.folder ? t("projects.create.folder.change") : t("projects.add.folder.browse")}</span>
      </button>
    </Field>
  )
}

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
            <RepositoryList listing={props.choice.repositories.data} host={host() ?? connection().providerName} loading={props.choice.repositories.isPending} error={props.choice.repositories.error} query={props.query} onQuery={props.onQuery} selected={props.selected} onSelect={props.onSelect} />
          </>
        )}
      </Show>
      <Show when={props.choice.view() === "url"}>
        <TextField
          label={t("projects.add.url")}
          description={pastedRepositoryHint(t, host(),props.choice.connection() !== undefined)}
          placeholder={t("projects.create.url.placeholder")}
          value={props.url}
          onChange={props.onUrl}
          spellcheck={false}
        />
      </Show>
    </div>
  )
}

function SourceSwitch(props: { draft: ProjectCreateDraft }) {
  const t = useProjectsText()
  return (
    <SegmentedControl
      class="segmented-control-v2--fit"
      aria-label={t("projects.create.source")}
      value={props.draft.mode()}
      onChange={(value) => {
        if (value === "folder" || value === "repository") props.draft.chooseSource(value)
      }}
    >
      <SegmentedControlItem value="folder">{t("projects.create.source.folder")}</SegmentedControlItem>
      <SegmentedControlItem value="repository">{t("projects.create.source.repository")}</SegmentedControlItem>
    </SegmentedControl>
  )
}

export function ProjectCreateFields(props: { readonly draft: ProjectCreateDraft; readonly namedByRepository?: boolean }): JSX.Element {
  const t = useProjectsText()
  const namePlaceholder = () => {
    const picked = props.draft.chosen()
    return picked ? draftProjectName(picked) : ""
  }
  return (
    <>
      <Show when={props.draft.offersFolder()}>
        <SourceSwitch draft={props.draft} />
      </Show>
      <Show
        when={props.draft.mode() === "folder" ? props.draft.folderMachine() : undefined}
        fallback={
          <RepositorySection choice={props.draft.choice} url={props.draft.repoUrl()} onUrl={props.draft.editUrl} query={props.draft.query()} onQuery={props.draft.setQuery} selected={props.draft.selected()} onSelect={props.draft.setSelected} />
        }
      >
        {(machine) => <FolderField machine={machine()} folder={props.draft.folder()} onChoose={() => void props.draft.chooseFolder()} />}
      </Show>
      <Show when={!props.namedByRepository}>
        <TextField label={t("projects.add.name")} placeholder={namePlaceholder()} value={props.draft.name()} onChange={props.draft.setName} spellcheck={false} />
      </Show>
    </>
  )
}

export function ProjectCreateForm(props: ProjectCreateFormProps): JSX.Element {
  const t = useProjectsText()
  const draft = createProjectCreateDraft({
    folderMachine: () => props.folderMachine,
    ...(props.pickFolder ? { pickFolder: props.pickFolder } : {}),
    send: async (source, name) => props.onSubmit(source, name),
  })
  return (
    <form
      class="flex w-full flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void draft.submit()
      }}
    >
      <ProjectCreateFields draft={draft} namedByRepository={props.namedByRepository} />
      <Show when={draft.error()}>
        {(message) => <p class="text-12-regular text-icon-warning-base" role="alert">{message()}</p>}
      </Show>
      <div class="flex justify-end gap-2 pt-1">
        <Button type="submit" variant="contrast" size="normal" disabled={draft.busy() || !draft.chosen()}>{props.submitLabel ?? t("projects.create.continue")}</Button>
      </div>
    </form>
  )
}
