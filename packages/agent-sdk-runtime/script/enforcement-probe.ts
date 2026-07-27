/**
 * Live enforcement probe: does a chosen permission mode actually GATE a tool call?
 *
 * `permission-probe.ts` proves a mode reaches the harness and is echoed back.
 * That is not enforcement — an agent can acknowledge a mode and ignore it, which
 * is exactly what this found. It drives a real turn under EVERY mode the agent
 * advertises and compares what happens to the identical tool call: which modes
 * stop and ask, and which let it run.
 *
 * The ONLY faked thing is the model's reply. That is deliberate and necessary: a
 * real model may or may not decide to call a tool, and a comparison between two
 * runs is meaningless unless both runs request the identical call. Everything
 * else is real — the agent binary, the ACP handshake, `session/new`,
 * `session/set_mode`, the agent's own permission machinery, and the filesystem
 * the tool would write to.
 *
 * Run: bun run script/enforcement-probe.ts
 *   ONLY_HARNESS=claude   restrict to one harness
 *   ONLY_MODES=a,b        restrict to named modes
 *
 * STATUS, so a green-looking run is not mistaken for a proof:
 *   claude-acp  reaches the model and raises real permission requests, but every
 *               mode raises the SAME one — see the note on `enforced` below.
 *   codex-acp   not yet reachable. It authenticates through ~/.codex/auth.json
 *               in ChatGPT mode and ignores OPENAI_BASE_URL, so the mock is never
 *               called (`modelCalls: 0`). Needs a custom `model_provider` with a
 *               `base_url` passed via `-c` before it can be measured.
 *   cursor-acp  not attempted; its endpoint is proprietary.
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

/**
 * The mock model runs INSIDE this process.
 *
 * It used to be a separate `bun run script/mock-model.ts` in another terminal,
 * and that produced a false result worth recording: the server was killed part
 * way through a matrix, so the last two modes saw no model at all, made no tool
 * call, and were scored as "did not ask" — indistinguishable from a mode that
 * genuinely opens the gate. Owning the server means it cannot be missing, and
 * `modelCalls` below means a case that never reached the model is visibly not
 * evidence either way.
 */
const PORT = Number(process.env.MOCK_PORT ?? 8899)
const MOCK = `http://127.0.0.1:${PORT}`
let modelCalls = 0

const TOOL_INPUT = (file: string) => ({ file_path: file, content: "hi\n" })

