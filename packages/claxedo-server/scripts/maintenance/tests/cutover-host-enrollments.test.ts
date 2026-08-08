import { describe, expect, test } from "vitest"
import {
  PHASES,
  parseCutoverArgv,
  runCutoverPhase,
  type CutoverPorts,
  type CutoverRecord,
  type Phase,
} from "../cutover-host-enrollments"

/**
 * The phase machine, without a deployment.
 *
 * What is worth pinning is not that the happy path runs — it is that the two
 * controls around the irreversible step hold: `retire-legacy` deletes nothing
 * without an explicit flag, and no phase runs out of order. Both are the kind
 * of thing that reads as obviously correct and stops being true the first time
 * someone adds a phase.
 */

function ports(overrides: Partial<CutoverPorts> = {}) {
  const records = new Map<string, CutoverRecord>()
  const calls = { deleteLegacy: 0, setMaintenance: [] as boolean[] }
  let legacy = 3
  const base: CutoverPorts = {
    readRecord: async ({ environment, sha }) => records.get(`${environment}@${sha}`),
    writeRecord: async (record) => {
      records.set(record.cutoverId, record)
    },
    countLegacy: async () => legacy,
    newSchemaReady: async () => true,
    setMaintenance: async (enabled) => {
      calls.setMaintenance.push(enabled)
    },
    deleteLegacy: async () => {
      calls.deleteLegacy++
      const deleted = legacy
      legacy = 0
      return { deleted }
    },
    verifyNewAuthority: async () => ({ ok: true, detail: "zero-workspace enrollment and reconnect passed" }),
    now: () => 1_000,
    ...overrides,
  }
  return { ports: base, calls, records, setLegacy: (value: number) => (legacy = value) }
}

const CONTEXT = { environment: "production", sha: "abc123", actor: "operator" }

function run(harness: ReturnType<typeof ports>, phase: Phase, confirmDestroy = false) {
  return runCutoverPhase({ ...CONTEXT, phase, confirmDestroy }, harness.ports)
}

/** Advances through every phase before `stop`, so a test can start there. */
async function advanceTo(harness: ReturnType<typeof ports>, stop: Phase) {
  for (const phase of PHASES) {
    if (phase === stop) return
    await run(harness, phase, phase === "retire-legacy")
  }
}

describe("retire-legacy", () => {
  test("deletes nothing without --confirm-destroy", async () => {
    // The control this script exists for. Running the runbook to see what it
    // does must not be a production incident.
    const harness = ports()
    await advanceTo(harness, "retire-legacy")

    const outcome = await run(harness, "retire-legacy")

    expect(outcome.status).toBe("dry-run")
    expect(outcome.counts).toEqual({ wouldDelete: 3 })
    expect(harness.calls.deleteLegacy).toBe(0)
  })

  test("a dry run does not let verify-retirement proceed", async () => {
    // Otherwise a dry run reads as a completed retirement, and the next phase
    // certifies a deletion that never happened.
    const harness = ports()
    await advanceTo(harness, "retire-legacy")
    await run(harness, "retire-legacy")

    const outcome = await run(harness, "verify-retirement")

    expect(outcome.status).toBe("refused")
    expect(outcome.detail).toContain("retire-legacy must complete")
  })

  test("deletes when the flag is passed", async () => {
    const harness = ports()
    await advanceTo(harness, "retire-legacy")

    const outcome = await run(harness, "retire-legacy", true)

    expect(outcome).toMatchObject({ status: "done", counts: { deleted: 3 } })
    expect(harness.calls.deleteLegacy).toBe(1)
  })

  test("will not run twice", async () => {
    const harness = ports()
    await advanceTo(harness, "retire-legacy")
    await run(harness, "retire-legacy", true)

    const outcome = await run(harness, "retire-legacy", true)

    expect(outcome.status).toBe("refused")
    expect(harness.calls.deleteLegacy).toBe(1)
  })
})

describe("phase order", () => {
  test("refuses a phase whose predecessor has not completed", async () => {
    const harness = ports()

    expect((await run(harness, "enter-maintenance")).status).toBe("refused")
    expect((await run(harness, "verify-new")).status).toBe("refused")
  })

  test("never enters maintenance as a side effect of a refused phase", async () => {
    // A refusal must change nothing. Blocking legacy writes and then refusing
    // would leave remote access down with no record of why.
    const harness = ports()

    await run(harness, "exit-maintenance")

    expect(harness.calls.setMaintenance).toEqual([])
  })

  test("runs the whole sequence in order", async () => {
    const harness = ports()
    const outcomes = []
    for (const phase of PHASES) outcomes.push(await run(harness, phase, phase === "retire-legacy"))

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["done", "done", "done", "done", "done", "done"])
    expect(harness.calls.setMaintenance).toEqual([true, false])
  })

  test("is bound to the SHA, so a different build cannot resume a cutover", async () => {
    // The mixed-artifact case: a half-finished cutover continued against
    // another build is how both authorities end up live at once.
    const harness = ports()
    await run(harness, "preflight")

    const other = await runCutoverPhase(
      { ...CONTEXT, sha: "def456", phase: "enter-maintenance", confirmDestroy: false },
      harness.ports,
    )

    expect(other.status).toBe("refused")
  })
})

