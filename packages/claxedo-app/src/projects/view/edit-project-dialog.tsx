import { createMemo, createUniqueId, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { toAppError, useServer, type Project } from "@/server"
import { useDialog, Button, Dialog, TextField, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@/ui"
import { getFilename } from "@/ui/utils"
import { useProjectsText } from "../i18n"
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
  const formId = createUniqueId()

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    setStore({ saving: true, saveError: "" })
    const name = store.name.trim() === folderName() ? "" : store.name.trim()
    try {
      await server.projects.update(props.project.id, { name, icon: { color: store.color, override: store.iconUrl } })
    } catch (cause) {
      setStore({ saving: false, saveError: toAppError(cause).message })
      return
    }
    setStore("saving", false)
    dialog.close()
  }

  return (
    <Dialog fit containerClass="long-dialog-container">
      <DialogHeader>
        <DialogTitle>{t("projects.edit.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4">
        <form id={formId} onSubmit={handleSubmit} class="flex flex-col gap-4">
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
        </form>
      </DialogBody>
      <DialogFooter>
        <Show when={store.saveError}>
          <p class="mr-auto self-center text-12-regular text-icon-warning-base" role="alert">{store.saveError}</p>
        </Show>
        <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
          {t("projects.cancel")}
        </Button>
        <Button type="submit" form={formId} variant="contrast" size="large" disabled={store.saving}>
          {store.saving ? t("projects.saving") : t("projects.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
