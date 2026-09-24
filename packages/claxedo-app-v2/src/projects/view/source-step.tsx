import { createSignal, Show, type Component } from "solid-js"
import { useServer, type ProjectSource } from "@/server"
import { Button, Field, SegmentedControl, SegmentedControlItem, TextInput } from "@/ui"
import type { AddProjectFlow } from "../add-project"
import { useProjectsText } from "../i18n"
import { draftProjectName } from "../model"
import { RepositoryPicker } from "./repository-picker"

type Mode = "repository" | "folder"

function folderSource(path: string): ProjectSource | undefined {
  const trimmed = path.trim()
  return trimmed ? { kind: "folder", path: trimmed } : undefined
}

const FolderField: Component<{
  path: string
  onPath: (path: string) => void
  pickFolder?: () => Promise<string | undefined>
}> = (props) => {
  const t = useProjectsText()
  const browse = async () => {
    const picked = await props.pickFolder?.()
    if (picked) props.onPath(picked)
  }
  return (
    <Field>
      <Field.Label>{t("projects.add.folder")}</Field.Label>
      <div class="flex gap-2">
        <Field.Control class="min-w-0 flex-1">
          <TextInput
            class="font-mono"
            value={props.path}
            placeholder={t("projects.add.folder.placeholder")}
            spellcheck={false}
            onInput={(event) => props.onPath(event.currentTarget.value)}
          />
        </Field.Control>
        <Show when={props.pickFolder}>
          <Button variant="outline" onClick={() => void browse()}>
            {t("projects.add.folder.browse")}
          </Button>
        </Show>
      </div>
      <span class="projects-hint">{t("projects.add.folder.hint")}</span>
    </Field>
  )
}

export const SourceStep: Component<{ flow: AddProjectFlow; pickFolder?: () => Promise<string | undefined> }> = (props) => {
  const t = useProjectsText()
  const server = useServer()
  const draft = props.flow.draft
  const offersFolder = () => server.capabilities()?.thisMachine !== undefined
  const [mode, setMode] = createSignal<Mode>(draft.source?.kind === "folder" ? "folder" : "repository")
  const [folder, setFolder] = createSignal(draft.source?.kind === "folder" ? draft.source.path : "")
  const [repository, setRepository] = createSignal<ProjectSource | undefined>(draft.source?.kind === "folder" ? undefined : draft.source)

  const setSource = (source: ProjectSource | undefined) => props.flow.setDraft("source", source)
  const useFolder = (path: string) => {
    setFolder(path)
    setSource(folderSource(path))
  }
  const useRepository = (source: ProjectSource | undefined) => {
    setRepository(source)
    setSource(source)
  }
  const switchMode = (next: string | null) => {
    if (next !== "folder" && next !== "repository") return
    setMode(next)
    setSource(next === "folder" ? folderSource(folder()) : repository())
  }
  const placeholder = () => (draft.source ? draftProjectName(draft.source) : "")

  return (
    <div class="flex flex-col gap-4" data-slot="source-step">
      <Field>
        <Field.Label>{t("projects.add.name")}</Field.Label>
        <Field.Control>
          <TextInput value={draft.name} placeholder={placeholder()} onInput={(event) => props.flow.setDraft("name", event.currentTarget.value)} />
        </Field.Control>
        <span class="projects-hint">{t("projects.add.name.hint")}</span>
      </Field>
      <Show when={offersFolder()}>
        <SegmentedControl class="self-start" value={mode()} onChange={switchMode} aria-label={t("projects.source")}>
          <SegmentedControlItem value="repository">{t("projects.add.source.repository")}</SegmentedControlItem>
          <SegmentedControlItem value="folder">{t("projects.add.source.folder")}</SegmentedControlItem>
        </SegmentedControl>
      </Show>
      <Show when={mode() === "folder"}>
        <FolderField path={folder()} onPath={useFolder} {...(props.pickFolder ? { pickFolder: props.pickFolder } : {})} />
      </Show>
      <Show when={mode() === "repository"}>
        <RepositoryPicker source={repository()} onSource={useRepository} />
      </Show>
    </div>
  )
}
