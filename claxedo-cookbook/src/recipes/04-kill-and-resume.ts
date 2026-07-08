// WHAT: Durability with createSqliteRuntimeStore: a child process creates a
//       session, talks to a real agent, then gets SIGKILL'd while still alive —
//       and a second fresh process reopens the same sqlite root and recovers the
//       session and its full transcript.
// RUN:  bun run recipe:04-kill-and-resume   (invokes: npx tsx src/recipes/04-kill-and-resume.ts)
// NEEDS: better-sqlite3 (a dependency of this cookbook; the store falls back to it
//        under Node). A coding-agent harness on PATH for the live turn — with no
//        harness, phase 1 still creates + persists the session and says so honestly.
// WOW:  "killed pid X -> new process recovered session Y with N messages"

import { spawn } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createAgentRuntime } from "@claxedo/agent-sdk-runtime"
import { createSqliteRuntimeStore } from "@claxedo/agent-sdk-runtime/stores/sqlite"
import * as harnesses from "@claxedo/agent-sdk-runtime/harnesses"
import { banner, detectHarnesses, printResult, skip, type DetectedHarness } from "./_shared"

const SELF = fileURLToPath(import.meta.url)
const SESSION_TITLE = "kill me, I'll be back"
const phase = process.argv.find((arg) => arg.startsWith("--phase="))?.split("=")[1]

if (phase === "1") await phase1(process.argv[3]!)
else if (phase === "2") await phase2(process.argv[3]!, process.argv[4]!, process.argv[5]!)
else await orchestrate()

// ==================== orchestrator: spawn, kill, resume =====================
async function orchestrate() {
  banner({
    recipe: "04-kill-and-resume",
    what: "SIGKILL a live process holding an agent session; recover it from sqlite in a fresh process",
    wow: "the process dies, the session doesn't",
  })
  if (!process.versions.bun) {
    try {
      createRequire(import.meta.url).resolve("better-sqlite3")
    } catch {
      skip("better-sqlite3 is not installed (Node needs it for the sqlite store)", "npm i better-sqlite3")
    }
  }

  // One sqlite root shared by both phases; each phase is its own OS process.
  const root = await mkdtemp(path.join(tmpdir(), "claxedo-resume-"))

  // -- phase 1: child creates a session, runs a turn, then waits to be killed
  const phase1Result = await runPhase<{
    pid: number
    sessionId: string
    directory: string
    harness: string
    turn: string
  }>(["--phase=1", root], { killAfterMarker: true })
  console.log(`\n[parent] sent SIGKILL to pid ${phase1Result.pid} — no dispose(), no graceful close, nothing.\n`)

  // -- phase 2: a brand-new process opens the same root and recovers everything
  const phase2Result = await runPhase<{
    pid: number
    sessionsAtRoot: number
    recoveredSessionId: string
    idMatches: boolean
    title: string | null
    messageCount: number
    lastAssistantText: string
  }>(["--phase=2", root, phase1Result.sessionId, phase1Result.directory], { killAfterMarker: false })

  printResult("04-kill-and-resume", {
    harness: phase1Result.harness,
    turnInKilledProcess: phase1Result.turn,
    killed: `pid ${phase1Result.pid} (SIGKILL while holding the store open)`,
    recoveredBy: `pid ${phase2Result.pid} (fresh process, same sqlite root)`,
    sessionIdMatches: phase2Result.idMatches,
    recoveredTitle: phase2Result.title,
    recoveredMessages: phase2Result.messageCount,
    lastAssistantText: phase2Result.lastAssistantText,
    verdict: `killed pid ${phase1Result.pid} -> new process recovered session ${phase2Result.recoveredSessionId} with ${phase2Result.messageCount} messages`,
  })

  if (!phase2Result.idMatches || phase2Result.messageCount === 0) {
    console.error("FAIL: the fresh process did not recover the session and transcript created before the kill")
    process.exit(1)
  }
  process.exit(0)
}

