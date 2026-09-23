import { Button } from "@opencode-ai/ui/button"
import { Show, createSignal, type Component } from "solid-js"
import type {
  MachineProviderBinding,
  MachineProviderConfigRow,
} from "@/platform/remote-access/machine-remote-access-port"

export type MachineProviderConfigStatus = "unconfigurable" | "none" | "rekeyed" | "pending" | "applied"

export function machineProviderConfigStatus(
  row: Pick<MachineProviderConfigRow, "revision" | "ackedRevision" | "sealingKeyDeclared" | "rekeyed">,
): MachineProviderConfigStatus {
  if (!row.sealingKeyDeclared) return "unconfigurable"
  if (row.revision === 0) return "none"
  // Ahead of "pending": a re-keyed machine never acks, so it would otherwise
  // read as pending forever and the owner would wait instead of pushing.
  if (row.rekeyed) return "rekeyed"
  return row.ackedRevision === row.revision ? "applied" : "pending"
}

function statusLine(row: MachineProviderConfigRow) {
  const status = machineProviderConfigStatus(row)
  if (status === "unconfigurable") return SEALING_KEY_UNDECLARED
  if (status === "none") return "No provider configuration pushed"
  if (status === "rekeyed") {
    return `The machine replaced its sealing key, so revision ${row.revision} can never reach it. Push again.`
  }
  if (status === "pending") {
    const held = row.ackedRevision === 0 ? "none" : `revision ${row.ackedRevision}`
    return `Revision ${row.revision} pushed · the machine still holds ${held}`
  }
  if (row.providers.length === 0) return `Revision ${row.revision} on the machine · no providers`
  return `Revision ${row.revision} on the machine · ${row.providers.join(", ")}`
}

const SEALING_KEY_UNDECLARED =
  "Cannot receive provider configuration yet: the machine declares its sealing key on its next heartbeat."

export type MachineProviderConfigProps = {
  machineName: string
  row: MachineProviderConfigRow
  onPush: (enrollmentId: string, providers: Record<string, MachineProviderBinding>) => Promise<void>
  /** The withdrawal. Stops every agent turn on the machine that depended on the pushed rows. */
  onClear: (enrollmentId: string) => Promise<void>
}

/**
 * The owner's provider configuration for one enrolled machine.
 *
 * The key leaves this component exactly once, as the `placeholder` field of
 * the row `onPush` sends, and the field is emptied the moment that push
 * resolves. Nothing here logs, reports or caches it, and a failed push keeps
 * it only so the same attempt can be retried without re-pasting.
 */
export const MachineProviderConfig: Component<MachineProviderConfigProps> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [providerId, setProviderId] = createSignal("")
  const [baseUrl, setBaseUrl] = createSignal("")
  const [secret, setSecret] = createSignal("")
  const [authMode, setAuthMode] = createSignal<MachineProviderBinding["authMode"]>("api-key")
  const [apiPath, setApiPath] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [confirmingClear, setConfirmingClear] = createSignal(false)

  const configurable = () => machineProviderConfigStatus(props.row) !== "unconfigurable"
  const secretLabel = () => (authMode() === "bearer" ? "Bearer token" : "API key")
  const complete = () => providerId().trim() !== "" && baseUrl().trim() !== "" && secret().trim() !== ""

  const push = () => {
    if (busy() || !complete()) return
    const path = apiPath().trim()
    const providers: Record<string, MachineProviderBinding> = {
      [providerId().trim()]: {
        baseUrl: baseUrl().trim(),
        placeholder: secret().trim(),
        authMode: authMode(),
        ...(path === "" ? {} : { apiPath: path }),
      },
    }
    setBusy(true)
    setError(undefined)
    void props.onPush(props.row.enrollmentId, providers)
      .then(() => {
        setSecret("")
        setOpen(false)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const clear = () => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    void props.onClear(props.row.enrollmentId)
      .then(() => setConfirmingClear(false))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  return (
    <div
      class="ml-3 flex flex-col gap-2 rounded-md border border-border-weak-base p-3"
      data-slot="provider-config"
      data-state={machineProviderConfigStatus(props.row)}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-12-medium text-text-strong">Provider configuration</div>
          <div class="text-11-regular text-text-weak" data-slot="provider-config-state">{statusLine(props.row)}</div>
        </div>
        <div class="flex items-center gap-2">
          <Show when={props.row.revision > 0 && !confirmingClear()}>
            <Button
              size="small"
              variant="secondary"
              disabled={busy()}
              aria-label={`Clear providers on ${props.machineName}`}
              onClick={() => setConfirmingClear(true)}
            >
              Clear
            </Button>
          </Show>
          <Button
            size="small"
            variant="secondary"
            disabled={!configurable() || busy()}
            title={configurable() ? undefined : SEALING_KEY_UNDECLARED}
            aria-label={`Configure providers on ${props.machineName}`}
            onClick={() => setOpen((value) => !value)}
          >
            {open() ? "Cancel" : "Configure providers"}
          </Button>
        </div>
      </div>

      <Show when={confirmingClear()}>
        <div class="flex flex-wrap items-center gap-2 text-12-regular text-text-base" data-slot="provider-config-clear">
          <span>
            Clearing stops every agent turn on {props.machineName} that depends on the pushed providers.
          </span>
          <Button size="small" variant="primary" disabled={busy()} onClick={clear}>
            {busy() ? "Clearing…" : `Clear providers on ${props.machineName}`}
          </Button>
          <Button size="small" variant="ghost" disabled={busy()} onClick={() => setConfirmingClear(false)}>
            Keep
          </Button>
        </div>
      </Show>

      <Show when={open() && configurable()}>
        <form
          class="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            push()
          }}
        >
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            Provider id
            <input
              class="rounded bg-surface-base px-2 py-1 text-12-regular text-text-strong"
              value={providerId()}
              placeholder="anthropic"
              onInput={(event) => setProviderId(event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            Base URL
            <input
              class="rounded bg-surface-base px-2 py-1 text-12-regular text-text-strong"
              value={baseUrl()}
              placeholder="https://api.anthropic.com"
              onInput={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            Auth mode
            <select
              class="rounded border border-border-base bg-surface-inset-base px-2 py-1 text-12-regular text-text-strong"
              value={authMode()}
              onChange={(event) => setAuthMode(event.currentTarget.value === "bearer" ? "bearer" : "api-key")}
            >
              <option value="api-key">API key header</option>
              <option value="bearer">Bearer token</option>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            {secretLabel()}
            <input
              class="rounded bg-surface-base px-2 py-1 text-12-regular text-text-strong"
              type="password"
              autocomplete="off"
              value={secret()}
              onInput={(event) => setSecret(event.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-11-regular text-text-weak">
            API path (optional)
            <input
              class="rounded bg-surface-base px-2 py-1 text-12-regular text-text-strong"
              value={apiPath()}
              placeholder="/v1"
              onInput={(event) => setApiPath(event.currentTarget.value)}
            />
          </label>
          <div class="flex items-center gap-2">
            <Button type="submit" size="small" variant="primary" disabled={busy() || !complete()}>
              {busy() ? "Pushing…" : `Push to ${props.machineName}`}
            </Button>
            <span class="text-11-regular text-text-weak">
              Sealed for this machine; only this machine can open it. Pushing replaces every provider it holds{
                props.row.providers.length === 0 ? "" : ` (now ${props.row.providers.join(", ")})`
              }.
            </span>
          </div>
        </form>
      </Show>

      <Show when={error()}>
        {(message) => <p class="text-12-regular text-icon-critical-base" role="alert">{message()}</p>}
      </Show>
    </div>
  )
}
