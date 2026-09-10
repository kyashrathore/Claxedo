import { createMemo, createSignal, For, Show } from "solid-js"
import type { AgentToolPart } from "@claxedo/agent-runtime-contract"
import { AgentGlyph } from "./agent-glyph"
import { useData, type SubagentView } from "../context"
import { clampLabel } from "./message-part-text"

/**
 * The one line under a subagent's name. `description` is whatever the runtime last
 * wrote to the row, and a finished subagent writes its own summary there — prose,
 * markdown headings and all — so it is flattened and clamped to a line's worth here.
 * Handing the full text to the layout instead leaves the row's width to whatever the
 * surrounding CSS happens to allow, and a paragraph then runs out of the transcript
 * column.
 */
export function subagentSubtitle(subagent: Pick<SubagentView, "description" | "mode" | "resolution">) {
  return [
    clampLabel(subagent.description),
    subagent.mode === "background" ? "Background · continues independently" : undefined,
    subagent.resolution === "unavailable" ? "Transcript unavailable" : undefined,
    subagent.resolution === "not-yet-bound" ? "Transcript not yet available" : undefined,
  ].filter(Boolean).join(" · ")
}

/**
 * SubagentChip row (T12/T13) — when a turn spawns ≥2 subagents, they render as chips
 * instead of stacked cards (D§3.8): a deterministic glyph + agent name + status suffix,
 * first 3 shown, with the rest behind a toggle. Clicking a chip opens the child session.
 */
type ChipModel = {
  key: string
  childSessionId?: string
  name: string
  status: SubagentView["status"]
  resolution: SubagentView["resolution"]
  color?: string
}

export function dispatchSubagentOpen(target: EventTarget | null, input: {
  childSessionId?: string
  subagentKey: string
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
    },
  }))
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
  parts?: AgentToolPart[]
  subagents?: SubagentView[]
  onOpen?: (childSessionId: string, origin: HTMLButtonElement) => void
}) {
  const data = useData()
  const chips = createMemo(() => {
    if (props.subagents) return props.subagents.map(chipFromView)
    return (props.parts ?? []).flatMap((part) =>
      (data.resolveSubagents?.(part.sessionID, part.callID) ?? []).map(chipFromView)
    )
  })
  const [expanded, setExpanded] = createSignal(false)
  const visible = createMemo(() => (expanded() ? chips() : chips().slice(0, 3)))
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
  )
}