// ========== phase 1: create session + turn, persist, then get killed ========
async function phase1(root: string) {
  const store = createSqliteRuntimeStore({ root })
  const runtime = createAgentRuntime({ store, harnesses: allFactories() })

  // Try detected harnesses in order until one completes a live turn: a binary
  // on PATH is not always logged in, and this recipe never fakes a transcript.
  let winner: { sessionId: string; directory: string; harness: string; turn: string } | undefined
  const attempts: string[] = []
  for (const pick of candidates()) {
    // SAFETY: each attempt works in a fresh temp dir, never in your repo.
    const dir = await mkdtemp(path.join(tmpdir(), "claxedo-resume-work-"))
    const session = await runtime.sessions.create({
      directory: dir,
      harness: { id: pick.id, access: pick.access },
      title: SESSION_TITLE,
    })
    const label = `${pick.id} (${pick.access})`
    let turn = "skipped (no harness on PATH)"
    if (pick.available) {
      const events = runtime.events.subscribe({ sessionId: session.id })
      await runtime.turns.start({
        sessionId: session.id,
        text: "Reply with exactly: RESUME PROOF",
        model: { providerID: pick.id, modelID: "default" }, // let the harness pick its default model
      })
      await waitForTerminal(events, 120_000)
      const outcome = await turnOutcome(runtime, session.id)
      turn = outcome?.status === "completed"
        ? "completed"
        : `${outcome?.status ?? "unknown"}${outcome && "error" in outcome ? `: ${outcome.error}` : ""}`
    }
    attempts.push(`${label} -> ${turn}`)
    winner ??= { sessionId: session.id, directory: dir, harness: label, turn }
    if (turn === "completed") {
      winner = { sessionId: session.id, directory: dir, harness: label, turn }
      break
    }
    console.log(`turn on ${label} did not complete (${turn}); trying the next detected harness`)
  }
  if (!winner) {
    // Still a valid durability demo: persist the session metadata, skip the turn.
    console.log("no coding-agent harness on PATH — persisting a session without a live turn")
    const dir = await mkdtemp(path.join(tmpdir(), "claxedo-resume-work-"))
    const session = await runtime.sessions.create({
      directory: dir,
      harness: { id: "claude", access: "native" },
      title: SESSION_TITLE,
    })
    winner = { sessionId: session.id, directory: dir, harness: "claude (native, binary missing)", turn: "skipped (no harness on PATH)" }
  }

  // Every store change was already written through to <root>/agent-runtime.db
  // by the sqlite store. Announce readiness, then just stay alive: the parent
  // kills this process with SIGKILL — dispose() is never called.
  emit("PHASE1", { pid: process.pid, ...winner, attempts: attempts.join(" | ") })
  setInterval(() => {}, 1 << 30) // hold the process open for the incoming SIGKILL
}

// ====== phase 2: fresh process, same root — list, fetch, prove recovery =====
async function phase2(root: string, expectedSessionId: string, directory: string) {
  const store = createSqliteRuntimeStore({ root }) // hydrates from agent-runtime.db
  const runtime = createAgentRuntime({ store, harnesses: allFactories() })

  const sessions = await runtime.sessions.list(directory)
  const session = await runtime.sessions.get(expectedSessionId)
  const messages = await runtime.events.list(expectedSessionId)

  emit("PHASE2", {
    pid: process.pid,
    sessionsAtRoot: sessions.length,
    recoveredSessionId: session?.id ?? "(not found)",
    idMatches: session?.id === expectedSessionId && sessions.some((row) => row.id === expectedSessionId),
    title: session?.title ?? null,
    messageCount: messages.length,
    lastAssistantText: assistantText(messages as Array<{ info: { role: string }; parts: unknown[] }>),
  })
  runtime.dispose()
  process.exit(0)
}

// ---- helpers ---------------------------------------------------------------

/** Detected harnesses, native first (cheapest to try), de-duplicated. */
function candidates(): DetectedHarness[] {
  const order = (h: DetectedHarness) => (h.access === "native" ? 0 : 1)
  return detectHarnesses()
    .filter((h) => h.available && h.id !== "opencode")
    .sort((a, b) => order(a) - order(b))
}

/** Register every harness this recipe might route a session to (all lazy). */
function allFactories() {
  return [
    harnesses.claude(),
    harnesses.codex(),
    harnesses.cursor(),
    harnesses.claude({ access: "acp" }),
    harnesses.codex({ access: "acp" }),
    harnesses.cursor({ access: "acp" }),
  ]
}

/** Spawn this same file (same tsx loader via execArgv) as a child phase. */
function runPhase<T>(args: string[], options: { killAfterMarker: boolean }): Promise<T> {
  return new Promise((resolve, reject) => {
    const label = args[0]!.replace("--phase=", "phase")
    const child = spawn(process.execPath, [...process.execArgv, SELF, ...args], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    let buffered = ""
    let marker: T | undefined
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString()
      let newline: number
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        const match = line.match(/^##(PHASE\d)## (.*)$/)
        if (match) {
          marker = JSON.parse(match[2]!) as T
          if (options.killAfterMarker) {
            child.kill("SIGKILL")
          }
        } else if (line.trim()) {
          console.log(`  [${label}] ${line}`)
        }
      }
    })
    child.on("exit", (code, signal) => {
      if (marker) return resolve(marker)
      reject(new Error(`${label} exited (code=${code} signal=${signal}) before reporting its marker`))
    })
    child.on("error", reject)
  })
}

function emit(tag: string, payload: unknown) {
  console.log(`##${tag}## ${JSON.stringify(payload)}`)
}

/** The turn outcome lands in the store just after the terminal event; poll briefly. */
async function turnOutcome(runtime: ReturnType<typeof createAgentRuntime>, sessionId: string) {
  for (let i = 0; i < 20; i++) {
    const outcome = (await runtime.sessions.get(sessionId))?.lastTurn
    if (outcome) return outcome
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

/** Drain events until the turn reaches a terminal state, or the deadline hits. */
async function waitForTerminal(stream: AsyncIterable<{ payload: { type: string } }>, timeoutMs: number) {
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs).unref())
  const iterator = stream[Symbol.asyncIterator]()
  while (true) {
    const next = await Promise.race([iterator.next(), timeout])
    if (next === "timeout" || next === undefined) {
      await iterator.return?.()
      return
    }
    if (next.done) return
    const type = next.value.payload.type
    if (type === "session.idle" || type === "session.error" || type === "finish" || type === "error") {
      await iterator.return?.()
      return
    }
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
