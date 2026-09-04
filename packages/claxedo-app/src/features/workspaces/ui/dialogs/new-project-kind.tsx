import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"

/**
 * The choice a server that can do both puts in front of New Project.
 *
 * The self-host binary runs workspaces on its own filesystem, so a folder on
 * that machine is a project there, signed in or not — in a browser tab
 * exactly as in the desktop, whose server it is. A signed account adds cloud
 * projects on top. Where only one of the two exists there is nothing to
 * choose and the caller opens that flow directly.
 */
export function DialogNewProjectKind(props: { onFolder: () => void; onCloud: () => void }) {
  const dialog = useDialog()
  const choose = (next: () => void) => {
    dialog.close()
    next()
  }
  return (
    <Dialog title="New Project">
      <div class="flex min-w-[400px] flex-col gap-2">
        <Button variant="secondary" class="justify-start" onClick={() => choose(props.onFolder)}>
          <span class="flex flex-col items-start">
            <span class="text-13-medium">Folder on this machine</span>
            <span class="text-11-regular text-text-weak">Open a repository that already lives on this server.</span>
          </span>
        </Button>
        <Button variant="secondary" class="justify-start" onClick={() => choose(props.onCloud)}>
          <span class="flex flex-col items-start">
            <span class="text-13-medium">Cloud project</span>
            <span class="text-11-regular text-text-weak">Name it, pick a repository, set its environment, provision a sandbox.</span>
          </span>
        </Button>
      </div>
    </Dialog>
  )
}
