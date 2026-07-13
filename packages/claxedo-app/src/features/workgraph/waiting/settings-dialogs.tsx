import type {
  CommandResult,
  ExecutionProfileDefaults,
  RecapProfileDefaults,
  StreamDto,
  WorkGraphDefaultsDto,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { createResource, createSignal, For, type JSX, Show } from "solid-js"
import {
  CLEANUP_OPTIONS,
  ENVIRONMENT_OPTIONS,
  INTEGRATION_OPTIONS,
  ISOLATION_OPTIONS,
  type SettingsCapabilities,
} from "./settings-capabilities"
import { DetailState, WorkGraphDialog } from "./workgraph-dialog"

export type WorkGraphSettingsSource = {
  defaults: () => Promise<WorkGraphDefaultsDto>
  saveDefaults: (expectedVersion: number, defaults: { execution: ExecutionProfileDefaults; recap: RecapProfileDefaults }) => Promise<CommandResult>
}

/**
 * WorkGraph-wide execution defaults, rendered as the Settings view of the shared
 * WorkspacePanel (never a separate modal, never inner tabs). Recap is a
 * Stream-owned concept and is not edited here; the WorkGraph-level recap object
 * loaded with the defaults is preserved unchanged when execution defaults save.
 * `active` gates the resource so the defaults are only fetched while Settings shows.
 */
export function WorkGraphSettingsView(props: {
  active: boolean
  source: WorkGraphSettingsSource
  capabilities?: SettingsCapabilities
  onClose?: () => void
}) {
  const [detail, { refetch }] = createResource(
    () => (props.active ? true : undefined),
    () => props.source.defaults(),
  )
  return (
    <div class="workgraph-settings-view">
      <header class="workgraph-settings-heading">
        <h2 class="text-[12px] font-semibold text-text-strong">WorkGraph settings</h2>
        <p class="text-[11px] leading-4 text-text-weaker">Execution defaults inherited by every stream, outcome, and task.</p>
      </header>
      <DetailState resource={detail} retry={refetch}>
        {(current) => (
          <SettingsForm
            variant="panel"
            showRecap={false}
            execution={current.defaults.execution}
            recap={current.defaults.recap}
            capabilities={props.capabilities}
            onCancel={() => props.onClose?.()}
            // Recap is not a WorkGraph-level setting; persist the loaded recap unchanged.
            save={(execution, recap) => props.source.saveDefaults(current.version, { execution, recap })}
          />
        )}
      </DetailState>
    </div>
  )
}

export type StreamSettingsSource = {
  workgraphDefaults: () => Promise<WorkGraphDefaultsDto>
  /** Atomic update of both execution and recap overrides at one expected version. */
  save: (streamId: string, expectedVersion: number, settings: { execution: ExecutionProfileDefaults; recap: RecapProfileDefaults }) => Promise<CommandResult>
}

/** Per-stream overrides opened from a stream row. One tabless scrollable form
 *  with Execution override and Recap behavior sections; both save atomically. */
export function StreamSettingsDialog(props: {
  open: boolean
  onClose: () => void
  stream: StreamDto | undefined
  source: StreamSettingsSource
  capabilities?: SettingsCapabilities
}) {
  // Gate on a reactive SOURCE (the open stream), not a condition inside the fetcher.
  // The dialog is mounted once and toggled open later, so a single-arg fetcher would
  // run once while closed and never refetch on open — leaving the body blank.
  const [inherited, { refetch }] = createResource(
    () => (props.open && props.stream ? props.stream : undefined),
    () => props.source.workgraphDefaults(),
  )
  return (
    <WorkGraphDialog open={props.open && !!props.stream} onClose={props.onClose} title="Stream settings" description={props.stream?.title} size="large">
      <Show when={props.stream} keyed>
        {(stream) => (
          <DetailState resource={inherited} retry={refetch}>
            {(workgraph) => (
              <SettingsForm
                variant="dialog"
                showRecap
                execution={stream.executionDefaults}
                recap={stream.recapDefaults}
                inheritedExecution={workgraph.defaults.execution}
                capabilities={props.capabilities}
                onCancel={props.onClose}
                save={async (execution, recap) => {
                  const result = await props.source.save(stream.id, stream.version, { execution, recap })
                  if (result.ok) props.onClose()
                  return result
                }}
              />
            )}
          </DetailState>
        )}
      </Show>
    </WorkGraphDialog>
  )
}

const modelKey = (model?: { providerId: string; modelId: string }) => (model ? `${model.providerId}/${model.modelId}` : "")

function SettingsForm(props: {
  variant: "panel" | "dialog"
  showRecap: boolean
  execution: ExecutionProfileDefaults
  recap: RecapProfileDefaults
  inheritedExecution?: ExecutionProfileDefaults
  capabilities?: SettingsCapabilities
  onCancel: () => void
  save: (execution: ExecutionProfileDefaults, recap: RecapProfileDefaults) => Promise<CommandResult>
}) {
  const [environment, setEnvironment] = createSignal(props.execution.environment?.kind ?? "")
  const [baseRevision, setBaseRevision] = createSignal(props.execution.repository?.baseRevision ?? "")
  const [harness, setHarness] = createSignal(props.execution.harness ?? "")
  const [agent, setAgent] = createSignal(props.execution.agent ?? "")
  const [model, setModel] = createSignal(modelKey(props.execution.model))
  const [effort, setEffort] = createSignal(props.execution.effort ?? "")
  const [isolation, setIsolation] = createSignal(props.execution.isolation ?? "")
  const [cleanup, setCleanup] = createSignal(props.execution.cleanup ?? "")
  const [integration, setIntegration] = createSignal(props.execution.integration ?? "")
  const [recapEffort, setRecapEffort] = createSignal(props.recap.effort ?? "")
  const [recapModel, setRecapModel] = createSignal(modelKey(props.recap.model))
  const [quietHours, setQuietHours] = createSignal(props.recap.quietHours?.toString() ?? "")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  // Model resolution respects capability availability. When the model catalog is
  // present the field is editable, so an empty selection truly clears the model
  // override. When the catalog is unavailable the field can't be edited, so the
  // existing model is preserved rather than silently wiped.
  const resolveModel = (key: string, current: ExecutionProfileDefaults["model"]) => {
    if (!props.capabilities?.models) return current ? { model: current } : {}
    const chosen = props.capabilities.models.find((option) => modelKey(option) === key)
    return chosen ? { model: { providerId: chosen.providerId, modelId: chosen.modelId } } : {}
  }

  const buildExecution = (): ExecutionProfileDefaults => {
    return {
      ...(environment() ? { environment: { kind: environment() as "local_worktree" | "hosted_workspace" } } : {}),
      ...(baseRevision().trim() ? { repository: { baseRevision: baseRevision().trim() } } : {}),
      ...(harness().trim() ? { harness: harness().trim() } : {}),
      ...(agent().trim() ? { agent: agent().trim() } : {}),
      ...resolveModel(model(), props.execution.model),
      ...(effort().trim() ? { effort: effort().trim() } : {}),
      ...(isolation() ? { isolation: isolation() as "stream" | "child" } : {}),
      ...(cleanup() ? { cleanup: cleanup() as "destroy_on_close" | "retain" } : {}),
      ...(integration() ? { integration: integration() as "manual" | "pull_request" | "direct" } : {}),
      ...(props.execution.tools ? { tools: props.execution.tools } : {}),
      ...(props.execution.connectionIds ? { connectionIds: props.execution.connectionIds } : {}),
    }
  }

  const buildRecap = (): RecapProfileDefaults => {
    const hours = Number(quietHours())
    return {
      ...resolveModel(recapModel(), props.recap.model),
      ...(recapEffort().trim() ? { effort: recapEffort().trim() } : {}),
      ...(quietHours().trim() && Number.isFinite(hours) && hours > 0 ? { quietHours: hours } : {}),
    }
  }

  const submit = async () => {
    if (busy()) return
    setBusy(true)
    setError()
    try {
      // WorkGraph settings never edit recap, so its loaded object is passed through
      // unchanged; the Stream form edits recap and rebuilds it from the fields.
      const recap = props.showRecap ? buildRecap() : props.recap
      const result = await props.save(buildExecution(), recap)
      if (!result.ok) setError(result.error.code === "version_conflict" ? "These settings changed elsewhere. Reload before saving." : result.error.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="workgraph-settings-form" classList={{ "is-dialog": props.variant === "dialog" }}>
      <div class="workgraph-settings-scroll">
        <div class="workgraph-settings">
          <Show when={props.showRecap}>
            <div class="workgraph-settings-section-title">Execution override</div>
          </Show>
          <EnumRow label="Environment" description="Where attempts execute" value={environment()} onChange={setEnvironment} options={ENVIRONMENT_OPTIONS} inherited={props.inheritedExecution?.environment?.kind} />
          <TextRow label="Base revision" value={baseRevision()} onChange={setBaseRevision} placeholder="main" inherited={props.inheritedExecution?.repository?.baseRevision} />
          <CapabilityRow label="Harness" value={harness()} onChange={setHarness} options={props.capabilities?.harnesses} missing="harness" inherited={props.inheritedExecution?.harness} />
          <CapabilityRow label="Agent" value={agent()} onChange={setAgent} options={props.capabilities?.agents} missing="agent" inherited={props.inheritedExecution?.agent} />
          <CapabilityRow
            label="Model"
            value={model()}
            onChange={setModel}
            options={props.capabilities?.models.map((option) => ({ value: modelKey(option), label: option.label }))}
            missing="model"
            inherited={modelKey(props.inheritedExecution?.model) || undefined}
          />
          <CapabilityRow label="Effort" value={effort()} onChange={setEffort} options={props.capabilities?.efforts} missing="effort" inherited={props.inheritedExecution?.effort} />
          <EnumRow label="Isolation" value={isolation()} onChange={setIsolation} options={ISOLATION_OPTIONS} inherited={props.inheritedExecution?.isolation} />
          <EnumRow label="Cleanup" value={cleanup()} onChange={setCleanup} options={CLEANUP_OPTIONS} inherited={props.inheritedExecution?.cleanup} />
          <EnumRow label="Integration" value={integration()} onChange={setIntegration} options={INTEGRATION_OPTIONS} inherited={props.inheritedExecution?.integration} />
          <ToolsRow current={props.execution.tools ?? []} capabilities={props.capabilities} />
          <Show when={props.showRecap}>
            <div class="workgraph-settings-section-title">Recap behavior</div>
            <CapabilityRow
              label="Model"
              ariaLabel="Recap model"
              value={recapModel()}
              onChange={setRecapModel}
              options={props.capabilities?.models.map((option) => ({ value: modelKey(option), label: option.label }))}
              missing="model"
            />
            <CapabilityRow label="Effort" ariaLabel="Recap effort" value={recapEffort()} onChange={setRecapEffort} options={props.capabilities?.efforts} missing="effort" />
            <TextRow label="Quiet hours" value={quietHours()} onChange={setQuietHours} placeholder="e.g. 8" numeric />
          </Show>
        </div>
      </div>
      <div class="workgraph-settings-footer">
        <Show when={error()}>
          <p class="workgraph-settings-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="workgraph-settings-actions">
          <Button size="small" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="small" variant="primary" disabled={busy()} onClick={() => void submit()}>
            {busy() ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A field row: label in the left column; control plus its description, note, and
 *  inherited hint stacked together in the right column so nothing drifts into the
 *  label column or wraps arbitrarily. */
function SettingRow(props: { label: string; description?: string; note?: string; inherited?: string; control: JSX.Element }) {
  return (
    <div class="workgraph-setting-row">
      <div class="workgraph-setting-label text-text-base">{props.label}</div>
      <div class="workgraph-setting-side">
        <div class="workgraph-setting-control">{props.control}</div>
        <Show when={props.description}>
          <div class="workgraph-setting-desc text-text-weaker">{props.description}</div>
        </Show>
        <Show when={props.note}>
          <div class="workgraph-setting-note text-text-weaker" role="note">
            {props.note}
          </div>
        </Show>
        <Show when={props.inherited}>
          <div class="workgraph-setting-inherit text-text-weaker">Inherits {props.inherited} from WorkGraph</div>
        </Show>
      </div>
    </div>
  )
}

function EnumRow(props: {
  label: string
  description?: string
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  inherited?: string
}) {
  return (
    <SettingRow
      label={props.label}
      description={props.description}
      inherited={props.inherited}
      control={
        <select class="workgraph-setting-select" aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
          <option value="">Inherit</option>
          <For each={props.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
        </select>
      }
    />
  )
}

function TextRow(props: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; inherited?: string; numeric?: boolean }) {
  return (
    <SettingRow
      label={props.label}
      inherited={props.inherited}
      control={
        <input
          class="workgraph-setting-input"
          aria-label={props.label}
          inputmode={props.numeric ? "numeric" : undefined}
          value={props.value}
          placeholder={props.placeholder}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      }
    />
  )
}

/** A capability-gated field. Editable only when the option catalog is provided;
 *  otherwise it shows the current value and an explicit unavailable note — never
 *  invented choices. */
function CapabilityRow(props: {
  label: string
  /** Overrides the control's accessible name when the visible label alone would collide
   *  (e.g. the recap Model/Effort selects share a label with the execution ones). */
  ariaLabel?: string
  value: string
  onChange: (value: string) => void
  options?: readonly { value: string; label: string }[] | readonly string[]
  missing: string
  inherited?: string
}) {
  const normalized = () =>
    props.options?.map((option) => (typeof option === "string" ? { value: option, label: option } : option)) ?? undefined
  return (
    <Show
      when={normalized()}
      fallback={
        <SettingRow
          label={props.label}
          inherited={props.inherited}
          note={`Options unavailable — ${props.missing} capability API not connected`}
          control={<span class="workgraph-setting-value text-text-base">{props.value || "not set"}</span>}
        />
      }
    >
      {(options) => (
        <SettingRow
          label={props.label}
          inherited={props.inherited}
          control={
            <select class="workgraph-setting-select" aria-label={props.ariaLabel ?? props.label} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
              <option value="">Inherit</option>
              <For each={options()}>{(option) => <option value={option.value}>{option.label}</option>}</For>
            </select>
          }
        />
      )}
    </Show>
  )
}

function ToolsRow(props: { current: readonly string[]; capabilities?: SettingsCapabilities }) {
  return (
    <SettingRow
      label="Permitted tools"
      note={props.capabilities?.tools ? undefined : "Tool catalog unavailable — capability API not connected"}
      control={
        <div class="workgraph-setting-tools">
          <For each={props.current} fallback={<span class="text-text-weaker text-[12px]">none</span>}>
            {(tool) => <span class="workgraph-tool-pill">{tool}</span>}
          </For>
          <Show when={props.capabilities?.tools}>
            <span class="workgraph-tool-pill is-add" aria-disabled="true">
              + Add
            </span>
          </Show>
        </div>
      }
    />
  )
}
