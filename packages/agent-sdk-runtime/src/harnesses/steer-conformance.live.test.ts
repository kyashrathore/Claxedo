import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAgentRuntime, type AgentHarnessFactory } from "../runtime"
import { createMemoryRuntimeStore } from "../stores/memory"
import type { AgentMessage, PromptDelivery } from "../index"
import type { SessionHarnessId } from "../harness-types"
import { claude, codex, cursor } from "./index"
import { harnessFactory } from "../harness-factories/factory"
import { PiHarnessAdapter } from "./pi"
import { removeTestTempDir } from "./shared/test-temp-dir"
import { CLAUDE_INSTALL_HINT, resolveClaudeExecutable } from "./claude/executable"
import { CODEX_INSTALL_HINT, resolveCodexExecutable } from "./codex/executable"
import { codexChatgptAuthTokens, readCodexAuthFile } from "./codex/auth-file"
import { PI_INSTALL_HINT, PI_VERSION, piCommand, resolvePiExecutable } from "./pi/executable"

/**
 * A prompt sent while a turn runs, driven against the real CLIs through the
 * public runtime, one harness at a time.
 *
 * The fake harnesses under `test-utils` answer `steer` because their fixtures
 * were written to; only the real protocols can say whether a mid-turn message
 * reaches the running turn (Claude's held-open stdin, Codex's `turn/steer`,
 * Pi's rpc `steer`) and whether that turn still terminates afterwards. The
 * Claude prompt is a stream the driver closes on the turn's result, so every
 * wait here is bounded: a query that never returns fails its test rather than
 * stalling the suite.
 *
 * Each case skips with the reason its harness is unreachable. Presence of the
 * binary is not enough — a spawned CLI authenticates from its own stored
 * credential, which the probes below read the way the harness does.
 */

const TURN_BUDGET_MS = 240_000
const FIRST_OUTPUT_BUDGET_MS = 120_000

type LiveCase = {
  id: SessionHarnessId
  factory: (directory: string) => AgentHarnessFactory
  /** What the runtime must answer for `delivery: "steer"` while this harness runs a turn. */
  delivery: Extract<PromptDelivery, "steer" | "queue">
  unavailable: string | undefined
}

function execCapture(file: string, args: string[], timeoutMs: number) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, output: `${stdout}${stderr}`.trim() })
    })
  })
}

// A real harness turn takes half a minute and needs a signed-in CLI and the
// network, which `bun test src` must not depend on.
const optIn = (process.env.CLAXEDO_LIVE_HARNESS ?? "").trim() ? undefined : "live harness runs are opt-in: set CLAXEDO_LIVE_HARNESS=1"

function ambientKey(...names: string[]) {
  return names.some((name) => (process.env[name] ?? "").trim().length > 0)
}

/**
 * `claude auth status` reports what a NEW process would authenticate with, which
 * is the only question that matters here: the Claude desktop app holds its
 * session in the host and leaves a keychain entry a spawned CLI cannot refresh,
 * so an interactive Claude on the machine is no evidence at all.
 */
async function claudeUnavailable(): Promise<string | undefined> {
  const binary = resolveClaudeExecutable()
  if (!binary) return `Claude Code is not installed. ${CLAUDE_INSTALL_HINT}`
  if (ambientKey("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")) return undefined
  const probe = await execCapture(binary, ["auth", "status"], 30_000)
  let status: { loggedIn?: unknown; authMethod?: unknown }
  try {
    status = JSON.parse(probe.output) as typeof status
  } catch {
    return `${binary} auth status did not answer JSON (exit ${probe.code}): ${probe.output.slice(0, 200)}`
  }
  return status.loggedIn === true
    ? undefined
    : `${binary} reports loggedIn=${String(status.loggedIn)}, authMethod=${String(status.authMethod)}`
}

function codexUnavailable(): string | undefined {
  const binary = resolveCodexExecutable()
  if (!binary) return `Codex is not installed. ${CODEX_INSTALL_HINT}`
  if (ambientKey("OPENAI_API_KEY")) return undefined
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  const auth = readCodexAuthFile(home)
  const signedIn = !!auth && (!!codexChatgptAuthTokens(auth) || typeof auth.OPENAI_API_KEY === "string")
  return signedIn ? undefined : `Codex is not signed in: no usable credential in ${path.join(home, "auth.json")}`
}

