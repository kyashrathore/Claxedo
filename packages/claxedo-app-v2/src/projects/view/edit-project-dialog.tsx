import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { getFilename } from "@opencode-ai/ui/utils/path"
import { createEffect, createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { projectId, toAppError, useServer, type EngineProject } from "@/server"
import { useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { useProject } from "../store"
import { EnvironmentEditor, environmentRecord, environmentRows, environmentRowsProblem } from "./environment-editor"
import { ProjectColorField, ProjectIconField } from "./edit-project-icon"

function readImage(file: File, onLoad: (url: string) => void) {
  if (!file.type.startsWith("image/")) return
  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result !== "string") return
    onLoad(reader.result)
  }
  reader.readAsDataURL(file)
}

export type EditableProject = Pick<EngineProject, "id" | "worktree" | "name" | "icon" | "commands">

function useEditProjectStore(project: EditableProject) {
  const folderName = createMemo(() => getFilename(project.worktree))
  const defaultName = createMemo(() => project.name || folderName())
  const [store, setStore] = createStore({
    name: defaultName(),
    color: project.icon?.color || "pink",
    iconUrl: project.icon?.override || "",
    startup: project.commands?.start ?? "",
    environment: environmentRows(undefined),
    environmentLoaded: false,
    environmentError: "",
    saveError: "",
    saving: false,
    dragOver: false,
    iconHover: false,
  })
  const record = useProject(() => projectId(project.id))
  createEffect(() => {
    const state = record()
    if (state.kind !== "ready" || store.environmentLoaded) return
    setStore({ environment: environmentRows(state.project.env), environmentLoaded: true })
  })
  return { store, setStore, folderName, defaultName }
}

export function DialogEditProject(props: { project: EditableProject }) {
  const dialog = useDialog()
  const server = useServer()
  const t = useProjectsText()
  const { store, setStore, folderName, defaultName } = useEditProjectStore(props.project)
  const setIcon = (url: string) => setStore({ iconUrl: url, iconHover: false })

  async function saveEnvironment() {
    if (!store.environmentLoaded) return true
    try {
      await server.projects.update(projectId(props.project.id), { env: environmentRecord(store.environment) })
      return true
    } catch (cause) {
      setStore({ saving: false, environmentError: toAppError(cause).message })
      return false
    }
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (environmentRowsProblem(store.environment)) return
    setStore({ saving: true, saveError: "" })
    const name = store.name.trim() === folderName() ? "" : store.name.trim()
    const start = store.startup.trim()
    if (!(await saveEnvironment())) return
    try {
      await server.engineProjects.update({
        id: props.project.id,
        worktree: props.project.worktree,
        name,
        icon: { color: store.color, override: store.iconUrl },
        commands: { start },
      })
    } catch (cause) {
      setStore({ saving: false, saveError: toAppError(cause).message })
      return
    }
    setStore("saving", false)
    dialog.close()
  }

  return (
    <Dialog title={t("projects.edit.title")} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col gap-6">
        <div class="flex flex-col gap-4">
          <TextField autofocus type="text" label={t("projects.edit.name")} placeholder={folderName()} value={store.name} onChange={(v) => setStore("name", v)} />
          <ProjectIconField
            state={{ iconUrl: store.iconUrl, iconHover: store.iconHover, dragOver: store.dragOver, color: store.color, label: store.name || defaultName() }}
            onHover={(hover) => setStore("iconHover", hover)}
            onDrop={(e) => {
              e.preventDefault()
              setStore("dragOver", false)
              const file = e.dataTransfer?.files[0]
              if (file) readImage(file, setIcon)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setStore("dragOver", true)
            }}
            onDragLeave={() => setStore("dragOver", false)}
            onClear={() => setStore("iconUrl", "")}
            onInputChange={(e) => {
              const file = e.target instanceof HTMLInputElement ? e.target.files?.[0] : undefined
              if (file) readImage(file, setIcon)
            }}
          />
          <Show when={!store.iconUrl}>
            <ProjectColorField color={store.color} label={store.name || defaultName()} onColor={(color) => setStore("color", color)} />
          </Show>
          <TextField
            multiline
            label={t("projects.edit.startup")}
            description={t("projects.edit.startup.description")}
            placeholder={t("projects.edit.startup.placeholder")}
            value={store.startup}
            onChange={(v) => setStore("startup", v)}
            spellcheck={false}
            class="max-h-40 w-full font-mono text-xs no-scrollbar"
          />
          <Show when={store.environmentLoaded}>
            <div class="flex flex-col gap-2">
              <div class="flex flex-col gap-0.5">
                <span class="text-13-medium text-text-strong">{t("projects.edit.environment")}</span>
                <span class="text-12-regular text-text-weak">
                  {t("projects.edit.environment.before")}
                  <code>.env</code>
                  {t("projects.edit.environment.after")}
                </span>
              </div>
              <EnvironmentEditor rows={store.environment} onChange={(rows) => setStore("environment", rows)} />
              <Show when={store.environmentError}>
                <p class="text-12-regular text-icon-warning-base" role="alert">{store.environmentError}</p>
              </Show>
            </div>
          </Show>
        </div>
        <Show when={store.saveError}>
          <p class="text-12-regular text-icon-warning-base" role="alert">{store.saveError}</p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {t("projects.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={store.saving}>
            {store.saving ? t("projects.saving") : t("projects.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
