/**
 * Live enforcement probe: does a chosen permission mode actually GATE a tool call?
 *
 * `permission-probe.ts` proves a mode reaches the harness and is echoed back.
 * That is not enforcement — an agent could acknowledge a mode and ignore it. This
 * script drives a real turn under two modes and compares what happens to the same
 * tool call: under the `ask` rung it must stop and ask; under the `full` rung it
 * must run without asking.
 *
 * The ONLY faked thing is the model's reply. That is deliberate and necessary: a
 * real model may or may not decide to call a tool, and a comparison between two
 * runs is meaningless unless both runs request the identical call. Everything
 * else is real — the agent binary, the ACP handshake, `session/new`,
 * `session/set_mode`, the agent's own permission machinery, and the filesystem
 * the tool would write to.
 *
 * Run: bun run script/enforcement-probe.ts        (needs script/mock-model.ts running)
 */
import { createRequire } from "node:module"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { AcpHarnessAdapter } from "../src/harnesses/acp/index"
import { RuntimeStore } from "../../workspace-runtime/src/store"
import type { AgentPermissionMode } from "../src/adapter-contract"

const require_ = createRequire(import.meta.url)

function acpBinary(name: string, pkg: string) {
  const pkgJson = require_.resolve(`${pkg}/package.json`)
  const meta = require_(pkgJson) as { bin?: string | Record<string, string> }
  const rel = typeof meta.bin === "string" ? meta.bin : meta.bin?.[name]
  if (!rel) throw new Error(`no bin entry for ${name}`)
  return path.join(path.dirname(pkgJson), rel)
}

const MOCK = process.env.MOCK_MODEL_URL ?? "http://127.0.0.1:8899"
/** Where the mocked model always asks to write. Must match mock-model.ts. */
const TARGET = process.env.MOCK_FILE ?? "/tmp/enforcement-probe-target.txt"
/** A turn that is correctly gated never completes, so it is stopped on the ask. */
const TURN_TIMEOUT_MS = Number(process.env.ENFORCEMENT_TIMEOUT_MS ?? 40_000)

type Outcome = {
  mode: string
  level: string
  asked: boolean
  wrote: boolean
  detail?: string
}

async function runCase(input: {
  harness: "claude" | "codex" | "cursor"
  binary: string
  mode: AgentPermissionMode
}): Promise<Outcome> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `enforce-${input.harness}-`))
  const workdir = path.join(tmp, "work")
  fs.mkdirSync(workdir, { recursive: true })
  fs.writeFileSync(path.join(workdir, "README.md"), "probe\n")
  // A stale file from a previous case would read as "this mode allowed the write".
  try { fs.rmSync(TARGET, { force: true }) } catch {}

  const adapter = new AcpHarnessAdapter({
    binary: input.binary,
    harness: input.harness as never,
    storeRoot: path.join(tmp, "store"),
    createStore: (root?: string) => new RuntimeStore(root) as never,
    env: {
      ANTHROPIC_BASE_URL: MOCK,
      ANTHROPIC_API_KEY: "probe-key",
      OPENAI_BASE_URL: MOCK,
      OPENAI_API_KEY: "probe-key",
    } as never,
  })

  const out: Outcome = { mode: input.mode.id, level: input.mode.level ?? "-", asked: false, wrote: false }
  try {
    const session = await adapter.createSession(workdir)
    await adapter.setPermissionMode(session.id, input.mode.id, workdir)

    const deadline = Date.now() + TURN_TIMEOUT_MS
    const iterator = adapter.sendMessage(
      session.id,
      {
        parts: [{ type: "text", text: "Create the file." }],
        model: { providerID: input.harness, modelID: "probe-model" },
        // Deliberately matches no advertised mode id. `sync()` sets the ACP mode
        // from this field on every turn, so an agent name that collided with a
        // mode would silently overwrite the mode under test and the comparison
        // would be measuring the agent selector instead.
        agent: "enforcement-probe",
      } as never,
      workdir,
    )

    for await (const event of iterator) {
      const type = (event as { type?: string }).type
      if (type === "permission.asked") {
        out.asked = true
        break
      }
      if (type === "session.error") {
        out.detail = JSON.stringify((event as { properties?: unknown }).properties).slice(0, 300)
        break
      }
      if (Date.now() > deadline) {
        out.detail = "turn did not settle before the deadline"
        break
      }
    }
  } catch (error) {
    out.detail = (error as Error).message.slice(0, 300)
  } finally {
    try { adapter.dispose() } catch {}
  }

  // Read AFTER dispose, so a write racing the teardown is still counted.
  out.wrote = fs.existsSync(TARGET)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return out
}

const HARNESSES = [
  { harness: "claude", binary: () => acpBinary("claude-agent-acp", "@agentclientprotocol/claude-agent-acp") },
  { harness: "codex", binary: () => acpBinary("codex-acp", "@agentclientprotocol/codex-acp") },
] as const

const results: unknown[] = []

for (const entry of HARNESSES) {
  let binary: string
  try {
    binary = entry.binary()
  } catch (error) {
    results.push({ harness: `${entry.harness}-acp`, blocked: (error as Error).message })
    continue
  }

  // Ask the agent itself which of its modes are the rungs under test, rather
  // than hardcoding ids — the point is to exercise what this build advertises.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `enforce-list-${entry.harness}-`))
  const listDir = path.join(tmp, "work")
  fs.mkdirSync(listDir, { recursive: true })
  const lister = new AcpHarnessAdapter({
    binary,
    harness: entry.harness as never,
    storeRoot: path.join(tmp, "store"),
    createStore: (root?: string) => new RuntimeStore(root) as never,
    env: { ANTHROPIC_BASE_URL: MOCK, ANTHROPIC_API_KEY: "k", OPENAI_BASE_URL: MOCK, OPENAI_API_KEY: "k" } as never,
  })
  let modes: readonly AgentPermissionMode[] = []
  try {
    const s = await lister.createSession(listDir)
    modes = (await lister.listPermissionModes(s.id, listDir)).modes
  } finally {
    try { lister.dispose() } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }

  const gated = modes.find((m) => m.level === "ask")
  const open = modes.find((m) => m.level === "full")
  if (!gated || !open) {
    results.push({ harness: `${entry.harness}-acp`, blocked: `needs an ask and a full rung; got ${modes.map((m) => m.id)}` })
    continue
  }

  const under: Outcome[] = []
  for (const mode of [gated, open]) under.push(await runCase({ harness: entry.harness, binary, mode }))

  const [askCase, fullCase] = under as [Outcome, Outcome]
  results.push({
    harness: `${entry.harness}-acp`,
    under,
    // The claim being tested: the same tool call is stopped under one mode and
    // not the other. Either half alone proves nothing.
    enforced: askCase.asked && !askCase.wrote && !fullCase.asked && fullCase.wrote,
  })
}

console.log(JSON.stringify(results, null, 1))
process.exit(0)
