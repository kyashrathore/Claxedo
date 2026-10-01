import { createMemo, createSignal, For, Show } from "solid-js"
import type { AgentToolPart } from "@claxedo/agent-runtime-contract"
import { useTranscriptI18n, type TranscriptI18n, type TranscriptTextKey } from "./i18n"
import { AgentGlyph } from "./agent-glyph"
import { useData, type SubagentView } from "./data"
import { clampLabel } from "./message-part-text"
import { asRecord } from "@claxedo/helpers/guards"
import { claxedoToolArguments } from "./claxedo-tool-view"
import { safeLinkHref } from "./safe-link"
import { SubagentStopControl } from "./subagent-stop"

export function subagentSubtitle(subagent: Pick<SubagentView, "description" | "mode" | "resolution">) {
  return [
    clampLabel(subagent.description),
    subagent.mode === "background" ? "Background · continues independently" : undefined,
    subagent.resolution === "unavailable" ? "Transcript unavailable" : undefined,
    subagent.resolution === "not-yet-bound" ? "Transcript not yet available" : undefined,
  ].filter(Boolean).join(" · ")
}

type ChipModel = {
  key: string
  childSessionId?: string
  name: string
  detail?: string
  description?: string
  mode?: SubagentView["mode"]
  status: SubagentView["status"]
  resolution: SubagentView["resolution"]
  toolCallRole?: SubagentView["toolCallRole"]
  parentSessionId: string
  stopCall?: string
  color?: string
}

export function dispatchSubagentOpen(target: EventTarget | null, input: {
  childSessionId?: string
  subagentKey: string
  label?: string
  description?: string
  interaction: boolean
  openable: boolean
}) {
  if (!target || input.interaction || !input.childSessionId || !input.openable) return false
  return !target.dispatchEvent(new CustomEvent("claxedo:open-subagent", {
    bubbles: true,
    cancelable: true,
    detail: {
      childSessionId: input.childSessionId,
      subagentKey: input.subagentKey,
      ...(input.label ? { label: input.label } : {}),
      ...(input.description ? { description: clampLabel(input.description) } : {}),
    },
  }))
}