describe("preflight", () => {
  test("refuses when the new schema is not deployed", async () => {
    // Retiring the old authority before the new one exists leaves no authority.
    const harness = ports({ newSchemaReady: async () => false })

    expect((await run(harness, "preflight")).status).toBe("refused")
  })
})

describe("verify-retirement", () => {
  test("refuses while legacy rows remain", async () => {
    const harness = ports()
    await advanceTo(harness, "retire-legacy")
    await run(harness, "retire-legacy", true)
    harness.setLegacy(2)

    const outcome = await run(harness, "verify-retirement")

    expect(outcome.status).toBe("refused")
    expect(outcome.detail).toContain("recreating")
  })

  test("is idempotent, because repair-forward reruns it", async () => {
    const harness = ports()
    await advanceTo(harness, "verify-retirement")

    expect((await run(harness, "verify-retirement")).status).toBe("done")
    expect((await run(harness, "verify-retirement")).status).toBe("done")
  })
})

describe("verify-new", () => {
  test("refuses and reports why when the new authority does not pass", async () => {
    const harness = ports({
      verifyNewAuthority: async () => ({ ok: false, detail: "cloudflare reconnect failed" }),
    })
    await advanceTo(harness, "verify-new")

    const outcome = await run(harness, "verify-new")

    expect(outcome.status).toBe("refused")
    expect(outcome.detail).toContain("cloudflare reconnect failed")
  })

  test("blocks exit-maintenance when it did not pass", async () => {
    // Leaving maintenance on a broken authority is the one outcome the runbook
    // rules out explicitly: keep Remote Access down and repair forward.
    const harness = ports({ verifyNewAuthority: async () => ({ ok: false, detail: "no" }) })
    await advanceTo(harness, "verify-new")
    await run(harness, "verify-new")

    expect((await run(harness, "exit-maintenance")).status).toBe("refused")
    expect(harness.calls.setMaintenance).toEqual([true])
  })
})

describe("parseCutoverArgv", () => {
  test("requires a known phase and the deployment context", () => {
    expect(parseCutoverArgv([])).toMatchObject({ error: expect.stringContaining("phase must be one of") })
    expect(parseCutoverArgv(["retire-legacy"])).toMatchObject({ error: "--environment is required" })
    expect(parseCutoverArgv(["retire-legacy", "--environment", "production"])).toMatchObject({
      error: "--sha is required",
    })
  })

  test("treats --confirm-destroy as a bare flag", () => {
    // If it took a value it would swallow the next flag, and an operator who
    // typed it would silently get a dry run.
    const parsed = parseCutoverArgv([
      "retire-legacy",
      "--environment",
      "production",
      "--confirm-destroy",
      "--sha",
      "abc123",
    ])

    expect(parsed).toMatchObject({ phase: "retire-legacy", environment: "production", sha: "abc123", confirmDestroy: true })
  })

  test("defaults to a dry run", () => {
    const parsed = parseCutoverArgv(["retire-legacy", "--environment", "production", "--sha", "abc123"])

    expect(parsed).toMatchObject({ confirmDestroy: false })
  })

  test("rejects a flag with no value rather than guessing", () => {
    expect(parseCutoverArgv(["preflight", "--environment", "--sha", "abc"])).toMatchObject({
      error: "--environment requires a value",
    })
  })
})

describe("runbook", () => {
  test("documents the destructive flag it requires", async () => {
    // The flag is only a control if an operator can find it. A runbook that
    // does not name it produces a support question at the worst moment.
    const { readFileSync } = await import("node:fs")
    const path = new URL("../../../../../docs/tech-docs/host-enrollment-hard-cut-runbook.md", import.meta.url)
    const runbook = readFileSync(path, "utf8")

    expect(runbook).toContain("--confirm-destroy")
    expect(runbook).toContain("deletes nothing")
    for (const phase of PHASES) expect(runbook, `runbook must document ${phase}`).toContain(phase)
  })
})
