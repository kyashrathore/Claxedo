import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { onCleanup } from "solid-js"

type DialogId = "model" | "project" | "provider" | "directory" | "fork" | "release"

const titles: Record<DialogId, string> = {
  model: "Model picker",
  project: "Project dialog",
  provider: "Provider dialog",
  directory: "Directory picker",
  fork: "Fork dialog",
  release: "Release notes",
}

export default function DialogMatrixHarness() {
  const dialog = useDialog()
  const open = (id: DialogId, mode: "show" | "push" = "show") => {
    dialog[mode](() => <MatrixDialog id={id} open={open} />)
  }

  window.__claxedoDialogMatrix = {
    show: (id) => open(id),
    push: (id) => open(id, "push"),
  }
  onCleanup(() => {
    delete window.__claxedoDialogMatrix
  })

  return (
    <main class="min-h-dvh bg-background-base p-8 text-text-base" data-testid="dialog-matrix-harness">
      <div class="flex flex-col gap-3 max-w-sm">
        <h1 class="text-18-bold text-text-strong">Dialog matrix</h1>
        <button type="button" data-testid="show-model" onClick={() => open("model")}>
          Show model
        </button>
        <button type="button" data-testid="show-project" onClick={() => open("project")}>
          Show project
        </button>
        <button type="button" data-testid="show-release" onClick={() => open("release")}>
          Show release notes
        </button>
        <div data-testid="dialog-active">{dialog.active ? "active" : "inactive"}</div>
      </div>
    </main>
  )
}

declare global {
  interface Window {
    __claxedoDialogMatrix?: {
      show: (id: DialogId) => void
      push: (id: DialogId) => void
    }
  }
}

function MatrixDialog(props: { id: DialogId; open: (id: DialogId, mode?: "show" | "push") => void }) {
  const dialog = useDialog()
  return (
    <Dialog title={titles[props.id]} description={`Representative ${props.id} dialog`}>
      <div class="flex flex-col gap-3" data-testid={`dialog-body-${props.id}`}>
        <p data-testid={`dialog-copy-${props.id}`}>{titles[props.id]}</p>
        <button type="button" data-testid="replace-provider" onClick={() => props.open("provider")}>
          Replace with provider
        </button>
        <button type="button" data-testid="push-directory" onClick={() => props.open("directory", "push")}>
          Push directory
        </button>
        <button type="button" data-testid="show-fork" onClick={() => props.open("fork")}>
          Replace with fork
        </button>
        <button type="button" data-testid="close-dialog" onClick={() => dialog.close()}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
