/**
 * Add / Edit Process Dialog
 *
 * Used by the ProcessPane "+ Add" button and panel edit action.
 * - Add mode: create a new process config through the process client
 * - Edit mode: update through the process client, with Delete button
 *
 * Fields: name (required), command (required), cwd, env key-value pairs,
 * autoStart toggle, restartPolicy select.
 */

import { createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { RadioGroup } from "@opencode-ai/ui/radio-group"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { createProcessClient } from "@/features/processes/data/client"
import type { Process } from "@/features/processes/data/process"
import { capture as phCapture } from "@/platform/telemetry/analytics"
import { resolveWorkspaceRuntime } from "@/platform/runtime/cloud/workspace-runtime-store"
import { getClaxedoServerUrl } from "@/platform/api/api"

type ProcessConfig = Process.ProcessConfig

const RESTART_POLICIES = [
  { value: "never" as const, label: "Never" },
  { value: "on-failure" as const, label: "On failure" },
  { value: "always" as const, label: "Always" },
]

const CONFLICT_OPTIONS = [
  { value: "ask" as const, label: "Ask me" },
  { value: "pick-new" as const, label: "Pick new" },
  { value: "kill-existing" as const, label: "Kill existing" },
]

type EnvEntry = { key: string; value: string }

type FormStore = {
  name: string
  command: string
  cwd: string
  envEntries: EnvEntry[]
  autoStart: boolean
  restartPolicy: Process.RestartPolicy
  maxRestarts: number
  dependsOn: string
  usePort: boolean
  portName: string
  portInject: string
  portPreferred: string
  portOnConflict: Process.PortConflictStrategy | undefined
  saving: boolean
  deleting: boolean
}

export type AddProcessDialogProps = {
  directory: string
  request?: typeof fetch
  /** If provided, dialog is in edit mode for this config. */
  config?: ProcessConfig
  /** Called after successful create/update/delete so the pane can refresh. */
  onDone?: () => void
  /** Called after a new process is created so the pane can open. */
  onCreated?: () => void
}

export function AddProcessDialog(props: AddProcessDialogProps) {
  const dialog = useDialog()
  const fetchFn = props.request ?? globalThis.fetch
  const claxedoServerUrl = getClaxedoServerUrl()
  const client = createProcessClient({
    baseUrl: claxedoServerUrl,
    directory: props.directory,
    fetch: fetchFn,
    resolveWorkspaceRuntime: (input) => resolveWorkspaceRuntime({
      baseUrl: claxedoServerUrl,
      request: fetchFn,
      directory: input.directory,
    }),
  })

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
    dependsOn: props.config?.dependsOn?.join(", ") ?? "",
    usePort: !!props.config?.port,
    portName: props.config?.port?.name ?? "",
    portInject: props.config?.port?.inject ?? "PORT",
    portPreferred: props.config?.port?.preferred?.toString() ?? "",
    portOnConflict: props.config?.port?.onConflict,
    saving: false,
    deleting: false,
  })

  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false)

  const buildBody = () => {
    const env: Record<string, string> = {}
    for (const entry of store.envEntries) {
      const k = entry.key.trim()
      if (k) env[k] = entry.value
    }

    const dependsOnList = store.dependsOn
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    const preferredPort = store.portPreferred.trim()
      ? parseInt(store.portPreferred.trim(), 10)
      : undefined

    return {
      name: store.name.trim(),
      command: store.command.trim(),
      ...(store.cwd.trim() ? { cwd: store.cwd.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      autoStart: store.autoStart,
      restartPolicy: store.restartPolicy,
      maxRestarts: store.maxRestarts,
      ...(dependsOnList.length > 0 ? { dependsOn: dependsOnList } : {}),
      port: hasPort() ? {
        name: effectivePortName(),
        inject: store.portInject.trim() || "PORT",
        ...(preferredPort && !isNaN(preferredPort) ? { preferred: preferredPort } : {}),
        ...(store.portOnConflict ? { onConflict: store.portOnConflict } : {}),
      } : undefined,
    }
  }

  const derivedPortName = () =>
    store.name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || ""

  const effectivePortName = () =>
    store.portName.trim() || derivedPortName()

  const hasPort = () =>
    store.usePort || store.portPreferred.trim().length > 0

  const canSubmit = () =>
    store.name.trim().length > 0 &&
    store.command.trim().length > 0 &&
    (!hasPort() || effectivePortName().length > 0) &&
    !store.saving

  const handleSubmit = async (e: SubmitEvent) => {
    e.preventDefault()
    if (!canSubmit()) return

    setStore("saving", true)
    try {
      const body = buildBody()

      if (isEdit() && props.config) {
        await client.updateConfig(props.config.id, body)
        phCapture("process_updated", { has_port: store.usePort, restart_policy: store.restartPolicy })
        showToast({ title: "Process updated", variant: "success", duration: 3000 })
      } else {
        await client.createConfig(body)
        phCapture("process_created", { has_port: store.usePort, auto_start: store.autoStart, restart_policy: store.restartPolicy })
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
      await client.deleteConfig(props.config.id)
      phCapture("process_deleted")
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
          name="process-name"
          type="text"
          label="Name"
          description="Lowercase, hyphens, dots, underscores only (e.g. my-server)"
          placeholder="dev-server"
          data-testid="process-name-input"
          value={store.name}
          onChange={(v) => setStore("name", v.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-"))}
          spellcheck={false}
          class="font-mono text-xs"
          required
        />

        {/* Command */}
        <TextField
          name="process-command"
          type="text"
          label="Command"
          placeholder="npm run dev"
          data-testid="process-command-input"
          value={store.command}
          onChange={(v) => setStore("command", v)}
          spellcheck={false}
          class="font-mono text-xs"
          required
        />

        {/* Working directory */}
        <TextField
          name="process-cwd"
          type="text"
          label="Working directory"
          description="Relative to workspace root (optional)"
          placeholder="./packages/server"
          data-testid="process-cwd-input"
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
                  class="flex-1 min-w-0 bg-surface-inset-base border border-border-base rounded-md px-2 py-1.5 text-12-regular font-mono text-text-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
                  spellcheck={false}
                />
                <span class="text-text-weak text-12-regular">=</span>
                <input
                  type="text"
                  placeholder="value"
                  value={entry.value}
                  onInput={(e) => setStore("envEntries", index(), "value", e.currentTarget.value)}
                  class="flex-1 min-w-0 bg-surface-inset-base border border-border-base rounded-md px-2 py-1.5 text-12-regular font-mono text-text-strong focus:outline-none focus:ring-1 focus:ring-border-interactive-focus"
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

        {/* Dependencies */}
        <TextField
          type="text"
          label="Depends on"
          description="Comma-separated process names. These will auto-start first."
          placeholder="api-server, database"
          value={store.dependsOn}
          onChange={(v) => setStore("dependsOn", v)}
          spellcheck={false}
          class="font-mono text-xs"
        />

        {/* ── Port configuration ── */}
        <div class="flex flex-col gap-3">
          <TextField
            type="text"
            label="Preferred port"
            description="Base port for this process. Other workspaces scan upward from here."
            placeholder="3000"
            value={store.portPreferred}
            onChange={(v) => setStore("portPreferred", v)}
            spellcheck={false}
            class="font-mono text-xs"
          />

          <Show when={store.portPreferred.trim()}>
            <div class="flex flex-col gap-1.5">
              <label class="text-12-medium text-text-weak">If port is occupied</label>
              <RadioGroup
                size="small"
                fill
                options={CONFLICT_OPTIONS}
                current={CONFLICT_OPTIONS.find((o) => o.value === (store.portOnConflict ?? "ask"))}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(o) => setStore("portOnConflict", o?.value === "ask" ? undefined : o?.value as Process.PortConflictStrategy)}
              />
            </div>
          </Show>

          <Switch
            checked={store.usePort}
            onChange={(v) => setStore("usePort", v)}
          >
            Advanced port settings
          </Switch>
          <Show when={store.usePort}>
            {/* How the port is passed to the process */}
            <div class="flex flex-col gap-1.5">
              <TextField
                type="text"
                label="Pass port via"
                description="Env variable or CLI flag to tell your process which port to listen on."
                placeholder="PORT or --port"
                value={store.portInject}
                onChange={(v) => setStore("portInject", v)}
                spellcheck={false}
                class="font-mono text-xs"
              />
              <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-surface-inset-base border border-border-weak-base">
                <Icon name="console" size="small" class="text-text-weaker shrink-0" />
                <p class="text-[11px] font-mono text-text-weak">
                  <Show
                    when={store.portInject.trim().startsWith("-")}
                    fallback={
                      <>{store.portInject.trim() || "PORT"}=&lt;port&gt; {store.command.trim() || "your-command"}</>
                    }
                  >
                    {store.command.trim() || "your-command"} {store.portInject.trim()} &lt;port&gt;
                  </Show>
                </p>
              </div>
            </div>

            {/* Port name for cross-process references */}
            <div class="flex flex-col gap-1.5">
              <TextField
                type="text"
                label="Port name"
                description={`Other processes can use {{port:${effectivePortName() || "name"}}} in their environment variables to resolve this port.`}
                placeholder={derivedPortName() || "my-app"}
                value={store.portName}
                onChange={(v) => setStore("portName", v)}
                spellcheck={false}
                class="font-mono text-xs"
              />
              <Show when={effectivePortName()}>
                <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-surface-inset-base border border-border-weak-base">
                  <Icon name="bubble-5" size="small" class="text-text-weaker shrink-0" />
                  <p class="text-[11px] text-text-weak leading-relaxed">
                    Other processes can use{" "}
                    <code class="px-1 py-0.5 rounded bg-surface-base-hover text-text-base font-mono text-[10px]">
                      {`{{port:${effectivePortName()}}}`}
                    </code>
                    {" "}in their env vars to resolve this port number at startup.
                  </p>
                </div>
              </Show>
            </div>
          </Show>
        </div>

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
                  data-testid="process-confirm-delete"
                  class="!bg-surface-critical-strong hover:!bg-icon-critical-hover"
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
