import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { AgentGlyph } from "./agent-glyph"
import { useData, type SubagentView } from "../context"

/**
 * SubagentChip row (T12/T13) — when a turn spawns ≥2 subagents, they render as chips
 * instead of stacked cards (D§3.8): a deterministic glyph + agent name + status suffix,
 * first 3 shown then "and N other agents". Clicking a chip opens the child session.
 */
type ChipModel = {
  key: string
  childSessionId?: string
  name: string
  status: SubagentView["status"]
  resolution: SubagentView["resolution"]
  color?: string
}

function fallbackChip(part: ToolPart): ChipModel {
  const state = part.state as {
    status?: string
    input?: Record<string, unknown>
  }
  const input = state.input ?? {}
  const name =
    (typeof input.subagent_type === "string" && input.subagent_type) ||
    (typeof input.description === "string" && input.description) ||
    "agent"
  const status: ChipModel["status"] =
    state.status === "running" || state.status === "pending"
      ? "running"
      : state.status === "error"
        ? "interrupted"
        : "completed"
  return { key: part.id, name, status, resolution: "unavailable", color: undefined }
}

function chipFromView(view: SubagentView): ChipModel {
  return {
    key: view.subagentKey,
    childSessionId: view.childSessionId,
    name: view.agentLabel || view.label,
    status: view.status,
    resolution: view.resolution,
  }
}

function statusLabel(status: ChipModel["status"]) {
  if (status === "running" || status === "pending") return "working"
  if (status === "completed") return "done"
  if (status === "unknown") return "status unavailable"
  return status
}

export function SubagentChipRow(props: {
  parts?: ToolPart[]
  subagents?: SubagentView[]
  onOpen?: (childSessionId: string, origin: HTMLButtonElement) => void
}) {
  const data = useData()
  const chips = createMemo(() => {
    if (props.subagents) return props.subagents.map(chipFromView)
    return (props.parts ?? []).flatMap((part) => {
      const explicit = data.resolveSubagents?.(part.sessionID, part.callID) ?? []
      return explicit.length > 0 ? explicit.map(chipFromView) : [fallbackChip(part)]
    })
  })
  const visible = createMemo(() => chips().slice(0, 3))
  const overflow = createMemo(() => Math.max(0, chips().length - 3))

  return (
    <div data-component="subagent-chip-row">
      <For each={visible()}>
        {(chip) => {
          const content = () => (
            <>
              <AgentGlyph seed={chip.childSessionId || chip.key} active={chip.status === "running"} size={14} />
              <span data-slot="subagent-chip-name">{chip.name}</span>
              <span data-slot="subagent-chip-status" aria-live="polite">{statusLabel(chip.status)}</span>
            </>
          )
          const openable = () => chip.resolution === "ready" && !!chip.childSessionId
          return (
            <Show
              when={openable()}
              fallback={
                <span
                  data-component="subagent-chip"
                  data-subagent-key={chip.key}
                  data-status={chip.status}
                  aria-label={`${chip.name}, ${statusLabel(chip.status)}, transcript unavailable`}
                >
                  {content()}
                </span>
              }
            >
              <button
                type="button"
                data-component="subagent-chip"
                data-subagent-key={chip.key}
                data-status={chip.status}
                aria-label={`${chip.name}, ${statusLabel(chip.status)}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (chip.childSessionId) props.onOpen?.(chip.childSessionId, event.currentTarget)
                }}
              >
                {content()}
              </button>
            </Show>
          )
        }}
      </For>
      <Show when={overflow() > 0}>
        <span data-slot="subagent-chip-overflow">
          and {overflow()} other {overflow() === 1 ? "agent" : "agents"}
        </span>
      </Show>
    </div>
  )
}
