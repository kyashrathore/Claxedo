import { createMemo, createSignal, For, Show } from "solid-js"
import type { AgentToolPart } from "@claxedo/agent-runtime-contract"
import { useI18n, type UiI18n } from "@opencode-ai/ui/context/i18n"
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
 * One row of delegated work: a deterministic glyph, the agent's name, the one line
 * that says what it was asked to do, and its status. The first 3 show, the rest sit
 * behind a toggle. Activating a chip opens the child session.
 */
type ChipModel = {
  key: string
  childSessionId?: string
  name: string
  description?: string
  mode?: SubagentView["mode"]
  status: SubagentView["status"]
  resolution: SubagentView["resolution"]
  toolCallRole?: SubagentView["toolCallRole"]
  parentSessionId: string
  color?: string
}

export function dispatchSubagentOpen(target: EventTarget | null, input: {
  childSessionId?: string
  subagentKey: string
  /** The agent's name, so the surface that opens the transcript can title it. */
  label?: string
  /** The row's one-line summary, for that surface's header. */
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

function chipFromView(view: SubagentView): ChipModel {
  return {
    key: view.subagentKey,
    childSessionId: view.childSessionId,
    name: view.agentLabel || view.label,
    ...(view.description ? { description: view.description } : {}),
    ...(view.mode ? { mode: view.mode } : {}),
    status: view.status,
    resolution: view.resolution,
    ...(view.toolCallRole ? { toolCallRole: view.toolCallRole } : {}),
    parentSessionId: view.parentSessionId,
  }
}

/**
 * One chip per row. The same subagent resolves from more than one tool call in a
 * turn — a parallel batch answers in a single message, and an interaction row
 * points back at the spawn it messaged — and each resolution would otherwise
 * draw the reader another agent that never existed. The spawn is the canonical
 * resolution, so it wins the row.
 */
export function subagentChips(views: SubagentView[]) {
  const chips = new Map<string, ChipModel>()
  for (const view of views) {
    const chip = chipFromView(view)
    if (chips.get(chip.key)?.toolCallRole === "spawn") continue
    chips.set(chip.key, chip)
  }
  return [...chips.values()]
}

/**
 * An interaction row is not its own transcript — it reports a message sent to a
 * subagent already spawned earlier in this turn. Activating it takes the reader
 * to that spawn row instead of opening anything.
 */
function scrollToCanonicalSpawn(chip: ChipModel) {
  const canonical = document.querySelector<HTMLElement>(
    `[data-session-timeline-session-id="${CSS.escape(chip.parentSessionId)}"] [data-subagent-key="${CSS.escape(chip.key)}"][data-subagent-role="spawn"]`,
  )
  if (!canonical) return false
  canonical.scrollIntoView({ block: "center", behavior: "smooth" })
  canonical.focus({ preventScroll: true })
  return true
}

const STATUS_KEYS: Record<SubagentView["status"], string> = {
  pending: "ui.subagent.status.working",
  running: "ui.subagent.status.working",
  paused: "ui.subagent.status.paused",
  interrupted: "ui.subagent.status.interrupted",
  completed: "ui.subagent.status.done",
  failed: "ui.subagent.status.failed",
  killed: "ui.subagent.status.killed",
  unknown: "ui.subagent.status.unknown",
}

function statusLabel(status: ChipModel["status"], i18n: UiI18n) {
  return i18n.t(STATUS_KEYS[status])
}

export function SubagentChipRow(props: {
  parts?: AgentToolPart[]
  subagents?: SubagentView[]
}) {
  const data = useData()
  const i18n = useI18n()
  const chips = createMemo(() => subagentChips(
    props.subagents
      ?? (props.parts ?? []).flatMap((part) => data.resolveSubagents?.(part.sessionID, part.callID) ?? []),
  ))
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
                <Show when={summary()}>
                  <span data-slot="subagent-chip-summary" title={chip.description || summary()}>{summary()}</span>
                </Show>
                <span data-slot="subagent-chip-status" aria-live="polite">{statusLabel(chip.status, i18n)}</span>
              </>
            )
            const interaction = () => chip.toolCallRole === "interaction"
            const openable = () => chip.resolution === "ready" && !!chip.childSessionId
            const activate = (target: EventTarget | null) => {
              if (interaction() && scrollToCanonicalSpawn(chip)) return
              if (dispatchSubagentOpen(target, {
                childSessionId: chip.childSessionId,
                subagentKey: chip.key,
                label: chip.name,
                ...(chip.description ? { description: chip.description } : {}),
                interaction: interaction(),
                openable: openable(),
              })) return
              // No surface claimed the open — a standalone reader, where following
              // the session's own route is the only way in.
              if (chip.childSessionId) data.navigateToSession?.(chip.childSessionId)
            }
            return (
              <Show
                when={openable() || interaction()}
                fallback={
                  <span
                    data-component="subagent-chip"
                    data-subagent-key={chip.key}
                    data-subagent-role={chip.toolCallRole ?? "ambient"}
                    data-status={chip.status}
                    aria-label={`${chip.name}, ${statusLabel(chip.status, i18n)}, transcript unavailable`}
                  >
                    {content()}
                  </span>
                }
              >
                <button
                  type="button"
                  data-component="subagent-chip"
                  data-subagent-key={chip.key}
                  data-subagent-role={chip.toolCallRole ?? "ambient"}
                  data-status={chip.status}
                  aria-label={`${chip.name}, ${statusLabel(chip.status, i18n)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    activate(event.currentTarget)
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
    </Show>
  )
}
