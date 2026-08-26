import { afterEach, describe, expect, test } from "bun:test"
import { createSignal, flush } from "solid-js"
import { createComposerPermissionMode } from "./permission-mode"
import { mountReactive } from "@/lib/test-support/reactive-root"
import {
  CLAXEDO_ALLOW_SAFE_ID,
  CLAXEDO_ASK_ALWAYS_ID,
  type HarnessModeReport,
  type PermissionModeOption,
  type PermissionSelection,
} from "@/features/session/permission/modes"
import type { HarnessId } from "@/platform/identity/session-ref"

/**
 * Every harness whose own modes the picker renders.
 *
 * `pi` is deliberately absent: its tools run in just-bash over an in-memory
 * filesystem, so it has no policy surface and the picker shows a reason instead
 * of rows. It is covered by its own test below rather than by these loops.
 */
const ALL: HarnessId[] = [
  "opencode",
  "claude-sdk",
  "claude-acp",
  "codex-acp",
  "codex-app-server",
  "cursor-acp",
  "cursor-sdk",
]

const REPORTED: HarnessModeReport = {
  modes: [
    { id: "default", name: "Default", level: "ask" },
    { id: "auto", name: "Auto-review", level: "auto" },
    { id: "full-access", name: "Full access", level: "full" },
  ],
  appliesFrom: "next-turn",
}

