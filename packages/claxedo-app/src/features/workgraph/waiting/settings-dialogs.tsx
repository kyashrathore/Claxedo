import { createAsyncState } from "@/lib/async-state"
import {
  type CommandResult,
  type ExecutionCapabilities,
  type ExecutionEnvironmentCapability,
  type ExecutionProfileDefaults,
  type StreamDto,
  type StreamActivityGranularity,
  type WorkGraphDefaultsDto,
  DEFAULT_STREAM_CHARTER_HINTS,
} from "@claxedo/workgraph/contracts"
import { Button } from "@opencode-ai/ui/button"
import { RichTextEditor } from "@/ui/rich-text"
import type { WorkGraphApiError } from "../api"
import { HARNESS_DISPLAY_NAMES } from "@/ui/harness-display"
import { createEffect, createSignal, For, Show, untrack } from "solid-js"
import type { JSX } from "@solidjs/web"
import {
  agentChoices,
  baseRevisionChoices,
  connectionChoices,
  effortChoices,
  environmentChoices,
  environmentPolicy,
  harnessChoices,
  modelChoices,
  providerChoices,
  providerModelChoices,
  toolChoices,
} from "./settings-capabilities"
import { DetailState, WorkGraphDialog } from "./workgraph-dialog"
import { ProjectPicker, type LocalProjectOption } from "../project-picker"

export type WorkGraphSettingsSource = {
  defaults: () => Promise<WorkGraphDefaultsDto>
  saveDefaults: (expectedVersion: number, defaults: { execution: ExecutionProfileDefaults }) => Promise<CommandResult>
}

/**
 * WorkGraph-wide runtime defaults, rendered as the Settings view of the shared
 * WorkspacePanel (never a separate modal, never inner tabs).
 * `active` gates the resource so the defaults are only fetched while Settings shows.
 */
export function WorkGraphSettingsView(props: {
  active: boolean
  source: WorkGraphSettingsSource
  capabilities?: ExecutionCapabilities
  capabilitiesError?: WorkGraphApiError
  capabilitiesLoading?: boolean
  onClose?: () => void
}) {
  const detail = createAsyncState(async () => {
    const source = (() => (props.active ? true : undefined))()
    if (!source) return undefined
    return props.source.defaults()
  })
  const refetch = detail.refresh
  return (
    <div class="workgraph-settings-view">
      <header class="workgraph-settings-heading">
        <h2 class="text-sm font-semibold text-text-strong">WorkGraph settings</h2>
        <p class="text-xs leading-4 text-text-base">
          Default harness, agent, model, effort, and connections used by Streams.
        </p>
      </header>
      <DetailState resource={detail} retry={refetch}>
        {(current) => (
          <SettingsForm
            variant="panel"
            showActivity={false}
            execution={current.defaults.execution}
            capabilities={props.capabilities}
            capabilitiesError={props.capabilitiesError}
            capabilitiesLoading={props.capabilitiesLoading}
            onCancel={() => props.onClose?.()}
            save={async (execution) => {
              const result = await props.source.saveDefaults(detail.data()?.version ?? current.version, { execution })
              if (result.ok) await refetch()
              return result
            }}
          />
        )}
      </DetailState>
    </div>
  )
}

export type StreamSettingsSource = {
  workgraphDefaults: () => Promise<WorkGraphDefaultsDto>
  save: (
    streamId: string,
    expectedVersion: number,
    settings: {
      execution: ExecutionProfileDefaults
      activityGranularity: StreamActivityGranularity
      charterText: string
      charterChanged: boolean
      confirmAutonomy?: boolean
    },
  ) => Promise<CommandResult>
}

type StreamSettingsProps = {
  onClose: () => void
  stream: StreamDto | undefined
  source: StreamSettingsSource
  capabilities?: ExecutionCapabilities
  capabilitiesError?: WorkGraphApiError
  capabilitiesLoading?: boolean
  localProjects?: readonly LocalProjectOption[]
  onChooseLocalProject?: () => Promise<string | undefined>
}

/** Stream settings rendered in the shared WorkGraph panel, matching the
 * WorkGraph-level settings surface instead of opening a second modal shell. */
export function StreamSettingsView(props: StreamSettingsProps & { active: boolean }) {
  return (
    <div class="workgraph-settings-view">
      <header class="workgraph-settings-heading">
        <h2 class="text-sm font-semibold text-text-strong">Stream settings</h2>
        <p class="text-xs leading-4 text-text-base">{props.stream?.title}</p>
      </header>
      <StreamSettingsContent {...props} active={props.active} />
    </div>
  )
}