/**
 * Pi refuses any binary whose `--version` is not the pin, so a machine carrying
 * a different Pi cannot run a live turn at all. Its credential is read from the
 * agent directory the adapter owns, and the adapter scrubs that file when it is
 * released, so this case runs on a throwaway directory and takes its key from
 * the environment Pi itself reads.
 */
async function piUnavailable(): Promise<string | undefined> {
  const binary = resolvePiExecutable()
  if (!binary) return `no Pi executable found; expected ${PI_VERSION}. ${PI_INSTALL_HINT}`
  const command = piCommand(binary, ["--version"])
  const probe = await execCapture(command.file, command.args, 30_000)
  const installed = probe.output.split("\n")[0]?.trim() ?? ""
  if (installed !== PI_VERSION) return `Pi ${installed || `<exit ${probe.code}>`} is installed, pinned ${PI_VERSION}`
  return ambientKey("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    ? undefined
    : "Pi has no credential: set ANTHROPIC_API_KEY or OPENAI_API_KEY for this case to hand the adapter"
}

function cursorUnavailable(): string | undefined {
  return ambientKey("CURSOR_API_KEY") ? undefined : "Cursor has no API key: set CURSOR_API_KEY"
}

/** Pi reads its key from the process the adapter spawns, and its key comes from `setAuth`. */
function piHarness(directory: string): AgentHarnessFactory {
  return harnessFactory("pi", "native", (context) => {
    const adapter = new PiHarnessAdapter({
      store: context.store,
      eventHub: context.eventHub,
      agentDir: path.join(directory, ".pi-agent"),
    })
    adapter.setAuth({
      ...(process.env.ANTHROPIC_API_KEY ? { anthropic: process.env.ANTHROPIC_API_KEY } : {}),
      ...(process.env.OPENAI_API_KEY ? { openai: process.env.OPENAI_API_KEY } : {}),
    })
    return adapter
  })
}

const CASES: LiveCase[] = [
  { id: "claude", factory: () => claude(), delivery: "steer", unavailable: optIn ?? (await claudeUnavailable()) },
  { id: "codex", factory: () => codex(), delivery: "steer", unavailable: optIn ?? codexUnavailable() },
  { id: "pi", factory: piHarness, delivery: "steer", unavailable: optIn ?? (await piUnavailable()) },
  { id: "cursor", factory: () => cursor(), delivery: "queue", unavailable: optIn ?? cursorUnavailable() },
]

for (const harness of CASES) {
  if (harness.unavailable) console.log(`[live] ${harness.id} unreachable — ${harness.unavailable}`)
}

type RecordedEvent = { at: number; type: string; messageId?: string }

function liveSession(harness: LiveCase) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `steer-live-${harness.id}-`)))
  const runtime = createAgentRuntime({ store: createMemoryRuntimeStore(), harnesses: [harness.factory(directory)] })
  const startedAt = Date.now()
  const recorded: RecordedEvent[] = []
  const terminals: string[] = []
  let sessionId = ""

  const messageIdOf = (payload: { type: string; properties?: unknown }) => {
    const properties = (payload.properties ?? {}) as {
      info?: { id?: unknown }
      part?: { messageID?: unknown }
      messageID?: unknown
    }
    for (const candidate of [properties.info?.id, properties.part?.messageID, properties.messageID]) {
      if (typeof candidate === "string") return candidate
    }
    return undefined
  }

  return {
    directory,
    get sessionId() {
      return sessionId
    },
    recorded,
    async open() {
      const session = await runtime.sessions.create({
        workspaceId: `workspace-steer-${harness.id}`,
        directory,
        harness: { id: harness.id, access: "native" },
        title: `steer ${harness.id}`,
      })
      sessionId = session.id
      return session
    },
    /** Resolves on the terminal event of a turn, which is what "not hanging" means here. */
    watch(until: number) {
      return (async () => {
        for await (const event of runtime.events.subscribe({ sessionId })) {
          const payload = event.payload as { type: string; properties?: unknown }
          const messageId = messageIdOf(payload)
          recorded.push({ at: Date.now() - startedAt, type: payload.type, ...(messageId ? { messageId } : {}) })
          if (payload.type !== "session.idle" && payload.type !== "session.error") continue
          terminals.push(payload.type)
          if (terminals.length >= until) return terminals
        }
        return terminals
      })()
    },
    start(input: { text: string; delivery?: "steer" | "queue"; messageId?: string }) {
      return runtime.turns.start({
        sessionId,
        text: input.text,
        ...(input.delivery ? { delivery: input.delivery } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
      })
    },
    abort(turnId: string) {
      return runtime.turns.abort(sessionId, undefined, { turnId })
    },
    whenIdle() {
      return runtime.turns.whenIdle(sessionId)
    },
    messages() {
      return runtime.events.list(sessionId)
    },
    session() {
      return runtime.sessions.get(sessionId)
    },
    async assistantText(assistantMessageId: string) {
      const row = (await runtime.events.list(sessionId)).find((message) => message.info.id === assistantMessageId)
      return textOf(row)
    },
    /** The turn is running once its assistant message carries output the harness streamed. */
    async whenProducing(assistantMessageId: string) {
      const until = Date.now() + FIRST_OUTPUT_BUDGET_MS
      while (Date.now() < until) {
        const produced = await this.assistantText(assistantMessageId)
        if (produced.trim().length > 0) return { produced, waitedMs: Date.now() - startedAt }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return { produced: "", waitedMs: Date.now() - startedAt }
    },
    elapsed() {
      return Date.now() - startedAt
    },
    async dispose() {
      await runtime.dispose()
      removeTestTempDir(directory)
    },
  }
}

function textOf(message: AgentMessage | undefined) {
  return (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
}

function bounded<T>(work: Promise<T>, budgetMs: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`TIMEOUT after ${budgetMs}ms waiting for ${label}`), budgetMs)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

const countPrompt = "Count from 1 to 300, one number per line and nothing else. Do not use any tool. When you reach 300, say DONE."
const steerPrompt = (marker: string) =>
  `Stop counting. Abandon the rest of the count and reply with exactly ${marker} and nothing else.`

/** The junit report names every skipped case, so the name carries why it skipped. */
function title(harness: LiveCase, behaviour: string) {
  return harness.unavailable ? `${harness.id} ${behaviour} — SKIPPED: ${harness.unavailable}` : `${harness.id} ${behaviour}`
}

describe("a prompt sent while a real harness runs a turn", () => {
  for (const harness of CASES.filter((entry) => entry.delivery === "steer")) {
    test.skipIf(harness.unavailable !== undefined)(
      title(harness, "takes it into the running turn, which then ends without an abort"),
      async () => {
        const marker = `STEERED-${harness.id.toUpperCase()}-${Date.now().toString(36)}`
        const live = liveSession(harness)
        try {
          await live.open()
          const ended = live.watch(1)

          const first = await live.start({ text: countPrompt })
          expect(first.delivery).toBe("start")

          const producing = await live.whenProducing(first.assistantMessageId)
          expect(producing.produced, `${harness.id} streamed nothing within ${FIRST_OUTPUT_BUDGET_MS}ms`).not.toBe("")

          const steered = await live.start({ text: steerPrompt(marker), delivery: "steer" })
          expect(steered.delivery).toBe("steer")
          expect(steered.assistantMessageId).toBe(first.assistantMessageId)
          expect(steered.userMessageId).not.toBe(first.userMessageId)

          // The abort names a turn this session no longer runs, so it stops
          // nothing and leaves the turn that steer joined running.
          expect(await live.abort(`${first.userMessageId}-stale`)).toEqual({ ok: true, status: "already_idle" })
          expect((await live.session())?.status).toBe("busy")

          expect(await bounded(ended, TURN_BUDGET_MS, `${harness.id} to end the steered turn`)).toEqual(["session.idle"])
          const completedInMs = live.elapsed()

          const outcome = (await live.session())?.lastTurn
          expect(outcome).toMatchObject({ status: "completed", assistantMessageId: first.assistantMessageId })

          const messages = await live.messages()
          const steeredRow = messages.find((message) => message.info.id === steered.userMessageId)
          expect(steeredRow?.info.role).toBe("user")
          expect(textOf(steeredRow)).toContain(marker)
          const assistant = messages.filter((message) => message.info.role === "assistant")
          expect(assistant.map((message) => message.info.id)).toEqual([first.assistantMessageId])
          expect(steeredRow?.info.time?.created ?? Infinity)
            .toBeLessThanOrEqual(assistant[0]?.info.time?.completed ?? 0)

          const reply = textOf(assistant[0])
          expect(reply).toContain(marker)
          expect(reply.indexOf(marker), "the reply is only the steer, so the counting output it joined is missing")
            .toBeGreaterThan(0)

          console.log(
            `[live ${harness.id}] first output ${producing.waitedMs}ms, steered at ${producing.waitedMs}ms, `
              + `turn ended ${completedInMs}ms, reply tail ${JSON.stringify(reply.slice(-120))}`,
          )
        } finally {
          await live.dispose()
        }
      },
      TURN_BUDGET_MS + FIRST_OUTPUT_BUDGET_MS + 60_000,
    )
  }

  for (const harness of CASES.filter((entry) => entry.delivery === "queue")) {
    test.skipIf(harness.unavailable !== undefined)(
      title(harness, "cannot take one, so the runtime queues it behind the running turn"),
      async () => {
        const marker = `QUEUED-${harness.id.toUpperCase()}-${Date.now().toString(36)}`
        const queuedMessageId = `msg_queued_${Date.now().toString(36)}`
        const live = liveSession(harness)
        try {
          await live.open()
          const ended = live.watch(2)

          const first = await live.start({ text: countPrompt })
          const producing = await live.whenProducing(first.assistantMessageId)
          expect(producing.produced, `${harness.id} streamed nothing within ${FIRST_OUTPUT_BUDGET_MS}ms`).not.toBe("")

          const queued = await live.start({ text: steerPrompt(marker), delivery: "steer", messageId: queuedMessageId })
          expect(queued.delivery).toBe("queue")
          expect(queued.assistantMessageId).not.toBe(first.assistantMessageId)
          expect((await live.messages()).map((message) => message.info.id)).not.toContain(queuedMessageId)

          expect(await live.abort(`${first.userMessageId}-stale`)).toEqual({ ok: true, status: "already_idle" })
          expect((await live.session())?.status).toBe("busy")

          // The caller holding a queued prompt is what starts it, exactly as
          // `SessionService` does around `turns.whenIdle`.
          await bounded(live.whenIdle(), TURN_BUDGET_MS, `${harness.id} to finish the first turn`)
          const second = await live.start({ text: steerPrompt(marker), delivery: "steer", messageId: queuedMessageId })
          expect(second.delivery).toBe("start")

          expect(await bounded(ended, TURN_BUDGET_MS, `${harness.id} to end the queued turn`))
            .toEqual(["session.idle", "session.idle"])

          const firstEnded = live.recorded.findIndex((event) => event.type === "session.idle")
          const queuedPublished = live.recorded.findIndex((event) => event.messageId === queuedMessageId)
          expect(firstEnded).toBeGreaterThanOrEqual(0)
          expect(queuedPublished, "the queued prompt reached the transcript before the first turn ended")
            .toBeGreaterThan(firstEnded)

          const messages = await live.messages()
          expect(messages.filter((message) => message.info.role === "assistant").map((message) => message.info.id))
            .toEqual([first.assistantMessageId, second.assistantMessageId])
          expect(await live.assistantText(second.assistantMessageId)).toContain(marker)

          console.log(
            `[live ${harness.id}] first output ${producing.waitedMs}ms, queued turn started after the first ended, `
              + `both ended ${live.elapsed()}ms`,
          )
        } finally {
          await live.dispose()
        }
      },
      2 * TURN_BUDGET_MS + FIRST_OUTPUT_BUDGET_MS,
    )
  }
})
