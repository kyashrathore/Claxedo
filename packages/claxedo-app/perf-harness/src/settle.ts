import { isBoolean, isFiniteNumber, isRecord, isString } from "@claxedo/helpers/guards"
import { readArray, readFiniteNumber } from "@claxedo/helpers/readers"
import type { ReadinessTarget } from "./corpus"
import { sdk, type AppFacts, type ClockFrame, type FrameLog, type PageSettle, type ReadyGates } from "./driver-sdk"

export type FactsTarget = Pick<ReadinessTarget, "sessionId" | "latestTurnMessageIds">

export const claxedoFacts = (target: FactsTarget): AppFacts => {
  const latestReplies = new Set(target.latestTurnMessageIds)
  const screen = () => {
    const section = document.querySelector<HTMLElement>(`section[data-component="session-screen"][data-session-id="${CSS.escape(target.sessionId)}"]`)
    const slot = section?.closest<HTMLElement>("[data-workbench-content]")
    if (!section || !slot || slot.dataset.stashed === "true" || slot.getAttribute("aria-hidden") === "true") return null
    return section
  }
  const transcript = () => screen()?.querySelector<HTMLElement>('[data-slot="session-timeline-scroll"] > [data-scrollable]') ?? null
  const rows = () => [...(transcript()?.querySelectorAll<HTMLElement>("[data-timeline-row]") ?? [])]
  return {
    displayed: () => {
      const active = [...document.querySelectorAll<HTMLElement>('[data-slot="session-navigation-row"][data-active="true"]')]
      return !!screen() && active.length === 1 && active[0].dataset.sessionId === target.sessionId
    },
    latestTurnRows: () => rows().filter((row) => row.dataset.timelineRow === "AssistantPart" && latestReplies.has(row.dataset.contentMessageId ?? "")),
    composer: () => {
      const composer = screen()?.querySelector<HTMLElement>('[data-component="prompt-input"]')
      return composer?.getAttribute("contenteditable") === "true" ? composer : null
    },
    placeholder: () => !!screen()?.querySelector('[data-session-timeline-loading], [data-testid="session-messages-loading"]'),
    transcript,
    rows,
    rowKey: (row) => [row.dataset.timelineRow, row.dataset.messageId, row.dataset.contentMessageId, row.dataset.contentPartId].join("/"),
  }
}

export function settleExpressionFor(target: ReadinessTarget, timeoutMs: number, start: "trusted-pointerdown" | "now") {
  return sdk.settleExpression<FactsTarget>({
    facts: claxedoFacts,
    target: { sessionId: target.sessionId, latestTurnMessageIds: target.latestTurnMessageIds },
    timeoutMs,
    start,
  })
}

const READY_GATES = [
  "displayedDestination",
  "latestTurnPainted",
  "noPlaceholder",
  "firstFoldComplete",
  "composerEditable",
  "windowVisibleFocused",
] as const satisfies ReadonlyArray<keyof ReadyGates>

function isReadyGates(value: unknown): value is ReadyGates {
  return isRecord(value) && READY_GATES.every((gate) => isBoolean(value[gate]))
}

function isClockFrame(value: unknown): value is ClockFrame {
  return isRecord(value)
    && isFiniteNumber(value.at)
    && isReadyGates(value.gates)
    && (value.signature === null || isString(value.signature))
    && isBoolean(value.mutated)
}

export function readPageSettle(value: unknown): PageSettle {
  const startAt = readFiniteNumber(value, "startAt")
  const settledAt = readFiniteNumber(value, "settledAt")
  const timeOrigin = readFiniteNumber(value, "timeOrigin")
  const frames = readArray(value, "frames")
  if (startAt === undefined || settledAt === undefined || timeOrigin === undefined || !frames?.every(isClockFrame)) {
    throw new Error("Claxedo's renderer reported a malformed settle")
  }
  return { startAt, settledAt, timeOrigin, frames }
}

export type ActivationClock = { kind: "single-monotonic-clock"; clock: "performance.now"; start: number; end: number }

export type Activation = { clock: ActivationClock; frameLog: FrameLog }

export function sessionActivation(settle: PageSettle): Activation {
  return {
    clock: { kind: "single-monotonic-clock", clock: "performance.now", start: settle.startAt, end: settle.settledAt },
    frameLog: sdk.frameLogOf(settle),
  }
}

export function appStartReadiness(settle: PageSettle, spawnAtMs: number, driverTimeOrigin: number) {
  const offsetMs = settle.timeOrigin - driverTimeOrigin
  return {
    readyAtMs: settle.settledAt + offsetMs,
    readyFrameLog: sdk.frameLogOf(settle, { startAt: spawnAtMs - offsetMs, offsetMs }),
  }
}
