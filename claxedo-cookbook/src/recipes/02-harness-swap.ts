// WHAT: Run the exact same session/message/reply function against every coding
//       agent on this machine — the only thing that changes is the harness id.
// RUN:  bun run recipe:02-harness-swap           (runs: tsx src/recipes/02-harness-swap.ts)
// NEEDS: At least one coding-agent CLI installed AND authenticated. Detected via
//        detectHarnesses() (binary on PATH) plus a cheap auth probe per CLI
//        (`claude auth status`, `codex login status`, CURSOR_API_KEY). None -> SKIP.
// WOW:  runOnce() below never mentions a vendor. Claude, Codex and Cursor all run
//       through the identical code path — swapping agents is swapping one string.

import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAgentRuntime, type AgentRuntime } from "@claxedo/agent-sdk-runtime"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { claude, codex, cursor } from "@claxedo/agent-sdk-runtime/harnesses"
import { banner, detectHarnesses, printResult, skip, type DetectedHarness } from "./_shared"

banner({
  recipe: "02-harness-swap",
  what: "one runOnce() function, every available harness — only the harness id changes",
  wow: "vendor-agnostic agent code: the harness is data, not architecture",
})

// ======================= THE moat: one function, any agent ==================
// Nothing in here is claude-specific, codex-specific, or cursor-specific.
async function runOnce(harness: { id: DetectedHarness["id"]; access: DetectedHarness["access"] }) {
  const dir = await mkdtemp(path.join(tmpdir(), `claxedo-swap-${harness.id}-`)) // fresh sandbox dir, never your repo
  await writeFile(path.join(dir, "README.md"), "# harness-swap scratch\nSeeded playground for the agent.\n")

  const runtime = createAgentRuntime({
    store: createMemoryRuntimeStore(),
    harnesses: [harnessFactory(harness)],
  })
  try {
    const session = await runtime.sessions.create({
      directory: dir,
      harness,
      model: { providerID: harness.id, modelID: "default" }, // "default" = the harness's own default model
      title: `swap ${harness.id}`,
    })
    const events = runtime.events.subscribe({ sessionId: session.id })
    await runtime.turns.start({
      sessionId: session.id,
      agent: "", // let the harness use its default agent/mode
      text: `Reply with exactly: HELLO FROM ${harness.id.toUpperCase()} VIA CLAXEDO`,
    })
    const turn = await waitForTurn(runtime, events, dir, 120_000)
    const reply = assistantText(await runtime.events.list(session.id))
    return { turn, reply }
  } finally {
    runtime.dispose()
  }
}
// ============================================================================

type Row = {
  harness: string
  access: string
  status: string
  reply: string
}

const candidates = detectHarnesses().map((h) => ({ ...h, auth: authProbe(h) }))
const runnable = candidates.filter((h) => h.available && h.auth.ready)
const skipped = candidates.filter((h) => !h.available || !h.auth.ready)

console.log("detected but not runnable:")
for (const h of skipped) console.log(`  - ${h.id} (${h.access}): ${h.available ? h.auth.why : h.reason}`)
if (runnable.length === 0) {
  skip(
    "no coding-agent harness is installed and authenticated",
    "log into one CLI (`claude /login`, `codex login`) or set its API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY)",
  )
}