function mockServer(targetFile: () => string) {
  return Bun.serve({
    port: PORT,
    idleTimeout: 120,
    async fetch(req) {
      if (req.method !== "POST") return new Response("ok")
      modelCalls += 1
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const msgs = JSON.stringify(body.messages ?? [])
      // Once the tool result comes back, stop; otherwise the agent loops forever
      // re-requesting the same write and the turn never ends on its own.
      const done = msgs.includes('"tool_result"')
      const id = `toolu_probe_${modelCalls}`
      const content = done
        ? [{ type: "text", text: "Done." }]
        : [{ type: "tool_use", id, name: "Write", input: TOOL_INPUT(targetFile()) }]
      const stop = done ? "end_turn" : "tool_use"

      if (body.stream) {
        const events: string[] = [
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: `msg_${modelCalls}`, type: "message", role: "assistant", model: body.model ?? "mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
        ]
        content.forEach((block, index) => {
          if (block.type === "text") {
            events.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "text", text: "" } })}\n\n`)
            events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "text_delta", text: (block as { text: string }).text } })}\n\n`)
          } else {
            const tu = block as { id: string; name: string; input: unknown }
            events.push(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} } })}\n\n`)
            events.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) } })}\n\n`)
          }
          events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`)
        })
        events.push(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } })}\n\n`)
        events.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)
        return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } })
      }

      return new Response(
        JSON.stringify({ id: `msg_${modelCalls}`, type: "message", role: "assistant", model: body.model ?? "mock", content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
}
/**
 * The file the mocked model asks to write, INSIDE the case's own workspace.
 *
 * Deliberately not a path in /tmp. Writing outside the project is itself
 * something several harnesses gate separately, so an out-of-workspace target
 * would conflate "this mode gates writes" with "this agent gates leaving the
 * project" — and the first probe used /tmp, which is why its results could not
 * be read cleanly. A file in the workspace is the ordinary case the modes are
 * actually about.
 */
let currentTarget = ""
/** A turn that is correctly gated never completes, so it is stopped on the ask. */
const TURN_TIMEOUT_MS = Number(process.env.ENFORCEMENT_TIMEOUT_MS ?? 40_000)

type Outcome = {
  mode: string
  level: string
  asked: boolean
  wrote: boolean
  /** How the turn finished: asked / completed / error / timeout. */
  ended?: string
  /**
   * How many times the mocked model was called for this case. Zero means the
   * agent never got a reply to act on, so `asked: false` says nothing about the
   * mode — it is an inconclusive row, not a permissive one.
   */
  modelCalls?: number
  askDetail?: string
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
  // Fresh directory per case, so a write can only have come from THIS case —
  // a shared target would let one mode's success read as the next mode's.
  const target = path.join(workdir, "enforcement-probe-target.txt")
  currentTarget = target
  const callsBefore = modelCalls

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

    /**
     * A correctly gated turn produces no further events while it waits for an
     * answer that never comes, so the deadline cannot live inside the loop —
     * there is no next iteration to check it in. Racing the whole drain against
     * a timer is the only shape that terminates in both outcomes, and "timed out
     * with no permission asked" is itself a distinguishable result rather than a
     * hang.
     */
    const drain = (async () => {
      for await (const event of iterator) {
        const type = (event as { type?: string }).type
        if (type === "permission.asked") {
          out.asked = true
          out.askDetail = JSON.stringify((event as { properties?: unknown }).properties).slice(0, 400)
          return "asked"
        }
        if (type === "session.error") {
          out.detail = JSON.stringify((event as { properties?: unknown }).properties).slice(0, 200)
          return "error"
        }
      }
      return "completed"
    })()

    out.ended = (await Promise.race([
      drain,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), TURN_TIMEOUT_MS)),
    ])) as string
  } catch (error) {
    out.detail = (error as Error).message.slice(0, 300)
  } finally {
    try { adapter.dispose() } catch {}
  }

  // Read AFTER dispose, so a write racing the teardown is still counted.
  out.wrote = fs.existsSync(target)
  out.modelCalls = modelCalls - callsBefore
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return out
}

const ONLY = process.env.ONLY_HARNESS
const HARNESSES = [
  { harness: "claude", binary: () => acpBinary("claude-agent-acp", "@agentclientprotocol/claude-agent-acp") },
  { harness: "codex", binary: () => acpBinary("codex-acp", "@agentclientprotocol/codex-acp") },
] as const

const server = mockServer(() => currentTarget)
const results: unknown[] = []

for (const entry of HARNESSES.filter((e) => !ONLY || e.harness === ONLY)) {
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

  // EVERY advertised mode, not a chosen pair. Picking two in advance assumes we
  // already know which ones gate, and the first run of this probe was wrong
  // about exactly that: `bypassPermissions` asked, so a pass/fail built on it
  // reported "not enforced" when the real answer was "that is not the mode that
  // opens the gate". A full matrix cannot be wrong in that direction — it shows
  // which modes gate and which do not, and the claim is read off it afterwards.
  const under: Outcome[] = []
  const MODES = process.env.ONLY_MODES?.split(',')
  for (const mode of modes.filter((m) => !MODES || MODES.includes(m.id))) under.push(await runCase({ harness: entry.harness, binary, mode }))

  // Rows where the model was never reached prove nothing in either direction.
  const conclusive = under.filter((o) => (o.modelCalls ?? 0) > 0)
  const gatedModes = conclusive.filter((o) => o.asked).map((o) => o.mode)
  const ranFreely = conclusive.filter((o) => !o.asked && o.wrote).map((o) => o.mode)
  const inconclusive = under.filter((o) => (o.modelCalls ?? 0) === 0).map((o) => o.mode)
  results.push({
    harness: `${entry.harness}-acp`,
    under,
    gatedModes,
    ranFreely,
    ...(inconclusive.length ? { inconclusive } : {}),
    // The claim: the SAME tool call is stopped under at least one mode and runs
    // unprompted under at least one other. Either half alone proves nothing —
    // everything gating could just mean the harness always asks, and everything
    // running could mean the mode was never applied.
    enforced: gatedModes.length > 0 && ranFreely.length > 0,
  })
}

server.stop(true)
console.log(JSON.stringify(results, null, 1))
process.exit(0)
