import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { toAppError, useServer, type Project } from "@/server"
import { useDialog, Button, Dialog, Field, Textarea, TextField, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { getFilename } from "@/ui/utils"
import { useProjectsText } from "../i18n"
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

function useEditProjectStore(project: Project) {
  const folderName = createMemo(() => getFilename(project.directory ?? ""))
  const defaultName = createMemo(() => project.name || folderName())
  const [store, setStore] = createStore({
    name: defaultName(),
    color: project.icon?.color || "pink",
    iconUrl: project.icon?.override || "",
    startup: project.commands?.start ?? "",
    environment: environmentRows(project.env),
    environmentError: "",
    saveError: "",
    saving: false,
    dragOver: false,
    iconHover: false,
  })
  return { store, setStore, folderName, defaultName }
}

export function DialogEditProject(props: { project: Project }) {
  const dialog = useDialog()
  const server = useServer()
  const t = useProjectsText()
  const { store, setStore, folderName, defaultName } = useEditProjectStore(props.project)
  const setIcon = (url: string) => setStore({ iconUrl: url, iconHover: false })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    if (environmentRowsProblem(store.environment)) return
    setStore({ saving: true, saveError: "" })
    const name = store.name.trim() === folderName() ? "" : store.name.trim()
    const start = store.startup.trim()
    try {
      await server.projects.update(props.project.id, {
        name,
        env: environmentRecord(store.environment),
        icon: { color: store.color, override: store.iconUrl },
        commands: { start },
      })
    } catch (cause) {
      const error = toAppError(cause)
      setStore(error.code === "project_env_invalid" ? { saving: false, environmentError: error.message } : { saving: false, saveError: error.message })
      return
    }
    setStore("saving", false)
    dialog.close()
  }

  return (
    <Dialog size="large">
      <DialogHeader>
        <DialogTitle>{t("projects.edit.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 pb-4">
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
          <Field>
            <Field.Label>{t("projects.edit.startup")}</Field.Label>
            <Textarea
              class="textarea-v2--full-width"
              style={{ "font-family": "var(--font-family-mono)" }}
              placeholder={t("projects.edit.startup.placeholder")}
              value={store.startup}
              onInput={(event) => setStore("startup", event.currentTarget.value)}
              spellcheck={false}
            />
            <Field.Suffix>{t("projects.edit.startup.description")}</Field.Suffix>
          </Field>
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
        </div>
        <Show when={store.saveError}>
          <p class="text-12-regular text-icon-warning-base" role="alert">{store.saveError}</p>
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {t("projects.cancel")}
          </Button>
          <Button type="submit" variant="contrast" size="large" disabled={store.saving}>
            {store.saving ? t("projects.saving") : t("projects.save")}
          </Button>
        </div>
      </form>
      </DialogBody>
    </Dialog>
  )
}