/** Retained for focused embeddings outside the WorkGraph surface. The primary
 * app flow uses StreamSettingsView so both settings scopes share one panel. */
export function StreamSettingsDialog(props: StreamSettingsProps & { open: boolean }) {
  return (
    <WorkGraphDialog
      open={props.open && !!props.stream}
      onClose={props.onClose}
      title="Stream settings"
      description={props.stream?.title}
      size="large"
      scrollBody
    >
      <StreamSettingsContent {...props} active={props.open} flush />
    </WorkGraphDialog>
  )
}

function StreamSettingsContent(props: StreamSettingsProps & { active: boolean; flush?: boolean }) {
  // Gate on a reactive SOURCE (the open stream), not a condition inside the fetcher.
  // The surface may stay mounted while closed, so a single-arg fetcher would run
  // once while inactive and never refetch when it becomes visible.
  const inherited = createAsyncState(async () => {
    const source = (() => (props.active ? props.stream?.id : undefined))()
    if (!source) return undefined
    return props.source.workgraphDefaults()
  })
  const refetch = inherited.refresh
  return (
    <Show when={props.stream?.id} keyed>
      {(_streamId) => {
        const stream = props.stream!
        return (
          <DetailState resource={inherited} retry={refetch}>
            {(workgraph) => (
              <SettingsForm
                variant="dialog"
                flush={props.flush}
                showActivity
                execution={stream.executionDefaults}
                charterText={stream.charter?.text ?? ""}
                activityGranularity={stream.activityGranularity}
                inheritedExecution={workgraph.defaults.execution}
                capabilities={props.capabilities}
                capabilitiesError={props.capabilitiesError}
                capabilitiesLoading={props.capabilitiesLoading}
                localProjects={props.localProjects}
                onChooseLocalProject={props.onChooseLocalProject}
                onCancel={props.onClose}
                save={async (execution, activityGranularity, charterText, confirmAutonomy) => {
                  const result = await props.source.save(stream.id, stream.version, {
                    execution,
                    activityGranularity: activityGranularity ?? "progress",
                    charterText: charterText ?? "",
                    charterChanged: (charterText ?? "") !== (stream.charter?.text ?? ""),
                    ...(confirmAutonomy ? { confirmAutonomy: true } : {}),
                  })
                  if (result.ok) props.onClose()
                  return result
                }}
              />
            )}
          </DetailState>
        )
      }}
    </Show>
  )
}

type ConnectionId = NonNullable<ExecutionProfileDefaults["connectionIds"]>[number]

const modelKey = (model?: { providerId: string; modelId: string }) =>
  model ? `${model.providerId}/${model.modelId}` : ""
const providerlessHarness = (harnessId: string) => harnessId === "pi"

/** Title-cases a catalog enum value for display without inventing new options. */
const humanize = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/[-_]/g, " ") : value

type SettingsFormProps = {
  variant: "panel" | "dialog"
  flush?: boolean
  showActivity: boolean
  execution: ExecutionProfileDefaults
  activityGranularity?: StreamActivityGranularity
  charterText?: string
  inheritedExecution?: ExecutionProfileDefaults
  capabilities?: ExecutionCapabilities
  capabilitiesError?: WorkGraphApiError
  capabilitiesLoading?: boolean
  localProjects?: readonly LocalProjectOption[]
  onChooseLocalProject?: () => Promise<string | undefined>
  onCancel: () => void
  save: (
    execution: ExecutionProfileDefaults,
    activityGranularity?: StreamActivityGranularity,
    charterText?: string,
    confirmAutonomy?: boolean,
  ) => Promise<CommandResult>
}

/** Remount once a capability catalog arrives so catalog-derived defaults are
 *  construction-time state, not an effect that mutates signals after render. */
function SettingsForm(props: SettingsFormProps) {
  return (
    <Show when={props.capabilities} keyed fallback={<SettingsFormBody {...props} />}>
      {(capabilities) => <SettingsFormBody {...props} capabilities={capabilities} />}
    </Show>
  )
}

