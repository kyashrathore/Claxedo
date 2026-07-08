// WHAT: Create an agent runtime, open a session, send one message, print the reply.
// RUN:  bun run recipe:01-hello-agent            (runs: tsx src/recipes/01-hello-agent.ts)
// NEEDS: One coding-agent CLI that is installed AND authenticated. Detected via
//        detectHarnesses() (binary on PATH) plus a cheap auth probe per CLI
//        (`claude auth status`, `codex login status`, CURSOR_API_KEY). Missing -> SKIP.
// WOW:  The essential path — runtime, session, turn, reply — is the ~15 lines
//       between the ==== markers. Everything else is detection and printing.

import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAgentRuntime, type AgentRuntime } from "@claxedo/agent-sdk-runtime"
import { createMemoryRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/memory"
import { claude, codex, cursor } from "@claxedo/agent-sdk-runtime/harnesses"
import { banner, detectHarnesses, printResult, skip, type DetectedHarness } from "./_shared"

banner({
  recipe: "01-hello-agent",
  what: "runtime -> session -> one message -> reply, against a real coding agent",
  wow: "the whole essential path fits in ~15 lines",
})

// ---- pick a harness: prefer claude(acp), then claude, then codex/cursor ----
const PREFERENCE = ["claude:acp", "claude:native", "codex:acp", "codex:native", "cursor:acp", "cursor:native"]
const candidates = detectHarnesses()
  .map((h) => ({ ...h, auth: authProbe(h) }))
  .sort((a, b) => PREFERENCE.indexOf(`${a.id}:${a.access}`) - PREFERENCE.indexOf(`${b.id}:${b.access}`))
const pick = candidates.find((h) => h.available && h.auth.ready)
if (!pick) {
  for (const h of candidates) console.log(`  not runnable: ${h.id} (${h.access}) — ${h.available ? h.auth.why : h.reason}`)
  skip(
    "no coding-agent harness is installed and authenticated",
    "log into one CLI (`claude /login`, `codex login`) or set its API key (ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY)",
  )
}
console.log(`using harness: ${pick.id} (${pick.access}) — ${pick.auth.why}`)

// ---- SAFETY: the agent works in a fresh temp dir, never in your repo -------
const dir = await mkdtemp(path.join(tmpdir(), "claxedo-hello-"))
await writeFile(path.join(dir, "README.md"), "# hello-agent scratch\nA tiny playground seeded for the agent.\n")
await writeFile(path.join(dir, "haiku.txt"), "an agent wakes up\nreads two files, says exactly\nwhat it was told to\n")

// ============================ the essential path ============================
const runtime = createAgentRuntime({
  store: createMemoryRuntimeStore(),
  harnesses: [harnessFactory(pick)],
})

const session = await runtime.sessions.create({
  directory: dir,
  harness: { id: pick.id, access: pick.access },
  model: { providerID: pick.id, modelID: "default" }, // "default" = the harness's own default model
  title: "hello agent",
})

const events = runtime.events.subscribe({ sessionId: session.id })
await runtime.turns.start({
  sessionId: session.id,
  agent: "", // let the harness use its default agent/mode
  text: "Reply with exactly: HELLO FROM CLAXEDO",
})
const turn = await waitForTurn(runtime, events, dir, 120_000)
const reply = await settledReply(runtime, session.id)
// ============================================================================

runtime.dispose()

printResult("01-hello-agent", {
  harness: `${pick.id} (${pick.access})`,
  turn: turn.status,
  reply,
})

if (turn.status !== "completed" || !reply) {
  console.error(`FAIL: turn ended as "${turn.status}"${turn.error ? ` (${turn.error})` : ""} — no reply captured`)
  process.exit(1)
}
process.exit(0)

// ---- helpers ---------------------------------------------------------------

/** Map a detected harness onto its @claxedo/agent-sdk-runtime factory. */
function harnessFactory(h: DetectedHarness) {
  const make = { claude, codex, cursor }[h.id as "claude" | "codex" | "cursor"]
  if (!make) skip(`harness "${h.id}" has no factory wired in this recipe`)
  return h.access === "acp" ? make({ access: "acp" }) : make()
}

/** Cheap credential probe per CLI, so we skip instead of failing mid-turn. */
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
    return { ready: false, why: "claude CLI installed but not logged in (run `claude /login` or set ANTHROPIC_API_KEY)" }
  }
  if (h.id === "codex") {
    if (process.env.OPENAI_API_KEY) return { ready: true, why: "OPENAI_API_KEY set" }
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" })
    if (probe.status === 0) return { ready: true, why: "codex CLI logged in" }
    return { ready: false, why: "codex CLI installed but not logged in (run `codex login` or set OPENAI_API_KEY)" }
  }
  if (h.id === "cursor") {
    if (process.env.CURSOR_API_KEY) return { ready: true, why: "CURSOR_API_KEY set" }
    return { ready: false, why: "cursor needs CURSOR_API_KEY (its login state is not cheaply probeable)" }
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

/**
 * The terminal event can land a beat before the store finishes flushing the
 * final assistant message — poll briefly instead of racing it.
 */
async function settledReply(rt: AgentRuntime, sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const reply = assistantText(await rt.events.list(sessionId))
    if (reply) return reply
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return ""
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
