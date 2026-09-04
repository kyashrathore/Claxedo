import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { ProjectRecord } from "../../data/project-api"
import { ProjectCreateForm } from "../project-create-form"

/**
 * The create form in a dialog, for the places that have no composer to host
 * it: the empty canvas before the first project exists, and the rail's "New
 * Project". Everywhere else the composer's Project chip renders the same form
 * in its panel.
 *
 * The dialog host shows one dialog at a time, so opening the directory picker
 * closes this dialog and the form with it. The picker therefore runs with the
 * draft in hand, and when it resolves with a folder this dialog is shown again
 * with the draft and the choice restored.
 */
export function DialogCreateProject(props: {
  baseUrl?: string
  localExecution: boolean
  pickFolder?: () => Promise<string | undefined>
  initial?: { name?: string; folder?: string }
  onCreated: (project: ProjectRecord) => void
}) {
  const dialog = useDialog()
  const pickFolder = props.pickFolder
  return (
    <Dialog title="New Project">
      <ProjectCreateForm
        baseUrl={props.baseUrl}
        localExecution={props.localExecution}
        initial={props.initial}
        pickFolder={
          pickFolder &&
          (async (draft) => {
            const folder = await pickFolder()
            if (folder) dialog.show(() => <DialogCreateProject {...props} initial={{ name: draft.name, folder }} />)
            return folder
          })
        }
        onCreated={(project) => {
          dialog.close()
          props.onCreated(project)
        }}
        onCancel={() => dialog.close()}
      />
    </Dialog>
  )
}