function executionWithCatalogDefaults(
  execution: ExecutionProfileDefaults,
  capabilities: ExecutionCapabilities | undefined,
  variant: SettingsFormProps["variant"],
) {
  if (!capabilities || variant === "dialog") return execution
  const harness = execution.harness ?? harnessChoices(capabilities)[0]
  const provider =
    execution.model?.providerId ??
    (harness
      ? (providerChoices(capabilities, harness).find((providerId) =>
          providerModelChoices(capabilities, harness, providerId).some((option) => option.efforts.length > 0),
        ) ?? providerChoices(capabilities, harness)[0])
      : undefined)
  const catalogModel =
    harness && provider
      ? (providerModelChoices(capabilities, harness, provider).find(
          (option) => execution.model?.modelId === option.modelId,
        ) ??
        providerModelChoices(capabilities, harness, provider).find((option) => option.efforts.length > 0) ??
        providerModelChoices(capabilities, harness, provider)[0])
      : undefined
  const model = execution.model ?? catalogModel
  return {
    ...execution,
    ...(harness ? { harness } : {}),
    ...(harness && (execution.agent ?? agentChoices(capabilities, harness)[0]?.id)
      ? { agent: execution.agent ?? agentChoices(capabilities, harness)[0]?.id }
      : {}),
    ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
    ...((execution.effort ?? catalogModel?.efforts[0]) ? { effort: execution.effort ?? catalogModel?.efforts[0] } : {}),
  }
}

