/**
 * Add / Edit Process Dialog
 *
 * Used by the ProcessPane "+ Add" button and panel edit action.
 * - Add mode: POST /process/ to create a new config
 * - Edit mode: PUT /process/:id to update, with Delete button
 *
 * Fields: name (required), command (required), cwd, env key-value pairs,
 * autoStart toggle, restartPolicy select.
 */

import { createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import type { Process } from "../../opencode-patches/process/process"

type ProcessConfig = Process.ProcessConfig

const RESTART_POLICIES = [
  { value: "never" as const, label: "Never" },
  { value: "on-failure" as const, label: "On failure" },
  { value: "always" as const, label: "Always" },
]

type EnvEntry = { key: string; value: string }

type PortMode = "env" | "flag"

const PORT_MODES = [
  { value: "env" as const, label: "Env variable" },
  { value: "flag" as const, label: "CLI flag" },
]

type FormStore = {
  name: string
  command: string
  cwd: string
  envEntries: EnvEntry[]
  autoStart: boolean
  restartPolicy: Process.RestartPolicy
  maxRestarts: number
  usePortless: boolean
  hostname: string
  portMode: PortMode
  portValue: string
  saving: boolean
  deleting: boolean
}

export type AddProcessDialogProps = {
  /** If provided, dialog is in edit mode for this config. */
  config?: ProcessConfig
  /** Called after successful create/update/delete so the pane can refresh. */
  onDone?: () => void
  /** Called after a new process is created so the pane can open. */
  onCreated?: () => void
}

export function AddProcessDialog(props: AddProcessDialogProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? globalThis.fetch

  const isEdit = () => !!props.config

  const envToEntries = (env?: Record<string, string>): EnvEntry[] => {
    if (!env) return []
    return Object.entries(env).map(([key, value]) => ({ key, value }))
  }

  const [store, setStore] = createStore<FormStore>({
    name: props.config?.name ?? "",
    command: props.config?.command ?? "",
    cwd: props.config?.cwd ?? "",
    envEntries: envToEntries(props.config?.env),
    autoStart: props.config?.autoStart ?? false,
    restartPolicy: props.config?.restartPolicy ?? "never",
    maxRestarts: props.config?.maxRestarts ?? 3,
    usePortless: !!props.config?.portless,
    hostname: props.config?.portless?.hostname ?? "",
    portMode: props.config?.portless?.portMode ?? "env",
    portValue: props.config?.portless?.portValue ?? "PORT",
    saving: false,
    deleting: false,
  })

  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false)

  const headers = () => ({
    "Content-Type": "application/json",
    "x-opencode-directory": sdk.directory,
  })

  const buildBody = () => {
    const env: Record<string, string> = {}
    for (const entry of store.envEntries) {
      const k = entry.key.trim()
      if (k) env[k] = entry.value
    }

    return {
      name: store.name.trim(),
      command: store.command.trim(),
      ...(store.cwd.trim() ? { cwd: store.cwd.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      autoStart: store.autoStart,
      restartPolicy: store.restartPolicy,
      maxRestarts: store.maxRestarts,
      portless: store.usePortless ? {
        hostname: effectiveHostname(),
        portMode: store.portMode,
        portValue: store.portValue.trim() || (store.portMode === "env" ? "PORT" : "--port"),
      } : undefined,
    }
  }

  const derivedHostname = () =>
    store.name.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || ""

  const effectiveHostname = () =>
    store.hostname.trim() || derivedHostname()

  const canSubmit = () =>
    store.name.trim().length > 0 &&
    store.command.trim().length > 0 &&
    (!store.usePortless || effectiveHostname().length > 0) &&
    !store.saving

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    if (!canSubmit()) return

    setStore("saving", true)
    try {
      const body = buildBody()

      if (isEdit() && props.config) {
        // PUT /process/:id
        const res = await fetchFn(`${sdk.url}/process/${props.config.id}`, {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error((err as any).error || "Failed to update process")
        }
        showToast({ title: "Process updated", variant: "success", duration: 3000 })
      } else {
        // POST /process
        const res = await fetchFn(`${sdk.url}/process`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error((err as any).error || "Failed to create process")
        }
        showToast({ title: "Process created", variant: "success", duration: 3000 })
        // Notify parent to open the pane, then refresh to pick up the new config.
        // The SSE process.config.changed event also syncs configs, but calling
        // onDone ensures the panel appears even if SSE is delayed.
        props.onCreated?.()
        props.onDone?.()
        dialog.close()
        return
      }

      props.onDone?.()
      dialog.close()
    } catch (err) {
      showToast({
        title: isEdit() ? "Failed to update process" : "Failed to create process",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      })
    } finally {
      setStore("saving", false)
    }
  }

  const handleDelete = async () => {
    if (!props.config) return
    setStore("deleting", true)
    try {
      const res = await fetchFn(`${sdk.url}/process/${props.config.id}`, {
        method: "DELETE",
        headers: headers(),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).error || "Failed to delete process")
      }
      showToast({ title: "Process removed", variant: "success", duration: 3000 })
      props.onDone?.()
      dialog.close()
    } catch (err) {
      showToast({
        title: "Failed to delete process",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "error",
      })
    } finally {
      setStore("deleting", false)
    }
  }

  const addEnvEntry = () => {
    setStore(
      "envEntries",
      produce((entries: EnvEntry[]) => {
        entries.push({ key: "", value: "" })
      }),
    )
  }

  const removeEnvEntry = (index: number) => {
    setStore(
      "envEntries",
      produce((entries: EnvEntry[]) => {
        entries.splice(index, 1)
      }),
    )
  }

  return (
    <Dialog title={isEdit() ? "Edit Process" : "Add Process"} class="w-full max-w-[480px] mx-auto">
      <form onSubmit={handleSubmit} class="flex flex-col flex-1 min-h-0">
      {/* Scrollable body */}
      <div
        class="flex flex-col gap-4 px-6 pb-4 flex-1 min-h-0 overflow-y-auto transition-all duration-200"
        classList={{
          "blur-[2px] opacity-40 pointer-events-none select-none": showDeleteConfirm(),
        }}
      >
        {/* Name */}
        <TextField
          autofocus
          type="text"
          label="Name"
          placeholder="Dev server"
          value={store.name}
          onChange={(v) => setStore("name", v)}
          required
        />

        {/* Command */}
        <TextField
          type="text"
          label="Command"
          placeholder="npm run dev"
          value={store.command}
          onChange={(v) => setStore("command", v)}
          spellcheck={false}
          class="font-mono text-xs"
          required
        />

        {/* Working directory */}
        <TextField
          type="text"
          label="Working directory"
          description="Relative to workspace root (optional)"
          placeholder="./packages/server"
          value={store.cwd}
          onChange={(v) => setStore("cwd", v)}
          spellcheck={false}
          class="font-mono text-xs"
        />

        {/* Environment variables */}
        <div class="flex flex-col gap-2">
          <label class="text-12-medium text-text-weak">Environment variables</label>
          <For each={store.envEntries}>
            {(entry, index) => (
              <div class="flex gap-2 items-center">
                <input
                  type="text"
                  placeholder="KEY"
                  value={entry.key}
                  onInput={(e) => setStore("envEntries", index(), "key", e.currentTarget.value)}
                  class="flex-1 min-w-0 bg-surface-inset border border-border rounded-md px-2 py-1.5 text-12-regular font-mono text-text-strong focus:outline-none focus:ring-1 focus:ring-accent"
                  spellcheck={false}
                />
                <span class="text-text-weak text-12-regular">=</span>
                <input
                  type="text"
                  placeholder="value"
                  value={entry.value}
                  onInput={(e) => setStore("envEntries", index(), "value", e.currentTarget.value)}
                  class="flex-1 min-w-0 bg-surface-inset border border-border rounded-md px-2 py-1.5 text-12-regular font-mono text-text-strong focus:outline-none focus:ring-1 focus:ring-accent"
                  spellcheck={false}
                />
                <button
                  type="button"
                  class="shrink-0 p-1 rounded hover:bg-surface-base-hover text-text-weak hover:text-text-strong transition-colors"
                  onClick={() => removeEnvEntry(index())}
                  aria-label="Remove variable"
                >
                  <Icon name="close-small" size="small" />
                </button>
              </div>
            )}
          </For>
          <button
            type="button"
            class="flex items-center gap-1.5 text-[11px] font-medium text-text-weak hover:text-text-base px-1.5 py-1 rounded hover:bg-surface-base-hover transition-colors self-start"
            onClick={addEnvEntry}
          >
            <Icon name="plus-small" size="small" />
            Add variable
          </button>
        </div>

        {/* Portless integration (not available on Windows) */}
        <Show when={platform.os !== "windows"}>
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <Switch
                checked={store.usePortless}
                onChange={(v) => setStore("usePortless", v)}
              >
                Use Portless
              </Switch>
              <a
                href="https://github.com/vercel-labs/portless"
                target="_blank"
                rel="noopener noreferrer"
                class="text-[11px] text-accent hover:underline"
              >
                What's this?
              </a>
            </div>
            <Show when={store.usePortless}>
              <TextField
                type="text"
                label="Hostname"
                description={`Access at http://${effectiveHostname() || "<hostname>"}.localhost:1355`}
                placeholder={derivedHostname() || "my-app"}
                value={store.hostname}
                onChange={(v) => setStore("hostname", v)}
                spellcheck={false}
                class="font-mono text-xs"
              />
              <div class="flex flex-col gap-1.5">
                <label class="text-12-medium text-text-weak">How does your app accept a port?</label>
                <div class="flex items-center gap-2">
                  <Select
                    options={PORT_MODES}
                    current={PORT_MODES.find((m) => m.value === store.portMode)}
                    value={(x) => x.value}
                    label={(x) => x.label}
                    onSelect={(x) => {
                      if (!x) return
                      setStore("portMode", x.value)
                      setStore("portValue", x.value === "env" ? "PORT" : "--port")
                    }}
                    size="small"
                    variant="ghost"
                  />
                  <input
                    type="text"
                    placeholder={store.portMode === "env" ? "PORT" : "--port"}
                    value={store.portValue}
                    onInput={(e) => setStore("portValue", e.currentTarget.value)}
                    class="flex-1 min-w-0 bg-surface-inset border border-border rounded-md px-2 py-1.5 text-12-regular font-mono text-text-strong focus:outline-none focus:ring-1 focus:ring-accent"
                    spellcheck={false}
                  />
                </div>
                <span class="text-[11px] text-text-weak">
                  {store.portMode === "env"
                    ? `Portless sets ${store.portValue.trim() || "PORT"} to the assigned port`
                    : `Appends ${store.portValue.trim() || "--port"} <port> to your command`}
                </span>
              </div>
            </Show>
          </div>
        </Show>

      </div>

        {/* Fixed footer */}
        <div class="flex items-center gap-2 px-6 py-3 border-t border-border-weak-base shrink-0">
          <Show
            when={!showDeleteConfirm()}
            fallback={
              <>
                <span class="text-[12px] text-text-weak">Are you sure you want to delete this process?</span>
                <div class="flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="large"
                  onClick={() => setShowDeleteConfirm(false)}
                  disabled={store.deleting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="large"
                  onClick={handleDelete}
                  disabled={store.deleting}
                  class="!bg-red-600 hover:!bg-red-700"
                >
                  {store.deleting ? "Deleting..." : "Confirm Delete"}
                </Button>
              </>
            }
          >
            <Show when={isEdit()}>
              <Button
                type="button"
                variant="ghost"
                size="large"
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </Button>
            </Show>
            <div class="flex-1" />
            <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="large" disabled={!canSubmit()}>
              {store.saving ? "Saving..." : isEdit() ? "Save" : "Add"}
            </Button>
          </Show>
        </div>
      </form>
    </Dialog>
  )
}