// Each `harness()` owns a reactive root; a test may build more than one.
const mounted: (() => void)[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

function harness(input: {
  harness?: HarnessId
  report?: HarnessModeReport
  stored?: PermissionSelection
  sessionId?: string
  failDelivery?: boolean
}) {
  const [selection, setSelection] = createSignal<PermissionSelection | undefined>(input.stored)
  const delivered: PermissionModeOption[] = []
  const errors: { error: unknown; option: PermissionModeOption }[] = []

  // Only the control needs an owner — its memos and effects. The picker's
  // `select()` runs from a menu click, i.e. with no owner on the stack, and
  // Solid 2's dev build throws `REACTIVE_WRITE_IN_OWNED_SCOPE` for a setter
  // reached under one, which every line of a root-wrapped test body would be.
  const [control, dispose] = mountReactive(() =>
    createComposerPermissionMode({
      harness: () => input.harness,
      report: () => input.report,
      selection,
      onSelectionChange: setSelection,
      sessionId: () => input.sessionId ?? "ses_1",
      deliver: async (call) => {
        if (input.failDelivery) throw new Error("503 unavailable")
        delivered.push(call.option)
        return { kind: "applied", appliesFrom: "next-turn" }
      },
      onDeliveryError: (err) => errors.push(err),
    }),
  )
  mounted.push(dispose)

  return { control, delivered, errors, selection }
}

const rowFor = (control: ReturnType<typeof createComposerPermissionMode>, id: string) =>
  [...(control.groups()?.claxedo ?? []), ...(control.groups()?.harness.rows ?? [])].find((row) => row.option.id === id)

describe("what the picker offers", () => {
  test("a reporting harness contributes its own rows, and Claxedo none", () => {
    const { control } = harness({ harness: "claude-acp", report: REPORTED })
    expect(control.groups()!.claxedo).toEqual([])
    expect(control.groups()!.harness.rows.map((row) => row.option.name)).toEqual([
      "Default",
      "Auto-review",
      "Full access",
    ])
  })

  // Every harness row is selectable now. This is the assertion that would have
  // caught the shipped state where Claude and Codex rendered rows nobody could
  // choose, because the app had no delivery for them.
  test("every reported row can actually be chosen", () => {
    for (const id of ALL) {
      const { control } = harness({ harness: id, report: REPORTED })
      const rows = control.groups()!.harness.rows
      expect(rows.length, id).toBe(3)
      for (const row of rows) {
        expect(row.selectable, `${id}/${row.option.id}`).toBe(true)
        expect(row.blockedReason, `${id}/${row.option.id}`).toBeUndefined()
      }
    }
  })

  test("a harness with nothing to report falls back to Claxedo's two, both selectable", () => {
    const { control } = harness({ harness: "opencode", report: { modes: [], appliesFrom: "next-turn" } })
    const claxedo = control.groups()!.claxedo
    expect(claxedo.map((row) => row.option.id)).toEqual([CLAXEDO_ALLOW_SAFE_ID, CLAXEDO_ASK_ALWAYS_ID])
    for (const row of claxedo) expect(row.selectable, row.option.id).toBe(true)
  })

  // An unidentified harness must not leave the user with no control, and must
  // never guess a harness — a ruleset written to the wrong engine is the failure
  // this guards. Local answering cannot produce a write at all.
  test("an unidentified harness gets Claxedo's options with a delivery that cannot write", () => {
    const { control } = harness({})
    const claxedo = control.groups()!.claxedo
    expect(claxedo.map((row) => row.option.id)).toEqual([CLAXEDO_ALLOW_SAFE_ID, CLAXEDO_ASK_ALWAYS_ID])
    for (const row of claxedo) {
      expect(row.selectable, row.option.id).toBe(true)
      expect(row.option.delivery.kind, row.option.id).toBe("claxedo-auto-answer")
    }
    expect(control.groups()!.harness.unavailable).toMatch(/identif/i)
  })

  // The state that shipped as a permanent "Waiting for … to report its modes".
  // Undefined now means genuinely in flight, and the copy says loading.
  test("before the fetch lands the harness group reads as loading", () => {
    const { control } = harness({ harness: "claude-acp" })
    expect(control.groups()!.harness.rows).toEqual([])
    expect(control.groups()!.harness.unavailable).toMatch(/loading/i)
  })
})

describe("selecting", () => {
  test("choosing a harness mode stores it by id and delivers it", () => {
    const { control, delivered, selection } = harness({ harness: "claude-acp", report: REPORTED })
    control.select(rowFor(control, "full-access")!.option)
    // `select` writes the selection through `onSelectionChange`; Solid 2
    // stages that until the scheduler flushes, and the picker re-renders from
    // it after the flush.
    flush()
    expect(selection()).toEqual({ kind: "harness", modeId: "full-access" })
    flush()
    expect(delivered.map((option) => option.id)).toEqual(["full-access"])
  })

  test("choosing a Claxedo option stores it under the claxedo kind, not harness", () => {
    const { control, selection } = harness({ harness: "opencode", report: { modes: [], appliesFrom: "next-turn" } })
    control.select(rowFor(control, CLAXEDO_ASK_ALWAYS_ID)!.option)
    // Storing this as `harness` would later resolve against the harness's list
    // and silently return nothing.
    flush()
    expect(selection()).toEqual({ kind: "claxedo", modeId: CLAXEDO_ASK_ALWAYS_ID })
  })

  // The selection is worth storing on a draft — the first real session picks it
  // up — but there is no session to scope it to, so nothing is sent.
  test("a draft stores the choice and sends nothing", () => {
    const { control, delivered, selection } = harness({
      harness: "claude-acp",
      report: REPORTED,
      sessionId: "",
    })
    control.select(rowFor(control, "auto")!.option)
    flush()
    expect(selection()).toEqual({ kind: "harness", modeId: "auto" })
    flush()
    expect(delivered).toHaveLength(0)
  })

  test("a failed delivery is reported, not swallowed", async () => {
    const { control, errors } = harness({ harness: "claude-acp", report: REPORTED, failDelivery: true })
    control.select(rowFor(control, "auto")!.option)
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.option.id).toBe("auto")
  })
})

describe("what shows as current", () => {
  // The harness's own current mode is the truth about the session. A resumed
  // session is already running under something, and Claxedo has no record of it.
  test("with nothing stored, the harness's reported current mode is shown", () => {
    const { control } = harness({
      harness: "claude-acp",
      report: { ...REPORTED, currentModeId: "default" },
    })
    expect(control.current()?.id).toBe("default")
    expect(control.current()?.name).toBe("Default")
  })

  test("with nothing stored and no reported current, the auto rung is shown", () => {
    // The harness's own name for it, because that is the row the picker
    // renders. Naming it "Auto" would name a row that no longer exists.
    const { control } = harness({ harness: "claude-acp", report: REPORTED })
    expect(control.current()?.id).toBe("auto")
    expect(control.current()?.name).toBe("Auto-review")
  })

  // A stored id the harness no longer advertises must read as unresolved rather
  // than wearing another mode's label while a different id is stored.
  test("a stale stored mode resolves to undefined rather than falling back", () => {
    const { control } = harness({
      harness: "claude-acp",
      report: REPORTED,
      stored: { kind: "harness", modeId: "a-mode-that-vanished" },
    })
    expect(control.current()).toBeUndefined()
  })
})
