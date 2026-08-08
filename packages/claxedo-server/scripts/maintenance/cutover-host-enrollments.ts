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
 *
 * **The phase machine is implemented; its backend is not.** `convex/` has none
 * of the deployment-wide operations a cutover needs — see
 * `CUTOVER_BACKEND_GAPS`. So `resolveCutoverPorts` refuses and the command
 * exits non-zero naming what is missing, rather than running six phases against
 * stubs and reporting `done`. Anything less than a loud failure here is worse
 * than no command at all: the operator would believe an irreversible runbook
 * step had happened.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"

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

export const USAGE = [
  "usage: cutover-host-enrollments.ts <phase> --environment <name> --sha <sha> [--actor <name>] [--confirm-destroy]",
  "",
  `  <phase>             one of: ${PHASES.join(" | ")}`,
  "  --environment       the deployment being cut over (part of the cutover id)",
  "  --sha               the reviewed build; a cutover cannot be resumed against another",
  "  --actor             who is running it; defaults to $USER",
  "  --confirm-destroy   retire-legacy only. Without it the phase deletes nothing.",
  "",
  "  Runbook: docs/tech-docs/host-enrollment-hard-cut-runbook.md",
].join("\n")

/**
 * A port that cannot be built, and the backend that would build it.
 *
 * Written down rather than discovered so the refusal below names something an
 * operator can act on. Each entry disappears when the function it names lands.
 */
export type CutoverBackendGap = {
  ports: Array<keyof CutoverPorts>
  needs: string
}

/**
 * Everything this command would need from a live deployment, and does not have.
 *
 * `convex/` today exposes host-enrollment and host-link functions scoped to one
 * user or one relay — `hostEnrollments.activeForService`,
 * `localHostLinks.activeForRelay` and the per-user mutations around them. None
 * of the deployment-wide operations a cutover performs exists: there is no
 * cutover record table, no count of the legacy rows, no switch that blocks
 * legacy writes, no delete, and no post-cut verification.
 *
 * So the phase machine above is complete and the wiring under it is not. That
 * is a fine state for the machine to be in and a dangerous one for the command,
 * which is why `resolveCutoverPorts` refuses instead of returning stubs: a
 * cutover command that exits 0 having done nothing tells the operator the
 * runbook step ran.
 */
export const CUTOVER_BACKEND_GAPS: CutoverBackendGap[] = [
  {
    ports: ["readRecord", "writeRecord"],
    needs:
      "a cutover-record table in convex/schema.ts plus service query/mutation to read it and append a completed phase"
      + " — without it phase order is unenforceable across invocations",
  },
  {
    ports: ["countLegacy"],
    needs:
      "a service query counting local_host_links across the deployment"
      + " (convex/localHostLinks.ts reads are scoped to one user or one relay)",
  },
  {
    ports: ["newSchemaReady"],
    needs:
      "a readiness query over the new host_enrollments tables"
      + " (convex/hostEnrollments.ts#activeForService is the closest existing read)",
  },
  {
    ports: ["setMaintenance"],
    needs:
      "a service mutation that blocks and restores legacy host-link creation, renewal and connection mint"
      + " — no such switch exists, so enter-maintenance cannot drain host publication",
  },
  {
    ports: ["deleteLegacy"],
    needs: "a service mutation that deletes the legacy local_host_links rows — the irreversible step has no implementation",
  },
  {
    ports: ["verifyNewAuthority"],
    needs:
      "a probe proving a zero-workspace enrollment plus Bun and Cloudflare add/remove/reconnect"
      + " against the new authority",
  },
]

export class CutoverBackendUnavailableError extends Error {
  readonly code = "cutover_backend_unavailable"
  constructor(readonly gaps: CutoverBackendGap[]) {
    super(`the host-enrollment cutover has no backend for ${gaps.length} of its ports`)
  }

  /** What an operator reads on stderr. States plainly that nothing happened. */
  report(input: CutoverInput) {
    return [
      `REFUSED: ${input.phase} did not run for ${cutoverId(input)}.`,
      "",
      "The host-enrollment cutover is not implementable against this deployment yet."
      + " Nothing was read, blocked, deleted or recorded.",
      "",
      "Missing backend:",
      ...this.gaps.map((gap) => `  - ${gap.ports.join(", ")}: ${gap.needs}`),
      "",
      "Land those Convex functions, then build them into `resolveCutoverPorts`."
      + " The phase machine (order, the retire-legacy dry-run default, idempotent verify-retirement)"
      + " is already implemented and covered by scripts/maintenance/tests/cutover-host-enrollments.test.ts.",
      "Runbook: docs/tech-docs/host-enrollment-hard-cut-runbook.md",
    ].join("\n")
  }
}

/**
 * Build the ports that act on a live deployment.
 *
 * There are none, and saying so is this function's whole job today. Returning
 * stubs — or letting the command fall off the end without a `main` at all,
 * which is what it did — makes `bun run maintenance:cutover-host-enrollments`
 * exit 0 in the middle of an irreversible runbook.
 */
export function resolveCutoverPorts(): CutoverPorts {
  throw new CutoverBackendUnavailableError(CUTOVER_BACKEND_GAPS)
}

async function main() {
  const parsed = parseCutoverArgv(process.argv.slice(2))
  if ("error" in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`)
    process.exit(2)
  }

  let ports: CutoverPorts
  try {
    ports = resolveCutoverPorts()
  } catch (error) {
    if (!(error instanceof CutoverBackendUnavailableError)) throw error
    console.error(error.report(parsed))
    process.exit(1)
  }

  const outcome = await runCutoverPhase(parsed, ports)
  console.log(JSON.stringify({ cutoverId: cutoverId(parsed), actor: parsed.actor, ...outcome }, null, 2))
  // A refused phase is an operator-visible failure, not a result to scroll
  // past: the runbook step did not happen.
  process.exit(outcome.status === "refused" ? 1 : 0)
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await main()
}