const rows: Row[] = []
let replied = 0
for (const h of runnable) {
  console.log(`\n>>> running ${h.id} (${h.access}) — ${h.auth.why}`)
  try {
    const { turn, reply } = await runOnce({ id: h.id, access: h.access })
    const ok = turn.status === "completed" && !!reply
    if (ok) replied += 1
    console.log(ok ? `<<< ${h.id} replied: ${reply}` : `<<< ${h.id} ${turn.status}: ${turn.error ?? "no reply"}`)
    rows.push({
      harness: h.id,
      access: h.access,
      status: ok ? "replied" : `failed (${turn.error ?? turn.status})`,
      reply: reply.slice(0, 48),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`<<< ${h.id} threw: ${message}`)
    rows.push({ harness: h.id, access: h.access, status: `failed (${message.slice(0, 60)})`, reply: "" })
  }
}
for (const h of skipped) {
  rows.push({
    harness: h.id,
    access: h.access,
    status: `skipped (${(h.available ? h.auth.why : h.reason).split(" (")[0]})`,
    reply: "",
  })
}

printResult("02-harness-swap", table(rows))
printResult("02-harness-swap summary", {
  ran: runnable.map((h) => `${h.id}:${h.access}`),
  replied,
  sameCodeForAll: true,
})

process.exit(replied > 0 ? 0 : 1)

// ---- helpers ---------------------------------------------------------------

/** Map a detected harness onto its @claxedo/agent-sdk-runtime factory. */
function harnessFactory(h: { id: DetectedHarness["id"]; access: DetectedHarness["access"] }) {
  const make = { claude, codex, cursor }[h.id as "claude" | "codex" | "cursor"]
  if (!make) throw new Error(`harness "${h.id}" has no factory wired in this recipe`)
  return h.access === "acp" ? make({ access: "acp" }) : make()
}

/** Cheap credential probe per CLI, so we report skips instead of failing mid-turn. */
function authProbe(h: DetectedHarness): { ready: boolean; why: string } {
  if (!h.available) return { ready: false, why: h.reason }
  if (h.id === "claude") {
    if (process.env.ANTHROPIC_API_KEY) return { ready: true, why: "ANTHROPIC_API_KEY set" }
    const probe = spawnSync("claude", ["auth", "status"], { encoding: "utf8" })
    try {
      if (JSON.parse(probe.stdout).loggedIn === true) return { ready: true, why: "claude CLI logged in" }
    } catch {
      return { ready: true, why: "auth status not probeable; letting the turn decide" }
    }
    return { ready: false, why: "installed but not logged in (run `claude /login` or set ANTHROPIC_API_KEY)" }
  }
  if (h.id === "codex") {
    if (process.env.OPENAI_API_KEY) return { ready: true, why: "OPENAI_API_KEY set" }
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" })
    if (probe.status === 0) return { ready: true, why: "codex CLI logged in" }
    return { ready: false, why: "installed but not logged in (run `codex login` or set OPENAI_API_KEY)" }
  }
  if (h.id === "cursor") {
    if (process.env.CURSOR_API_KEY) return { ready: true, why: "CURSOR_API_KEY set" }
    return { ready: false, why: "needs CURSOR_API_KEY (its login state is not cheaply probeable)" }
  }
  return { ready: true, why: "ok" }
}

/**
 * Drain the session's event stream until the turn finishes (idle) or fails.
 * Auto-allows any tool-permission ask so the demo never wedges on approval.
 */
async function waitForTurn(
  rt: AgentRuntime,
  stream: AsyncIterable<{ payload: { type: string } }>,
  directory: string,
  timeoutMs: number,
): Promise<{ status: "completed" | "failed" | "timeout"; error?: string }> {
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs).unref())
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout])
      if (next === "timeout") return { status: "timeout", error: `no terminal event within ${timeoutMs / 1000}s` }
      if (next.done) return { status: "failed", error: "event stream closed early" }
      const payload = next.value.payload as { type: string; properties?: { id?: string; error?: { data?: { message?: string } } }; error?: string }
      if (payload.type === "permission.asked" && payload.properties?.id) {
        void rt.permissions.respond(payload.properties.id, "allow_once", directory)
      }
      if (payload.type === "session.idle" || payload.type === "finish") return { status: "completed" }
      if (payload.type === "session.error") return { status: "failed", error: payload.properties?.error?.data?.message }
      if (payload.type === "error") return { status: "failed", error: payload.error }
    }
  } finally {
    await iterator.return?.()
  }
}

/** Pull the text of the last assistant message out of the transcript. */
function assistantText(messages: Array<{ info: { role: string }; parts: unknown[] }>) {
  const assistant = messages.filter((m) => m.info.role === "assistant").at(-1)
  return (assistant?.parts ?? [])
    .map((part) => {
      const row = part as { type?: string; text?: string }
      return row?.type === "text" && typeof row.text === "string" ? row.text : ""
    })
    .join("")
    .trim()
}

/** Render rows as a plain fixed-width table (docs paste this verbatim). */
function table(input: Row[]) {
  const headers = { harness: "harness", access: "access", status: "status", reply: "reply" }
  const all = [headers, ...input]
  const width = (key: keyof Row) => Math.max(...all.map((row) => row[key].length))
  return all
    .map((row, i) => {
      const line = (["harness", "access", "status", "reply"] as const).map((key) => row[key].padEnd(width(key))).join("  ")
      return i === 0 ? `${line}\n${"-".repeat(line.length)}` : line
    })
    .join("\n")
}
