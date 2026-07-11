export { DialogEditProject } from "./dialog-edit-project"

import { createMemo, createSignal, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@claxedo/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@claxedo/utils/path"
import type { Session } from "@opencode-ai/sdk/v2"

function message(err: unknown) {
  if (typeof err === "string") return err
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: unknown }).data
    if (data && typeof data === "object" && "message" in data) {
      const msg = data.message
      if (typeof msg === "string") return msg
    }
  }
  if (err && typeof err === "object" && "message" in err) {
    const msg = err.message
    if (typeof msg === "string") return msg
  }
  if (err instanceof Error) return err.message
  return "Request failed"
}

// We'll use the platform dialog service to show these, so they are just component definitions here.

export interface DialogDeleteSessionProps {
  session: Session
  onDelete: (session: Session) => Promise<void>
  onClose: () => void
}

export function DialogDeleteSession(props: DialogDeleteSessionProps) {
  const language = useLanguage()
  const [deleting, setDeleting] = createSignal(false)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await props.onDelete(props.session)
      props.onClose()
    } finally {
      setDeleting(false)
    }
  }

  // Note: 'fit' prop might require checking the Dialog component definition if it accepts it.
  // Assuming it does based on upstream usage.
  return (
    <Dialog title={language.t("session.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {language.t("session.delete.confirm", { name: props.session.title })}
          </span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onClose} disabled={deleting()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={handleDelete} disabled={deleting()}>
            {deleting()
              ? language.t("common.loading")
              : language.t("session.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export interface DialogRecoverWorkspaceProps {
  name: string
  onRecover: () => Promise<void>
  onClose: () => void
}

export function DialogRecoverWorkspace(props: DialogRecoverWorkspaceProps) {
  const language = useLanguage()
  const [loading, setLoading] = createSignal(false)

  const handleRecover = async () => {
    setLoading(true)
    try {
      await props.onRecover()
      props.onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog title="Worktree not found" fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            The backing worktree for "{props.name}" is gone.
          </span>
          <span class="text-12-regular text-text-weak">
            You can keep browsing past sessions here, or continue in a new worktree for this project.
          </span>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onClose} disabled={loading()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" onClick={handleRecover} disabled={loading()}>
            {loading() ? language.t("common.loading") : "Continue in new worktree"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export interface DialogDeleteWorkspaceProps {
  directory: string
  isMain?: boolean
  isCloud?: boolean
  onDelete: (directory: string) => Promise<void>
  onClose: () => void
}

export function DialogDeleteWorkspace(props: DialogDeleteWorkspaceProps) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()

  // Only show "Destroy Sandbox" for cloud main workspaces
  const isCloudSandbox = () => props.isMain && props.isCloud

  const name = createMemo(() => getFilename(props.directory))
  const [deleting, setDeleting] = createSignal(false)
  const [data, setData] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    dirty: false,
  })

  onMount(() => {
    if (isCloudSandbox()) {
       setData({ status: "ready", dirty: true })
       return
    }

    // We'll just check status if possible, or skip if complex dependency needed
    globalSDK.client.file
      .status({ directory: props.directory })
      .then((x) => {
        const files = x.data ?? []
        const dirty = files.length > 0
        setData({ status: "ready", dirty })
      })
      .catch(() => {
        setData({ status: "error", dirty: false })
      })
  })

  const handleDelete = async () => {
    setDeleting(true)
    await props.onDelete(props.directory)
      .then(() => props.onClose())
      .catch((err) =>
        showToast({
          title: isCloudSandbox() ? "Failed to destroy sandbox" : "Failed to delete workspace",
          description: message(err),
          variant: "error",
        }),
      )
      .finally(() => setDeleting(false))
  }

  const description = () => {
    if (data.status === "loading") return language.t("workspace.status.checking")
    if (data.status === "error") return language.t("workspace.status.error")
    if (!data.dirty) return language.t("workspace.status.clean")
    return language.t("workspace.status.dirty")
  }

  return (
    <Dialog title={isCloudSandbox() ? "Destroy Sandbox" : language.t("workspace.delete.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex flex-col gap-1">
          <span class="text-14-regular text-text-strong">
            {isCloudSandbox()
              ? `Are you sure you want to destroy the sandbox for "${name()}"? This will permanently delete the VM and all data in it.`
              : language.t("workspace.delete.confirm", { name: name() })
            }
          </span>
          <Show when={!isCloudSandbox()}>
            <span class="text-12-regular text-text-weak">{description()}</span>
          </Show>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={props.onClose} disabled={deleting()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            class="!bg-surface-critical-strong hover:!bg-icon-critical-hover"
            disabled={deleting() || (!isCloudSandbox() && data.status === "loading")}
            onClick={handleDelete}
          >
            {isCloudSandbox() ? "Destroy Sandbox" : language.t("workspace.delete.button")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
