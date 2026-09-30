import { spawnSync } from "node:child_process"
import path from "node:path"
import { CLAUDE_CODE_RANGE } from "../../src/transports/claude-sdk/cli-version"
import { CODEX_RANGE } from "../../src/transports/codex-app-server/version"
import { PI_RANGE } from "../../src/transports/pi-rpc/version"
import type { TestedRange } from "../harness/pinned-package"

type RangedProgram = { variable: string; range: TestedRange; flows: string[]; conformance: string[] }

const PROGRAMS: Record<string, RangedProgram> = {
  claude: {
    variable: "CLAXEDO_E2E_CLAUDE",
    range: CLAUDE_CODE_RANGE,
    flows: ["H1-turn-parts", "H2-stop", "H3-native-permissions", "H3b-sdk-save-before-release", "H4-native-questions", "H5-native-subagents",
      "H6-goals", "H7-steer", "H7.unknown-held", "H13.claude-usage"],
    conformance: ["src/conformance/claude.test.ts", "src/conformance/claude-background.test.ts"],
  },
  codex: {
    variable: "CLAXEDO_E2E_CODEX",
    range: CODEX_RANGE,
    flows: ["H1-turn-parts", "H2-stop", "H2.codex-inventory-unverifiable", "H3-native-permissions", "H4-native-questions", "H5-native-subagents",
      "H5.codex-native-subagents", "H6-goals", "H7-steer", "H7.unknown-held", "H13.codex-usage", "H14.codex-configured-mcp", "H15.codex-brokered-plugin"],
    conformance: ["src/conformance/codex.test.ts", "src/conformance/codex-lifecycle.test.ts", "src/conformance/codex-native-subagents.test.ts",
      "src/profiles/codex/index.test.ts"],
  },
  pi: {
    variable: "CLAXEDO_E2E_PI",
    range: PI_RANGE,
    flows: ["H0-smoke", "H1-turn-parts", "H2-stop", "H4-pi-dialogs", "H4.pi-timeout", "H7-steer", "H7.unknown-held", "H13.pi-usage",
      "H18-pi-owner", "H20-pi-session-owner"],
    conformance: ["src/conformance/pi.test.ts", "src/conformance/pi-mcp.test.ts", "src/profiles/pi/index.test.ts"],
  },
}

const root = path.resolve(import.meta.dirname, "../..")

function run(label: string, args: string[], env: NodeJS.ProcessEnv): string {
  const started = Date.now()
  console.log(`\n=== ${label}`)
  const status = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" }).status
  return `${label}: ${status === 0 ? "pass" : `fail (exit ${status})`} in ${Math.round((Date.now() - started) / 1000)} s`
}

const names = process.argv.slice(2)
const unknown = names.filter((name) => !(name in PROGRAMS))
if (unknown.length) throw new Error(`No ranged program ${unknown.join(", ")}; known: ${Object.keys(PROGRAMS).join(", ")}`)
const outcomes: string[] = []
for (const name of names.length ? names : Object.keys(PROGRAMS)) {
  const program = PROGRAMS[name]!
  for (const end of ["min", "max"] as const) {
    const env = { ...process.env, [program.variable]: end }
    const version = `${name} ${end} ${program.range[end]}`
    outcomes.push(run(`${version} conformance`, ["test", ...program.conformance], env))
    outcomes.push(run(`${version} flows`, ["e2e/flows/run.ts", ...program.flows], env))
  }
}
console.log(`\n${outcomes.join("\n")}`)
if (outcomes.some((outcome) => !outcome.includes(": pass"))) process.exitCode = 1