export function subagentSpawnDetail(input: Record<string, unknown> | undefined): string | undefined {
  const args = claxedoToolArguments(input)
  const model = args.model
  const modelId = typeof model === "string" ? model : asRecord(model)?.id
  const parts = [args.configuration ?? args.harness, modelId]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

function chipFromView(view: SubagentView, detail?: string): ChipModel {
  return {
    key: view.subagentKey,
    childSessionId: view.childSessionId,
    name: view.agentLabel || view.label,
    ...(detail ? { detail } : {}),
    ...(view.description ? { description: view.description } : {}),
    ...(view.mode ? { mode: view.mode } : {}),
    status: view.status,
    resolution: view.resolution,
    ...(view.toolCallRole ? { toolCallRole: view.toolCallRole } : {}),
    parentSessionId: view.parentSessionId,
    ...(view.stopCall ? { stopCall: view.stopCall } : {}),
  }
}

export function subagentChips(views: SubagentView[], details?: ReadonlyMap<string, string>) {
  const chips = new Map<string, ChipModel>()
  for (const view of views) {
    const chip = chipFromView(view, details?.get(view.subagentKey))
    if (chips.get(chip.key)?.toolCallRole === "spawn") continue
    chips.set(chip.key, chip)
  }
  return [...chips.values()]
}

function scrollToCanonicalSpawn(chip: ChipModel) {
  const canonical = document.querySelector<HTMLElement>(
    `[data-session-timeline-session-id="${CSS.escape(chip.parentSessionId)}"] [data-subagent-key="${CSS.escape(chip.key)}"][data-subagent-role="spawn"]`,
  )
  if (!canonical) return false
  canonical.scrollIntoView({ block: "center", behavior: "smooth" })
  canonical.focus({ preventScroll: true })
  return true
}

const STATUS_KEYS: Record<SubagentView["status"], TranscriptTextKey> = {
  pending: "transcript.subagent.status.working",
  running: "transcript.subagent.status.working",
  paused: "transcript.subagent.status.paused",
  interrupted: "transcript.subagent.status.interrupted",
  completed: "transcript.subagent.status.done",
  failed: "transcript.subagent.status.failed",
  killed: "transcript.subagent.status.killed",
  unknown: "transcript.subagent.status.unknown",
}

function statusLabel(status: ChipModel["status"], i18n: TranscriptI18n) {
  return i18n.t(STATUS_KEYS[status])
}

export function subagentChipHandlesClick(input: { modified: boolean; hasHref: boolean }) {
  return !(input.modified && input.hasHref)
}

export function subagentChipUnclaimedClick(input: {
  openable: boolean
  canNavigate: boolean
  hasHref: boolean
}): "navigate" | "href" | "none" {
  if (!input.openable) return "none"
  if (input.canNavigate) return "navigate"
  return input.hasHref ? "href" : "none"
}

export function SubagentChipRow(props: {
  parts?: AgentToolPart[]
  subagents?: SubagentView[]
  spawnInput?: Record<string, unknown>
}) {
  const data = useData()
  const i18n = useTranscriptI18n()
  const chips = createMemo(() => {
    const details = new Map<string, string>()
    if (props.subagents) {
      const detail = subagentSpawnDetail(props.spawnInput)
      if (detail) for (const view of props.subagents) details.set(view.subagentKey, detail)
      return subagentChips(props.subagents, details)
    }
    const views = (props.parts ?? []).flatMap((part) => {
      const resolved = data.resolveSubagents?.(part.sessionID, part.callID) ?? []
      const detail = subagentSpawnDetail(part.state.input)
      if (detail) for (const view of resolved) if (view.toolCallRole !== "interaction") details.set(view.subagentKey, detail)
      return resolved
    })
    return subagentChips(views, details)
  })
  const [expanded, setExpanded] = createSignal(false)
  const visible = createMemo(() => (expanded() ? chips() : chips().slice(0, 3)))
  const overflow = createMemo(() => Math.max(0, chips().length - 3))

  return (
    <Show when={chips().length > 0}>
      <div data-component="subagent-chip-row">
        <For each={visible()}>
          {(chip) => {
            const summary = () => subagentSubtitle({
              description: chip.description ?? "",
              ...(chip.mode ? { mode: chip.mode } : {}),
              resolution: chip.resolution,
            })
            const content = () => (
              <>
                <AgentGlyph seed={chip.childSessionId || chip.key} active={chip.status === "running"} size={14} />
                <span data-slot="subagent-chip-name">{chip.name}</span>
                <Show when={chip.detail}>
                  <span data-slot="subagent-chip-detail" title={chip.detail}>{chip.detail}</span>
                </Show>
                <Show when={summary()}>
                  <span data-slot="subagent-chip-summary" title={chip.description || summary()}>{summary()}</span>
                </Show>
                <span data-slot="subagent-chip-status" aria-live="polite">{statusLabel(chip.status, i18n)}</span>
              </>
            )
            const interaction = () => chip.toolCallRole === "interaction"
            const openable = () => chip.resolution === "ready" && !!chip.childSessionId
            const href = () =>
              !interaction() && openable() && chip.childSessionId
                ? safeLinkHref(data.sessionHref?.(chip.childSessionId))
                : undefined
            const activate = (event: MouseEvent) => {
              event.stopPropagation()
              if (!subagentChipHandlesClick({
                modified: event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
                hasHref: !!href(),
              })) return
              if (interaction() && scrollToCanonicalSpawn(chip)) {
                event.preventDefault()
                return
              }
              if (dispatchSubagentOpen(event.currentTarget, {
                childSessionId: chip.childSessionId,
                subagentKey: chip.key,
                label: chip.name,
                ...(chip.description ? { description: chip.description } : {}),
                interaction: interaction(),
                openable: openable(),
              })) {
                event.preventDefault()
                return
              }
              if (subagentChipUnclaimedClick({
                openable: openable(),
                canNavigate: !!data.navigateToSession,
                hasHref: !!href(),
              }) !== "navigate") return
              event.preventDefault()
              if (chip.childSessionId) data.navigateToSession?.(chip.childSessionId)
            }
            const chipAttributes = () => ({
              "data-component": "subagent-chip",
              "data-subagent-key": chip.key,
              "data-subagent-role": chip.toolCallRole ?? "ambient",
              "data-status": chip.status,
            })
            return (
              <>
                <Show
                  when={openable() || interaction()}
                  fallback={
                    <span
                      {...chipAttributes()}
                      aria-label={`${chip.name}, ${statusLabel(chip.status, i18n)}, transcript unavailable`}
                    >
                      {content()}
                    </span>
                  }
                >
                  <Show
                    when={href()}
                    fallback={
                      <button
                        type="button"
                        {...chipAttributes()}
                        aria-label={`${chip.name}, ${statusLabel(chip.status, i18n)}`}
                        onClick={activate}
                      >
                        {content()}
                      </button>
                    }
                  >
                    {(value) => (
                      <a
                        href={value()}
                        {...chipAttributes()}
                        aria-label={`${chip.name}, ${statusLabel(chip.status, i18n)}`}
                        onClick={activate}
                      >
                        {content()}
                      </a>
                    )}
                  </Show>
                </Show>
                <Show when={chip.stopCall}>
                  {(call) => <SubagentStopControl parentSessionId={chip.parentSessionId} call={call()} name={chip.name} />}
                </Show>
              </>
            )
          }}
        </For>
        <Show when={overflow() > 0}>
          <button
            type="button"
            data-slot="subagent-chip-overflow"
            aria-expanded={expanded()}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded() ? "show fewer" : `and ${overflow()} other ${overflow() === 1 ? "agent" : "agents"}`}
          </button>
        </Show>
      </div>
    </Show>
  )
}
