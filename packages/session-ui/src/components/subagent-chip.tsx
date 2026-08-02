import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { AgentGlyph } from "./agent-glyph"

/**
 * SubagentChip row (T12/T13) — when a turn spawns ≥2 subagents, they render as chips
 * instead of stacked cards (D§3.8): a deterministic glyph + agent name + status suffix,
 * first 3 shown then "and N other agents". Clicking a chip opens the child session.
 */
type ChipModel = {
  key: string
  childSessionId?: string
  name: string
  status: "running" | "interrupted" | "done"
  color?: string
}

function chipFromPart(part: ToolPart): ChipModel {
  const state = part.state as {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
  const input = state.input ?? {}
  const metadata = state.metadata ?? {}
  const childSessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined
  const name =
    (typeof input.subagent_type === "string" && input.subagent_type) ||
    (typeof input.description === "string" && input.description) ||
    "agent"
  const status: ChipModel["status"] =
    state.status === "running" || state.status === "pending"
      ? "running"
      : state.status === "error"
        ? "interrupted"
        : "done"
  return { key: part.id, childSessionId, name, status, color: undefined }
}

export function SubagentChipRow(props: { parts: ToolPart[]; onOpen?: (childSessionId: string) => void }) {
  const chips = createMemo(() => props.parts.map(chipFromPart))
  const visible = createMemo(() => chips().slice(0, 3))
  const overflow = createMemo(() => Math.max(0, chips().length - 3))

  return (
    <div data-component="subagent-chip-row">
      <For each={visible()}>
        {(chip) => (
          <button
            type="button"
            data-component="subagent-chip"
            data-status={chip.status}
            disabled={!chip.childSessionId}
            onClick={(event) => {
              event.stopPropagation()
              if (chip.childSessionId) props.onOpen?.(chip.childSessionId)
            }}
          >
            <AgentGlyph seed={chip.childSessionId || chip.name} active={chip.status === "running"} size={14} />
            <span data-slot="subagent-chip-name">{chip.name}</span>
            <Show when={chip.status !== "done"}>
              <span data-slot="subagent-chip-status">
                {chip.status === "running" ? "working" : "interrupted"}
              </span>
            </Show>
          </button>
        )}
      </For>
      <Show when={overflow() > 0}>
        <span data-slot="subagent-chip-overflow">
          and {overflow()} other {overflow() === 1 ? "agent" : "agents"}
        </span>
      </Show>
    </div>
  )
}
