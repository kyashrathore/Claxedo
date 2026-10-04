import type { JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type Project } from "@/server"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { pickProjectFolderWith } from "../pick-project-folder"
import { ProjectCreateForm } from "./project-create-form"

export function useFolderMachine(): () => string | undefined {
  const server = useServer()
  const machines = useQuery(() => ({ ...server.queries.machines.list(), enabled: server.capabilities()?.localExecution === true }))
  return () => (server.capabilities()?.localExecution ? machines.data?.find((machine) => machine.isThisMachine)?.name : undefined)
}

export function DialogCreateProject(props: { readonly onCreated: (project: Project) => void }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const folderMachine = useFolderMachine()
  return (
    <Dialog fit aria-label={t("projects.create.title")}>
      <DialogHeader>
        <DialogTitleGroup title={t("projects.create.title")} description={t("projects.create.description")} />
      </DialogHeader>
      <DialogBody class="form-surface-body">
        <ProjectCreateForm
          folderMachine={folderMachine()}
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
