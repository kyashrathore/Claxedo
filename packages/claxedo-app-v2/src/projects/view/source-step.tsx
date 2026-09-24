import { createSignal, Show, type Component } from "solid-js"
import { useServer, type ProjectSource } from "@/server"
import { Button, Field, SegmentedControl, SegmentedControlItem, TextInput } from "@/ui"
import type { AddProjectFlow } from "../add-project"
import { useFolderPicker } from "../folder-picker"
import { useProjectsText } from "../i18n"
import { draftProjectName } from "../model"
import { RepositoryPicker } from "./repository-picker"

type Mode = "repository" | "folder"

function folderSource(path: string): ProjectSource | undefined {
  const trimmed = path.trim()
  return trimmed ? { kind: "folder", path: trimmed } : undefined
}

const FolderField: Component<{ path: string; onPath: (path: string) => void }> = (props) => {
  const t = useProjectsText()
  const pick = useFolderPicker()
  const choose = async () => {
    const picked = await pick()
    if (picked) props.onPath(picked)
  }
  return (
    <div class="flex flex-col gap-2" data-slot="folder-field">
      <span class="projects-label">{t("projects.add.folder")}</span>
      <div class="flex min-w-0 items-center gap-2">
        <Show when={props.path}>
          {(path) => (
            <span class="projects-folder-path" title={path()}>
              {path()}
            </span>
          )}
        </Show>
        <Button variant="outline" onClick={() => void choose()}>
          {props.path ? t("projects.add.folder.change") : t("projects.add.folder.choose")}
        </Button>
      </div>
      <span class="projects-hint">{t("projects.add.folder.hint")}</span>
    </div>
  )
}

export const SourceStep: Component<{ flow: AddProjectFlow }> = (props) => {
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
        <SegmentedControl class="self-start segmented-control--fit" value={mode()} onChange={switchMode} aria-label={t("projects.source")}>
          <SegmentedControlItem value="repository">{t("projects.add.source.repository")}</SegmentedControlItem>
          <SegmentedControlItem value="folder">{t("projects.add.source.folder")}</SegmentedControlItem>
        </SegmentedControl>
      </Show>
      <Show when={mode() === "folder"}>
        <FolderField path={folder()} onPath={useFolder} />
      </Show>
      <Show when={mode() === "repository"}>
        <RepositoryPicker source={repository()} onSource={useRepository} />
      </Show>
    </div>
  )
}
