import { createSignal, Show, type Component } from "solid-js"
import type { ProjectSource } from "@/server"
import { useProjectsServer } from "../api"
import type { AddProjectFlow } from "../add-project"
import { projectsText } from "../i18n"
import { draftProjectName } from "../model"
import { buttonAttrs } from "./button-attrs"
import { RepositoryPicker } from "./repository-picker"

type Mode = "repository" | "folder"

function initialMode(source: ProjectSource | undefined): Mode {
  return source?.kind === "folder" ? "folder" : "repository"
}

export const SourceStep: Component<{ flow: AddProjectFlow; pickFolder?: () => Promise<string | undefined> }> = (props) => {
  const server = useProjectsServer()
  const draft = props.flow.draft
  const offersFolder = () => server.capabilities()?.thisMachine !== undefined
  const [mode, setMode] = createSignal<Mode>(initialMode(draft.source))
  const [folder, setFolder] = createSignal(draft.source?.kind === "folder" ? draft.source.path : "")
  const [url, setUrl] = createSignal(draft.source?.kind === "repository" ? draft.source.url : "")
  const [pasting, setPasting] = createSignal(draft.source?.kind === "repository")
  const [connected, setConnected] = createSignal(false)

  const setSource = (source: ProjectSource | undefined) => props.flow.setDraft("source", source)
  const useFolder = (path: string) => {
    setFolder(path)
    setSource(path.trim() ? { kind: "folder", path: path.trim() } : undefined)
  }
  const useUrl = (value: string) => {
    setUrl(value)
    setSource(value.trim() ? { kind: "repository", url: value.trim() } : undefined)
  }
  const switchMode = (next: Mode) => {
    setMode(next)
    if (next === "folder") useFolder(folder())
    else if (pasting() || !connected()) useUrl(url())
    else setSource(draft.source?.kind === "connectedRepository" ? draft.source : undefined)
  }
  const browse = async () => {
    const picked = await props.pickFolder?.()
    if (picked) useFolder(picked)
  }
  const placeholder = () => (draft.source ? draftProjectName(draft.source) : "")

  return (
    <div class="flex flex-col gap-4" data-slot="source-step">
      <label class="flex flex-col gap-1">
        <span class="projects-label">{projectsText("projects.add.name")}</span>
        <input
          type="text"
          class="projects-field"
          value={draft.name}
          placeholder={placeholder()}
          aria-label={projectsText("projects.add.name")}
          onInput={(event) => props.flow.setDraft("name", event.currentTarget.value)}
        />
        <span class="projects-hint">{projectsText("projects.add.name.hint")}</span>
      </label>
      <Show when={offersFolder()}>
        <div class="projects-segment self-start" role="group" aria-label={projectsText("projects.source")}>
          <button type="button" aria-pressed={mode() === "repository"} onClick={() => switchMode("repository")}>
            {projectsText("projects.add.source.repository")}
          </button>
          <button type="button" aria-pressed={mode() === "folder"} onClick={() => switchMode("folder")}>
            {projectsText("projects.add.source.folder")}
          </button>
        </div>
      </Show>
      <Show when={mode() === "folder"}>
        <div class="flex flex-col gap-1">
          <span class="projects-label">{projectsText("projects.add.folder")}</span>
          <div class="flex gap-2">
            <input
              type="text"
              class="projects-field font-mono"
              value={folder()}
              placeholder={projectsText("projects.add.folder.placeholder")}
              aria-label={projectsText("projects.add.folder")}
              spellcheck={false}
              onInput={(event) => useFolder(event.currentTarget.value)}
            />
            <Show when={props.pickFolder}>
              <button type="button" {...buttonAttrs("outline")} onClick={() => void browse()}>
                {projectsText("projects.add.folder.browse")}
              </button>
            </Show>
          </div>
          <span class="projects-hint">{projectsText("projects.add.folder.hint")}</span>
        </div>
      </Show>
      <Show when={mode() === "repository"}>
        <RepositoryPicker
          flow={props.flow}
          pasting={pasting()}
          onPasting={(next) => {
            setPasting(next)
            if (next) useUrl(url())
            else setSource(draft.source?.kind === "connectedRepository" ? draft.source : undefined)
          }}
          onConnected={setConnected}
          url={url()}
          onUrl={useUrl}
        />
      </Show>
    </div>
  )
}
