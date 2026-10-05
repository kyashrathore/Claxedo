import type { JSX } from "solid-js"
import { useServer, type Project } from "@/server"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { pickProjectFolderWith } from "../pick-project-folder"
import { ProjectCreateForm } from "./project-create-form"

export function DialogCreateProject(props: { readonly onCreated: (project: Project) => void }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const server = useServer()
  return (
    <Dialog fit aria-label={t("projects.create.title")}>
      <DialogHeader>
        <DialogTitleGroup title={t("projects.create.title")} description={t("projects.create.description")} />
      </DialogHeader>
      <DialogBody class="form-surface-body">
        <ProjectCreateForm
          folderMachine={server.capabilities()?.servingMachine?.name}
          pickFolder={pickProjectFolderWith(dialog)}
          onCancel={() => dialog.close()}
          onCreated={(project) => {
            dialog.close()
            props.onCreated(project)
          }}
        />
      </DialogBody>
    </Dialog>
  )
}
