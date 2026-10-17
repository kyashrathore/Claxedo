import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createFlow, runFlow } from "@/lib/flow"
import { toAppError, useServer, type Project } from "@/server"
import { FormDrawer, TextField, useDialog } from "@/ui"
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
    dragOver: false,
    iconHover: false,
  })
  return { store, setStore, folderName, defaultName }
}

export function DrawerEditProject(props: { project: Project }) {
  const dialog = useDialog()
  const server = useServer()
  const t = useProjectsText()
  const { store, setStore, folderName, defaultName } = useEditProjectStore(props.project)
  const setIcon = (url: string) => setStore({ iconUrl: url, iconHover: false })
  const saving = createFlow<"saving", Project>()
  const failure = () => {
    const state = saving.state()
    return state.kind === "failed" ? state.error.message : undefined
  }
  const save = async () => {
    const name = store.name.trim() === folderName() ? "" : store.name.trim()
    await runFlow(saving, "saving", () => server.projects.update(props.project.id, { name, icon: { color: store.color, override: store.iconUrl } }), toAppError)
    if (saving.state().kind === "done") dialog.close()
  }

  return (
    <FormDrawer
      title={t("projects.edit.title")}
      submitLabel={t("projects.save")}
      busyLabel={t("projects.saving")}
      cancelLabel={t("projects.cancel")}
      busy={saving.state().kind === "running"}
      error={failure()}
      onSubmit={() => void save()}
      onCancel={() => dialog.close()}
    >
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
    </FormDrawer>
  )
}
