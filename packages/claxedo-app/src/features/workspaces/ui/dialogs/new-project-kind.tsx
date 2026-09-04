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
      <div class="flex min-w-[420px] flex-col gap-2">
        <Option
          title="Folder on this machine"
          detail="Open a repository that already lives on this server. Sessions run here, on its files."
          onClick={() => choose(props.onFolder)}
        />
        <Option
          title="Cloud project"
          detail="Clone a repository into a sandbox on a provider you have configured. Sessions run there, with the environment you set."
          onClick={() => choose(props.onCloud)}
        />
      </div>
    </Dialog>
  )
}

function Option(props: { title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      class="flex w-full flex-col items-start gap-1 rounded-lg border border-border-base bg-surface-inset-base px-4 py-3 text-left transition-colors hover:bg-surface-raised-base-hover focus:outline-none focus-visible:border-border-focus"
      onClick={() => props.onClick()}
    >
      <span class="text-13-medium text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.detail}</span>
    </button>
  )
}
