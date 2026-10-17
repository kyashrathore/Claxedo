import type { JSX } from "solid-js"
import { useServer, type PlacementId, type Project } from "@/server"
import { FormDialog, useDialog } from "@/ui"
import { useProjectsText } from "../i18n"
import { pickProjectFolderWith } from "../pick-project-folder"
import { createProjectCreateDraft } from "./project-create-draft"
import { ProjectCreateFields } from "./project-create-form"

export function DialogCreateProject(props: { readonly onCreated: (project: Project, placementId: PlacementId | undefined) => void }): JSX.Element {
  const t = useProjectsText()
  const dialog = useDialog()
  const server = useServer()
  const draft = createProjectCreateDraft({
    folderMachine: () => server.capabilities()?.servingMachine?.name,
    pickFolder: pickProjectFolderWith(dialog),
    send: async (source, name) => {
      let placementId: PlacementId | undefined
      const project = await server.projects.create({ source, ...(name ? { name } : {}), onPlacement: (id) => (placementId = id) })
      dialog.close()
      props.onCreated(project, placementId)
    },
  })
  return (
    <FormDialog
      title={t("projects.create.title")}
      description={t("projects.create.description")}
      submitLabel={t("projects.add.create")}
      busyLabel={t("projects.create.creating")}
      cancelLabel={t("projects.cancel")}
      busy={draft.busy()}
      canSubmit={draft.chosen() !== undefined}
      error={draft.error()}
      onSubmit={() => void draft.submit()}
      onCancel={() => dialog.close()}
    >
      <ProjectCreateFields draft={draft} />
    </FormDialog>
  )
}