function SettingsFormBody(props: SettingsFormProps) {
  const initial = untrack(() => ({
    execution: executionWithCatalogDefaults(props.execution, props.capabilities, props.variant),
    connectionIds: [...(props.execution.connectionIds ?? [])],
    connectionsOverride: props.execution.connectionIds !== undefined,
    activityGranularity: props.activityGranularity ?? "progress",
    charter: props.charterText ?? "",
  }))
  const execution = initial.execution
  const [environment, setEnvironment] = createSignal(execution.environment?.kind ?? "")
  const [localDirectory, setLocalDirectory] = createSignal(
    execution.environment?.kind === "local_worktree" ? (execution.environment.directory ?? "") : "",
  )
  const [repositoryUrl, setRepositoryUrl] = createSignal(
    execution.environment?.kind === "hosted_workspace"
      ? (execution.environment.repositoryUrl ?? execution.repository?.remoteUrl ?? "")
      : "",
  )
  const [baseRevision, setBaseRevision] = createSignal(execution.repository?.baseRevision ?? "")
  const [profile, setProfile] = createSignal({
    harness: execution.harness ?? "",
    agent: execution.agent ?? "",
    provider: execution.model?.providerId ?? "",
    model: modelKey(execution.model),
    effort: execution.effort ?? "",
  })
  const harness = () => profile().harness
  const agent = () => profile().agent
  const provider = () => profile().provider
  const model = () => profile().model
  const effort = () => profile().effort
  const setAgent = (value: string) => setProfile({ ...profile(), agent: value })
  const setEffort = (value: string) => setProfile({ ...profile(), effort: value })
  const [connectionIds, setConnectionIds] = createSignal<ConnectionId[]>(initial.connectionIds)
  const [connectionsOverride, setConnectionsOverride] = createSignal(initial.connectionsOverride)
  const [activityGranularity, setActivityGranularity] = createSignal<StreamActivityGranularity>(
    initial.activityGranularity,
  )
  const [charter, setCharter] = createSignal(initial.charter)
  const [autonomy, setAutonomy] = createSignal(execution.autonomy ?? "supervised")
  const [confirmingAutonomy, setConfirmingAutonomy] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  // Stream targets are owned by the Stream, while execution-profile fields may
  // fall back to the WorkGraph defaults. Keep those two states explicit instead
  // of describing every empty Stream field as inherited.
  const emptyLabel = props.variant === "dialog" ? "WorkGraph default" : "Not set"
  const requiredLabel = "Select…"
  const hasCaps = () => !!props.capabilities
  const cap = () => props.capabilities as ExecutionCapabilities

  // Every option is projected from the capability catalog via the helpers, narrowed
  // by the dependent selection: harness scopes agent/model/tools, model scopes
  // effort, and environment scopes repository inputs. An
  // empty list means the catalog advertises nothing for the current selection — the
  // field still offers the empty choice so an orphaned value can be cleared.
  const harnessIds = () => (hasCaps() ? harnessChoices(cap()) : [])
  const agentsFor = () => (hasCaps() && harness() ? agentChoices(cap(), harness()) : [])
  const providersFor = () => (hasCaps() && harness() ? providerChoices(cap(), harness()) : [])
  const modelsFor = () => {
    if (!hasCaps() || !harness()) return []
    if (providerlessHarness(harness())) return modelChoices(cap(), harness())
    return provider() ? providerModelChoices(cap(), harness(), provider()) : []
  }
  const chosenModel = () => modelsFor().find((option) => modelKey(option) === model())
  const effortsFor = () => {
    const chosen = chosenModel()
    return hasCaps() && harness() && chosen ? effortChoices(cap(), harness(), chosen.providerId, chosen.modelId) : []
  }
  const envKinds = () => (hasCaps() ? environmentChoices(cap()) : [])
  const policy = () =>
    hasCaps() && environment()
      ? environmentPolicy(cap(), environment() as ExecutionEnvironmentCapability["kind"])
      : undefined
  // Repository inputs follow the selected environment's policy exactly: remote URL is
  // only shown/edited when `remoteUrlInput`, base revision is a free-text field when
  // `baseRevisionInput` and otherwise a select limited to the exact revisions the
  // catalog advertises.
  const baseRevisionFreeText = () => !!policy()?.baseRevisionInput
  const baseRevisionCatalog = () => (hasCaps() ? baseRevisionChoices(cap()) : [])
  const toolsFor = () => (hasCaps() && harness() ? toolChoices(cap(), harness()) : [])
  const connectionsFor = () => (hasCaps() && harness() === "opencode" ? connectionChoices(cap()) : [])

  const environmentOptions = () => envKinds().map((kind) => ({ value: kind, label: humanize(kind) }))
  const harnessOptions = () =>
    harnessIds().map((id) => ({ value: id, label: HARNESS_DISPLAY_NAMES[id] ?? humanize(id) }))
  const agentOptions = () => agentsFor().map((option) => ({ value: option.id, label: option.label }))
  const providerOptions = () => providersFor().map((id) => ({ value: id, label: humanize(id) }))
  const modelOptions = () =>
    modelsFor().map((option) => ({
      value: modelKey(option),
      label: providerlessHarness(harness()) ? `${option.label} (${humanize(option.providerId)})` : option.label,
    }))
  const effortOptions = () => effortsFor().map((value) => ({ value, label: value }))
  const baseRevisionOptions = () =>
    baseRevisionFreeText() ? [] : baseRevisionCatalog().map((value) => ({ value, label: value }))
  const connectionOptions = () =>
    connectionsFor().map((connection) => ({
      id: connection.id as string,
      label: connection.accountLabel ?? connection.integrationId,
    }))

  const preferredModel = (models: ReturnType<typeof modelsFor>) =>
    models.find((option) => option.efforts.length > 0) ?? models[0]
  const preferredProvider = (harnessId: string) => {
    const providers = providerChoices(cap(), harnessId)
    return (
      providers.find((providerId) =>
        providerModelChoices(cap(), harnessId, providerId).some((option) => option.efforts.length > 0),
      ) ??
      providers[0] ??
      ""
    )
  }
  const modelDefaults = (harnessId: string, providerId: string) => {
    const next = preferredModel(
      providerlessHarness(harnessId)
        ? modelChoices(cap(), harnessId)
        : providerModelChoices(cap(), harnessId, providerId),
    )
    return {
      provider: next?.providerId ?? providerId,
      model: next ? modelKey(next) : "",
      effort: next?.efforts[0] ?? "",
    }
  }
  const changeEnvironment = (kind: string) => {
    setEnvironment(kind)
    if (kind && !baseRevision()) setBaseRevision(baseRevisionChoices(cap())[0] ?? "")
  }
  const changeHarness = (id: string) => {
    const nextAgent = id ? (agentChoices(cap(), id)[0]?.id ?? "") : ""
    const nextProvider = id ? preferredProvider(id) : ""
    setProfile({
      harness: id,
      agent: nextAgent,
      ...modelDefaults(id, nextProvider),
    })
    if (id !== "opencode") {
      setConnectionsOverride(false)
      setConnectionIds([])
    }
  }
  const changeProvider = (id: string) => {
    const current = profile()
    setProfile({ ...current, ...modelDefaults(current.harness, id) })
  }
  const changeModel = (value: string) => {
    const next = modelsFor().find((option) => modelKey(option) === value)
    const current = profile()
    setProfile({
      ...current,
      provider: next?.providerId ?? current.provider,
      model: value,
      effort: next?.efforts[0] ?? "",
    })
  }

  const automaticTools = () => {
    const granted = new Set(
      connectionsFor()
        .filter((connection) => connectionsOverride() && connectionIds().includes(connection.id))
        .flatMap((connection) => connection.grantedCapabilities),
    )
    return toolsFor()
      .filter((tool) => !tool.requiresConnectionCapability || granted.has(tool.requiresConnectionCapability))
      .map((tool) => tool.id)
  }

  const optionValid = (value: string, options: readonly { value: string }[]) =>
    !value || options.some((option) => option.value === value)
  const idsValid = (selected: readonly string[], options: readonly { id: string }[]) =>
    selected.every((id) => options.some((option) => option.id === id))

  // The catalog is the single source of truth: an absent catalog or any selection
  // it does not advertise blocks Save and keeps the current values on screen.
  const capabilityError = () => {
    // The exact capability resource failure is surfaced verbatim and fails closed;
    // an in-flight load is explicit (never mistaken for a connected empty catalog).
    if (props.capabilitiesError) return props.capabilitiesError.message
    if (props.capabilitiesLoading) return "Loading the capability catalog…"
    if (!hasCaps()) return "Capability catalog isn't connected — these values are read-only until it reconnects."
    if (props.variant === "dialog" && !environment()) return "This Stream needs an execution environment."
    // A hosted repository target is unusable without a remote URL the runtime can
    // clone, so a base revision under an environment that inputs a remote URL blocks
    // Save here rather than deferring to a backend rejection.
    if (props.variant === "dialog" && environment() === "local_worktree" && !localDirectory().trim())
      return "This Stream needs its local project directory."
    if (props.variant === "dialog" && environment() === "hosted_workspace" && !repositoryUrl().trim())
      return "This Stream needs its GitHub repository URL."
    // Only the policy — never an invented "main"/default — decides whether a base
    // revision is mandatory; block Save while a required repository field is blank.
    if (props.variant === "dialog" && !baseRevision().trim()) return "This Stream requires a base revision to save."
    if (props.variant === "panel" && (!harness() || !agent() || !provider() || !model() || !effort())) {
      return "The capability catalog did not provide a complete default execution profile."
    }
    const valid =
      (props.variant === "panel" || optionValid(environment(), environmentOptions())) &&
      // A free-text base revision accepts any typed value; a select-backed one must
      // match one of the exact advertised revisions.
      (props.variant === "panel" || baseRevisionFreeText() || optionValid(baseRevision(), baseRevisionOptions())) &&
      optionValid(harness(), harnessOptions()) &&
      optionValid(agent(), agentOptions()) &&
      optionValid(provider(), providerOptions()) &&
      optionValid(model(), modelOptions()) &&
      optionValid(effort(), effortOptions()) &&
      (!connectionsOverride() || idsValid(connectionIds(), connectionOptions()))
    return valid ? undefined : "Some selected values aren't offered by the capability catalog. Adjust them to save."
  }

  const toggleConnection = (id: string, on: boolean) => {
    setConnectionIds((prev) => (on ? [...prev, id as ConnectionId] : prev.filter((connection) => connection !== id)))
    if (on) setConnectionsOverride(true)
  }
  const setConnectionsMode = (on: boolean) => {
    setConnectionsOverride(on)
    setConnectionIds([])
  }

  const buildExecution = (): ExecutionProfileDefaults => {
    const chosen = chosenModel()
    const placement = execution.environment?.placement ?? "shared"
    return {
      ...(props.showActivity ? { autonomy: autonomy() } : execution.autonomy ? { autonomy: execution.autonomy } : {}),
      ...(execution.budget ? { budget: execution.budget } : {}),
      ...(execution.maxParallel === undefined ? {} : { maxParallel: execution.maxParallel }),
      ...(execution.mayPromote === undefined ? {} : { mayPromote: execution.mayPromote }),
      ...(execution.agents ? { agents: execution.agents } : {}),
      ...(execution.assignments ? { assignments: execution.assignments } : {}),
      ...(props.variant === "dialog" && environment() === "local_worktree"
        ? { environment: { kind: "local_worktree" as const, placement, directory: localDirectory().trim() } }
        : {}),
      ...(props.variant === "dialog" && environment() === "hosted_workspace"
        ? { environment: { kind: "hosted_workspace" as const, placement, repositoryUrl: repositoryUrl().trim() } }
        : {}),
      ...(props.variant === "dialog" && baseRevision().trim()
        ? { repository: { baseRevision: baseRevision().trim() } }
        : {}),
      ...(harness().trim() ? { harness: harness().trim() } : {}),
      ...(agent().trim() ? { agent: agent().trim() } : {}),
      ...(chosen ? { model: { providerId: chosen.providerId, modelId: chosen.modelId } } : {}),
      ...(effort().trim() ? { effort: effort().trim() } : {}),
      // Harness-native tools are not a user-facing policy choice. Runs execute in
      // the Stream workspace with every native tool the selected harness
      // advertises. Connection tools remain capability-gated by the selected Connections.
      tools: automaticTools(),
      ...(connectionsOverride() || props.variant === "panel"
        ? { connectionIds: connectionsOverride() ? connectionIds() : [] }
        : {}),
    }
  }

  const submit = async (confirmAutonomy = false) => {
    if (busy() || capabilityError()) return
    if (props.showActivity && execution.autonomy !== "autonomous" && autonomy() === "autonomous" && !confirmAutonomy) {
      setConfirmingAutonomy(true)
      return
    }
    setBusy(true)
    setError()
    try {
      const result = await props.save(
        buildExecution(),
        props.showActivity ? activityGranularity() : undefined,
        props.showActivity ? charter() : undefined,
        confirmAutonomy,
      )
      if (!result.ok)
        setError(
          result.error.code === "version_conflict"
            ? "These settings changed elsewhere. Reload before saving."
            : result.error.message,
        )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div class={["workgraph-settings-form", { "is-dialog": !!props.flush }]}>
        <div class="workgraph-settings-scroll">
          <div class="workgraph-settings">
            <Show when={props.showActivity}>
              <div class="workgraph-settings-section-title">Charter</div>
              <div class="workgraph-settings-charter">
                <RichTextEditor
                  value={charter()}
                  onChange={setCharter}
                  ariaLabel="Stream charter"
                  placeholder="Describe how this Stream should operate…"
                />
                <Show when={!charter().trim()}>
                  <div class="workgraph-settings-charter-defaults" role="note">
                    <div>Blank charter defaults</div>
                    <ul>
                      {DEFAULT_STREAM_CHARTER_HINTS.map((hint) => (
                        <li>{hint}</li>
                      ))}
                    </ul>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={props.showActivity}>
              <div class="workgraph-settings-section-title">Execution</div>
              <SelectRow
                label="Autonomy"
                description="Supervised Streams ask before external actions; autonomous Streams proceed without approval, within a budget when one is set."
                value={autonomy()}
                onChange={setAutonomy}
                options={[
                  { value: "supervised", label: "Supervised" },
                  { value: "autonomous", label: "Autonomous" },
                ]}
                editable
                emptyLabel="Supervised"
              />
            </Show>
            <Show when={props.variant === "dialog"}>
              <SelectRow
                label="Environment"
                description="Where this Stream's work runs."
                value={environment()}
                onChange={changeEnvironment}
                options={environmentOptions()}
                editable={hasCaps()}
                emptyLabel={requiredLabel}
              />
              <Show when={environment() === "local_worktree"}>
                <SettingRow
                  label="Project directory"
                  description="Local Git repository used to create this Stream's worktree."
                  control={
                    <ProjectPicker
                      value={localDirectory()}
                      projects={props.localProjects ?? []}
                      onChange={setLocalDirectory}
                      onChoose={props.onChooseLocalProject}
                      onError={(cause) => setError(cause instanceof Error ? cause.message : String(cause))}
                    />
                  }
                />
              </Show>
              <Show when={environment() === "hosted_workspace"}>
                <TextRow
                  label="GitHub repository URL"
                  description="Repository cloned into this Stream's cloud workspace."
                  value={repositoryUrl()}
                  onChange={setRepositoryUrl}
                  placeholder="https://github.com/owner/repository.git"
                />
              </Show>
              <Show
                when={baseRevisionFreeText()}
                fallback={
                  <SelectRow
                    label="Base revision"
                    description="Git ref used to create this Stream's workspace."
                    value={baseRevision()}
                    onChange={setBaseRevision}
                    options={baseRevisionOptions()}
                    editable={hasCaps()}
                    emptyLabel={requiredLabel}
                  />
                }
              >
                <TextRow
                  label="Base revision"
                  description="Choose an advertised ref or enter another valid Git revision."
                  value={baseRevision()}
                  onChange={setBaseRevision}
                  options={baseRevisionCatalog()}
                />
              </Show>
            </Show>
            <SelectRow
              label="Harness"
              description="Agent runtime that owns the session and its permissions."
              value={harness()}
              onChange={changeHarness}
              options={harnessOptions()}
              editable={hasCaps()}
              emptyLabel={emptyLabel}
              inherited={props.inheritedExecution?.harness}
            />
            <SelectRow
              label="Agent"
              description="Behavior profile used for planning and execution."
              value={agent()}
              onChange={setAgent}
              options={agentOptions()}
              editable={hasCaps()}
              emptyLabel={emptyLabel}
              inherited={props.inheritedExecution?.agent}
            />
            <Show when={!providerlessHarness(harness())}>
              <SelectRow
                label="Provider"
                description="Model service connected to the selected harness."
                value={provider()}
                onChange={changeProvider}
                options={providerOptions()}
                editable={hasCaps()}
                emptyLabel={emptyLabel}
                inherited={props.inheritedExecution?.model?.providerId}
              />
            </Show>
            <SelectRow
              label="Model"
              description="Model used for every provider turn in the run."
              value={model()}
              onChange={changeModel}
              options={modelOptions()}
              editable={hasCaps()}
              emptyLabel={emptyLabel}
              inherited={modelKey(props.inheritedExecution?.model) || undefined}
            />
            <SelectRow
              label="Effort"
              description="Reasoning depth requested from the selected model."
              value={effort()}
              onChange={setEffort}
              options={effortOptions()}
              editable={hasCaps()}
              emptyLabel={emptyLabel}
              inherited={props.inheritedExecution?.effort}
            />
            <Show when={harness() === "opencode"}>
              <ConnectionRow
                label="Connections"
                description="External accounts a Run may use through scoped broker tools."
                options={connectionOptions()}
                selected={connectionIds()}
                onToggle={toggleConnection}
                override={connectionsOverride()}
                onOverride={setConnectionsMode}
                emptyLabel={emptyLabel}
                editable={hasCaps()}
              />
            </Show>
            <Show when={props.showActivity}>
              <div class="workgraph-settings-section-title">Activity</div>
              <SelectRow
                label="Detail"
                description="How much meaningful Task progress appears in the activity timeline. Lifecycle, blockers, evidence, and completion always remain visible."
                value={activityGranularity()}
                onChange={(value) => setActivityGranularity(value as StreamActivityGranularity)}
                options={[
                  { value: "milestones", label: "Milestones" },
                  { value: "progress", label: "Progress" },
                  { value: "detailed", label: "Detailed" },
                ]}
                editable
                emptyLabel="Progress"
              />
            </Show>
          </div>
        </div>
        <div class="workgraph-settings-footer">
          <Show when={capabilityError() ?? error()}>
            {(message) => (
              <p class="workgraph-settings-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <div class="workgraph-settings-actions">
            <Button size="small" variant="ghost" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={busy() || !!capabilityError()}
              onClick={() => void submit()}
            >
              {busy() ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
      <WorkGraphDialog
        open={confirmingAutonomy()}
        onClose={() => setConfirmingAutonomy(false)}
        title="Enable autonomous Stream?"
        footer={
          <>
            <Button size="small" variant="ghost" onClick={() => setConfirmingAutonomy(false)}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="primary"
              onClick={() => {
                setConfirmingAutonomy(false)
                void submit(true)
              }}
            >
              Enable autonomy and save
            </Button>
          </>
        }
      >
        <p class="text-sm leading-5 text-text-base">
          This Stream will proceed without approval under its promotion policy, within a budget when one is set.
        </p>
      </WorkGraphDialog>
    </>
  )
}

/** A field row: label and explanation form one readable left column; the
 *  interactive value and state notes stay aligned in the right column. */
function SettingRow(props: {
  label: string
  description?: string
  note?: string
  inherited?: string
  control: JSX.Element
}) {
  return (
    <div class="workgraph-setting-row">
      <div class="workgraph-setting-copy">
        <div class="workgraph-setting-label text-text-base">{props.label}</div>
        <Show when={props.description}>
          <div class="workgraph-setting-desc text-text-base">{props.description}</div>
        </Show>
      </div>
      <div class="workgraph-setting-side">
        <div class="workgraph-setting-control">{props.control}</div>
        <Show when={props.note}>
          <div class="workgraph-setting-note text-text-weaker" role="note">
            {props.note}
          </div>
        </Show>
        <Show when={props.inherited}>
          <div class="workgraph-setting-inherit text-text-weaker">WorkGraph default: {props.inherited}</div>
        </Show>
      </div>
    </div>
  )
}

/** A single-value field whose choices are projected from the capability catalog.
 *  Editable only when the catalog is connected; otherwise it shows the current
 *  value read-only with an explicit note — never invented choices. When editable
 *  but the current value isn't advertised, the value is preserved and surfaced so
 *  the reason Save is blocked stays visible. */
function SelectRow(props: {
  label: string
  /** Overrides the control's accessible name when the visible label alone would collide. */
  ariaLabel?: string
  description?: string
  value: string
  onChange: (value: string) => void
  options: readonly { value: string; label: string }[]
  editable: boolean
  emptyLabel: string
  inherited?: string
}) {
  const staleValue = () =>
    props.value && !props.options.some((option) => option.value === props.value) ? props.value : undefined
  let select: HTMLSelectElement | undefined
  createEffect(
    () => (props.editable ? props.value : undefined),
    (value) => {
      if (select && value !== undefined) select.value = value
    },
  )
  return (
    <Show
      when={props.editable}
      fallback={
        <SettingRow
          label={props.label}
          description={props.description}
          inherited={props.inherited}
          note="Capability catalog not connected"
          control={<span class="workgraph-setting-value text-text-base">{props.value || props.emptyLabel}</span>}
        />
      }
    >
      <SettingRow
        label={props.label}
        description={props.description}
        inherited={props.inherited}
        note={staleValue() ? `Current value “${staleValue()}” isn't offered by the catalog` : undefined}
        control={
          <select
            ref={select}
            class="workgraph-setting-select"
            aria-label={props.ariaLabel ?? props.label}
            value={props.value}
            onChange={(event) => props.onChange(event.currentTarget.value)}
          >
            <option value="">{props.emptyLabel}</option>
            <For each={props.options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
          </select>
        }
      />
    </Show>
  )
}

function TextRow(props: {
  label: string
  description?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  inherited?: string
  numeric?: boolean
  options?: readonly string[]
}) {
  const list = () =>
    props.options?.length ? `workgraph-${props.label.toLowerCase().replace(/\s+/g, "-")}-choices` : undefined
  return (
    <SettingRow
      label={props.label}
      description={props.description}
      inherited={props.inherited}
      control={
        <>
          <input
            class="workgraph-setting-input"
            aria-label={props.label}
            inputmode={props.numeric ? "numeric" : undefined}
            list={list()}
            value={props.value}
            placeholder={props.placeholder}
            onInput={(event) => props.onChange(event.currentTarget.value)}
          />
          <Show when={list()}>
            {(id) => (
              <datalist id={id()}>
                <For each={props.options}>{(option) => <option value={option} />}</For>
              </datalist>
            )}
          </Show>
        </>
      }
    />
  )
}

/** A multi-value Connection field projected from the catalog.
 *  Selections the catalog no longer advertises are still listed so they can be
 *  unchecked; when the catalog is disconnected the current selection is read-only.
 *  A single compact mode control renders inline ahead of the checkboxes so the field
 *  can express a truthful tri-state: WorkGraph default (the override is absent) versus
 *  explicitly None (an emitted empty override) versus a specific selection. */
function ConnectionRow(props: {
  label: string
  description?: string
  options: readonly { id: string; label: string }[]
  selected: readonly string[]
  onToggle: (id: string, on: boolean) => void
  override: boolean
  onOverride: (on: boolean) => void
  emptyLabel: string
  editable: boolean
}) {
  // Union of advertised options and any already-selected ids, so an orphaned
  // selection stays visible and clearable without fabricating catalog options.
  const merged = () => {
    const orphans = props.selected
      .filter((id) => !props.options.some((option) => option.id === id))
      .map((id) => ({ id, label: id }))
    return [...props.options, ...orphans]
  }
  return (
    <SettingRow
      label={props.label}
      description={props.description}
      note={props.editable ? undefined : "Capability catalog not connected"}
      control={
        <Show
          when={props.editable}
          fallback={
            <div class="workgraph-setting-tools">
              <For each={props.selected} fallback={<span class="text-text-weaker text-sm">none</span>}>
                {(id) => <span class="workgraph-tool-pill">{id}</span>}
              </For>
            </div>
          }
        >
          <div class="workgraph-setting-tools">
            {/* The one compact control: WorkGraph default vs explicitly None. Ticking an item
                below also enables the override; this control is the only way back to absent. */}
            <select
              class="workgraph-setting-select"
              aria-label={`${props.label} override`}
              value={props.override ? "explicit" : "inherit"}
              onChange={(event) => props.onOverride(event.currentTarget.value === "explicit")}
            >
              <option value="inherit">{props.emptyLabel}</option>
              <option value="explicit">{props.selected.length ? "Custom" : "None"}</option>
            </select>
            <For each={merged()} fallback={<span class="text-text-weaker text-sm">none</span>}>
              {(item) => (
                <label class="workgraph-tool-pill">
                  <input
                    type="checkbox"
                    checked={props.selected.includes(item.id)}
                    onChange={(event) => props.onToggle(item.id, event.currentTarget.checked)}
                  />{" "}
                  {item.label}
                </label>
              )}
            </For>
          </div>
        </Show>
      }
    />
  )
}
