/**
 * The host-enrollment hard cut, as a phased runbook.
 *
 * `docs/tech-docs/host-enrollment-hard-cut-runbook.md` is the prose; this is
 * the part that runs. The phases exist because the middle one deletes rows on a
 * live deployment and there is no way back from it, so the surrounding steps
 * have to be ordered, recorded, and refused when taken out of order.
 *
 * Two decisions are worth stating plainly:
 *
 *   - **`retire-legacy` is a dry run unless `--confirm-destroy` is passed.**
 *     A destructive default makes "I ran the runbook to see what it does" a
 *     production incident. The flag is also the only place a human decision
 *     about an irreversible action is recorded.
 *   - **Phase order is enforced against a cutover id bound to deployment and
 *     SHA.** A half-finished cutover resumed against a different build is how
 *     both authorities end up live at once, which is the state the whole hard
 *     cut exists to avoid.
 *
 * Convex access is injected so the phase logic is testable without a
 * deployment; `scripts/maintenance/tests/` drives it.
 */

export const PHASES = [
  "preflight",
  "enter-maintenance",
  "retire-legacy",
  "verify-retirement",
  "verify-new",
  "exit-maintenance",
] as const

export type Phase = (typeof PHASES)[number]

export type CutoverRecord = {
  cutoverId: string
  environment: string
  sha: string
  /** Phases completed, in order. A dry run does NOT append. */
  completed: Phase[]
}

export type CutoverInput = {
  phase: Phase
  environment: string
  sha: string
  confirmDestroy: boolean
  actor: string
}

export type CutoverPorts = {
  /** Reads the record for this (environment, sha), or undefined on first run. */
  readRecord: (input: { environment: string; sha: string }) => Promise<CutoverRecord | undefined>
  writeRecord: (record: CutoverRecord) => Promise<void>
  /** Counts legacy per-workspace rows still present. */
  countLegacy: () => Promise<number>
  /** True once the new tables are deployed and readable. */
  newSchemaReady: () => Promise<boolean>
  /** Blocks or restores legacy host-link creation, renewal and connection mint. */
  setMaintenance: (enabled: boolean) => Promise<void>
  /** The irreversible delete. Only ever called with an explicit confirmation. */
  deleteLegacy: () => Promise<{ deleted: number }>
  /** Proves a zero-workspace enrollment plus Bun and Cloudflare reconnect. */
  verifyNewAuthority: () => Promise<{ ok: boolean; detail: string }>
  now: () => number
}

export type PhaseOutcome = {
  phase: Phase
  status: "done" | "dry-run" | "refused"
  detail: string
  counts?: Record<string, number>
}

/** `cutoverId` is derived, not random, so the same run always finds its record. */
export function cutoverId(input: { environment: string; sha: string }) {
  return `${input.environment}@${input.sha}`
}

function refuse(phase: Phase, detail: string): PhaseOutcome {
  return { phase, status: "refused", detail }
}

/**
 * The phase before this one, or undefined for the first.
 *
 * Order is checked against COMPLETED phases rather than a stored cursor: a
 * cursor can be nudged forward by hand, while "did `enter-maintenance` actually
 * finish" is a fact about what ran.
 */
function predecessor(phase: Phase): Phase | undefined {
  const index = PHASES.indexOf(phase)
  return index > 0 ? PHASES[index - 1] : undefined
}

export async function runCutoverPhase(input: CutoverInput, ports: CutoverPorts): Promise<PhaseOutcome> {
  const id = cutoverId(input)
  const record = (await ports.readRecord(input)) ?? {
    cutoverId: id,
    environment: input.environment,
    sha: input.sha,
    completed: [],
  }

  if (record.completed.includes(input.phase) && input.phase !== "verify-retirement") {
    // `verify-retirement` is deliberately idempotent — the runbook tells the
    // operator to rerun it while repairing forward after retirement.
    return refuse(input.phase, `${input.phase} already completed for ${id}`)
  }

  const previous = predecessor(input.phase)
  if (previous && !record.completed.includes(previous)) {
    return refuse(input.phase, `${previous} must complete before ${input.phase} for ${id}`)
  }

  const complete = async (outcome: Omit<PhaseOutcome, "phase">): Promise<PhaseOutcome> => {
    await ports.writeRecord({ ...record, completed: [...record.completed, input.phase] })
    return { phase: input.phase, ...outcome }
  }

  switch (input.phase) {
    case "preflight": {
      const [legacy, ready] = await Promise.all([ports.countLegacy(), ports.newSchemaReady()])
      if (!ready) return refuse("preflight", "the new host_enrollments schema is not deployed yet")
      return complete({ status: "done", detail: `ready to cut ${legacy} legacy rows`, counts: { legacy } })
    }

    case "enter-maintenance": {
      await ports.setMaintenance(true)
      return complete({ status: "done", detail: "legacy host-link writes blocked; host publication drained" })
    }

    case "retire-legacy": {
      const legacy = await ports.countLegacy()
      if (!input.confirmDestroy) {
        // Deliberately does NOT append to `completed`: a dry run must not let
        // `verify-retirement` proceed as though the delete happened.
        return {
          phase: "retire-legacy",
          status: "dry-run",
          detail: `would delete ${legacy} legacy rows — rerun with --confirm-destroy to perform it`,
          counts: { wouldDelete: legacy },
        }
      }
      const { deleted } = await ports.deleteLegacy()
      return complete({ status: "done", detail: `deleted ${deleted} legacy rows`, counts: { deleted } })
    }

    case "verify-retirement": {
      const legacy = await ports.countLegacy()
      if (legacy > 0) return refuse("verify-retirement", `${legacy} legacy rows remain; something is recreating them`)
      // Idempotent: recorded once, and rerunning a recorded pass is allowed
      // above rather than refused.
      if (record.completed.includes("verify-retirement")) {
        return { phase: "verify-retirement", status: "done", detail: "still clean", counts: { legacy } }
      }
      return complete({ status: "done", detail: "no legacy rows remain", counts: { legacy } })
    }

    case "verify-new": {
      const result = await ports.verifyNewAuthority()
      if (!result.ok) return refuse("verify-new", result.detail)
      return complete({ status: "done", detail: result.detail })
    }

    case "exit-maintenance": {
      await ports.setMaintenance(false)
      return complete({ status: "done", detail: "normal operation restored on the new authority" })
    }
  }
}

/** Parses `--flag value` and `--flag` argv, plus the leading phase. */
export function parseCutoverArgv(argv: string[]): CutoverInput | { error: string } {
  const [phase, ...rest] = argv
  if (!phase || !(PHASES as readonly string[]).includes(phase)) {
    return { error: `phase must be one of: ${PHASES.join(" | ")}` }
  }
  const flags = new Map<string, string>()
  let confirmDestroy = false
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!
    if (!token.startsWith("--")) continue
    const name = token.slice(2)
    if (name === "confirm-destroy") {
      confirmDestroy = true
      continue
    }
    const value = rest[index + 1]
    if (!value || value.startsWith("--")) return { error: `--${name} requires a value` }
    flags.set(name, value)
    index++
  }
  const environment = flags.get("environment")
  const sha = flags.get("sha")
  if (!environment) return { error: "--environment is required" }
  if (!sha) return { error: "--sha is required" }
  return {
    phase: phase as Phase,
    environment,
    sha,
    confirmDestroy,
    actor: flags.get("actor") ?? process.env.USER ?? "unknown",
  }
}
