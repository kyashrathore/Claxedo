import { describe, expect, test } from "bun:test"
import { transcriptPeekStep, type TranscriptPeekInput, type TranscriptPeekState } from "./transcript-peek"

const base: TranscriptPeekInput = { floating: true, toggles: 0, sends: 0, sessionId: "s1", loaded: true, turns: 3 }

function run(...steps: Array<Partial<TranscriptPeekInput>>) {
  let state: TranscriptPeekState | undefined
  let input = base
  for (const step of steps) {
    input = { ...input, ...step }
    state = transcriptPeekStep(state, input)
  }
  return state!
}

describe("transcriptPeekStep", () => {
  test("starts collapsed and toggles on each peek", () => {
    expect(run({}).peeked).toBe(false)
    expect(run({}, { toggles: 1 }).peeked).toBe(true)
    expect(run({}, { toggles: 1 }, { toggles: 2 }).peeked).toBe(false)
  })

  test("a prompt sent from the card opens the transcript, even when the send creates the session", () => {
    expect(run({}, { sends: 1 }).peeked).toBe(true)
    expect(run({ sessionId: undefined, loaded: false, turns: 0 }, { sends: 1 }, { sessionId: "s9", loaded: true, turns: 1 }).peeked).toBe(true)
  })

  test("a turn that arrives on the same loaded session opens the transcript", () => {
    expect(run({}, { turns: 4 }).peeked).toBe(true)
  })

  test("history landing in a session opened while floating is not a turn", () => {
    expect(run({ loaded: false, turns: 0 }, { loaded: true, turns: 12 }).peeked).toBe(false)
    expect(run({ loaded: false, turns: 0 }, { loaded: true, turns: 12 }, { turns: 13 }).peeked).toBe(true)
  })

  test("switching the floating pane to a longer session does not open the transcript", () => {
    expect(run({}, { sessionId: "s2", turns: 40 }).peeked).toBe(false)
  })

  test("entering floating collapses a transcript peeked earlier; growth while docked does not peek", () => {
    expect(run({ floating: false }, { turns: 4 }).peeked).toBe(false)
    expect(run({}, { toggles: 1 }, { floating: false }, { floating: true }).peeked).toBe(false)
  })
})
