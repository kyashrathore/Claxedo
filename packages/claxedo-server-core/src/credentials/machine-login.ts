import { execFile, spawn } from "child_process"
import { jsonNumber, jsonRecord, jsonString, jsonText, parseJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { CredentialUsageWindow } from "./operations/verify"

const log = Log.create({ service: "credentials-machine-login" })

/**
 * The login a harness holds on this computer, as the harness itself reports it.
 *
 * Nothing here reads a secret. Where each CLI keeps its token is that CLI's
 * business, and a copy Claxedo took would rot the moment the CLI refreshed it;
 * the questions worth asking — is there a login, whose is it, how much of the
 * plan is left — are ones the harness answers about the login it will actually
 * use when we invoke it.
 */
export type MachineLogin = {
  harness: MachineLoginHarness
  /** The registry provider ids this harness resolves its auth through. */
  providerIds: readonly string[]
  /** Those of `providerIds` this login drives, where it does not drive them all. */
  serves?: readonly string[]
  state: MachineLoginState
  /** The address the harness says it is signed in as. */
  email?: string
  /** The subscription the harness names, in the harness's own word ("max", "pro"). */
  plan?: string
  /** The organization the harness names, where it names one. */
  org?: string
  /** Quota windows, for the harnesses that report them. */
  usage?: CredentialUsageWindow[]
  /** Why the harness could not be asked, when `state` is `unknown`. */
  detail?: string
}

/**
 * `signed_in` — the harness answered and has a login to run on.
 * `signed_out` — the harness answered and has none; the repair is its own login.
 * `absent` — the CLI is not installed, so there is no login to speak of.
 * `unknown` — the CLI is installed and could not be asked; `detail` says why.
 */
export type MachineLoginState = "signed_in" | "signed_out" | "absent" | "unknown"

export const MACHINE_LOGIN_HARNESSES = ["claude", "codex", "cursor"] as const
export type MachineLoginHarness = (typeof MACHINE_LOGIN_HARNESSES)[number]

export function isMachineLoginHarness(value: string): value is MachineLoginHarness {
  return (MACHINE_LOGIN_HARNESSES as readonly string[]).includes(value)
}

const PROVIDER_IDS: Record<MachineLoginHarness, readonly string[]> = {
  claude: ["claude-acp", "claude-sdk"],
  codex: ["codex-app-server", "openai"],
  cursor: ["cursor-acp", "cursor-sdk"],
}

/**
 * The bindings a machine login actually drives, for the harnesses where that is
 * narrower than the set they resolve auth through.
 *
 * `cursor-agent login` signs the CLI in, and Cursor ACP runs on it. The Cursor
 * SDK takes its key as an `Agent.create` argument and reads nothing from that
 * login, so it refuses a turn with `Cursor SDK requires an explicit cursor-sdk
 * API key` however signed in the CLI is.
 */
const SERVED_PROVIDER_IDS: Partial<Record<MachineLoginHarness, readonly string[]>> = {
  cursor: ["cursor-acp"],
}

/**
 * One command run, reduced to what a self-report needs.
 *
 * `found` is false only when the binary is not there: every other failure — a
 * non-zero exit, an unreadable answer — is the harness answering badly, which
 * is a different verdict from not being installed.
 */
export type MachineLoginRun = { found: boolean; ok: boolean; stdout: string; stderr?: string }

export type MachineLoginProbes = {
  run?: (file: string, args: readonly string[]) => Promise<MachineLoginRun>
  /** Asks the Codex app-server for the account and its quota windows. */
  codexAccount?: () => Promise<{ account: unknown; rateLimits: unknown }>
}

const TIMEOUT_MS = 10_000

const runCommand = (file: string, args: readonly string[]): Promise<MachineLoginRun> =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
      const code = error && "code" in error ? error.code : undefined
      resolve({ found: code !== "ENOENT", ok: !error, stdout, stderr })
    })
  })

/** How long a harness's answer stands before it is asked again. */
const FRESH_FOR_MS = 10_000

export type MachineLoginRead = MachineLoginProbes & {
  /**
   * Ask the harness again rather than reusing its last answer. What a row's
   * Check means: a button that returned a remembered answer would report the
   * state the user pressed it to find out had changed.
   */
  fresh?: boolean
}

/**
 * One read per harness at a time, and its answer for a short while after.
 *
 * Reading a harness costs a process — the Codex app-server takes about a
 * second — and the Settings section, the onboarding check and a row's Check can
 * all ask at once. Callers that arrive together share one read; a caller that
 * arrives just after one gets its answer rather than spawning the same binary
 * again. Its own clock and reader so the behaviour can be exercised without
 * spawning anything.
 */
export function createMachineLoginCache(input: {
  read: (harness: MachineLoginHarness) => Promise<MachineLogin>
  now?: () => number
  freshForMs?: number
}) {
  const now = input.now ?? Date.now
  const freshForMs = input.freshForMs ?? FRESH_FOR_MS
  const answers = new Map<MachineLoginHarness, { at: number; login: MachineLogin }>()
  const asking = new Map<MachineLoginHarness, Promise<MachineLogin>>()
  return {
    read(harness: MachineLoginHarness, options: { fresh?: boolean } = {}): Promise<MachineLogin> {
      const held = answers.get(harness)
      if (!options.fresh && held && now() - held.at < freshForMs) return Promise.resolve(held.login)
      // A read already in flight is joined even by a `fresh` caller: it was
      // started no earlier than this call, so its answer is as new as one
      // started now, and a second spawn of the same binary buys nothing.
      const inFlight = asking.get(harness)
      if (inFlight) return inFlight
      const started = input.read(harness)
        .then((login) => {
          answers.set(harness, { at: now(), login })
          return login
        })
        .finally(() => asking.delete(harness))
      asking.set(harness, started)
      return started
    },
    forget() {
      answers.clear()
      asking.clear()
    },
  }
}

const machineLogins = createMachineLoginCache({ read: (harness) => askHarness(harness, {}) })

export async function readMachineLogins(
  harnesses: readonly MachineLoginHarness[] = MACHINE_LOGIN_HARNESSES,
  options: MachineLoginRead = {},
): Promise<MachineLogin[]> {
  // A caller with probes of its own is asking a question about those probes,
  // not about this machine, so it never reads or writes the remembered answers.
  if (options.run || options.codexAccount) return Promise.all(harnesses.map((harness) => askHarness(harness, options)))
  return Promise.all(harnesses.map((harness) => machineLogins.read(harness, { fresh: options.fresh === true })))
}

function askHarness(harness: MachineLoginHarness, probes: MachineLoginProbes): Promise<MachineLogin> {
  const run = probes.run ?? runCommand
  if (harness === "claude") return claudeMachineLogin(run)
  if (harness === "codex") return codexMachineLogin(run, probes.codexAccount ?? codexAccountRead)
  return cursorMachineLogin(run)
}

function report(
  harness: MachineLoginHarness,
  rest: Omit<MachineLogin, "harness" | "providerIds" | "serves">,
): MachineLogin {
  const serves = SERVED_PROVIDER_IDS[harness]
  return { harness, providerIds: PROVIDER_IDS[harness], ...(serves ? { serves } : {}), ...rest }
}

/**
 * `claude auth status` prints the login the CLI would use, as JSON. Claude Code
 * has no headless usage read, so this row can carry a plan and an address but
 * never a quota window.
 */
async function claudeMachineLogin(run: NonNullable<MachineLoginProbes["run"]>): Promise<MachineLogin> {
  const result = await run("claude", ["auth", "status"])
  if (!result.found) return report("claude", { state: "absent" })
  const status = parseJsonRecord(result.stdout)
  if (!status) {
    return report("claude", { state: "unknown", detail: "Claude Code did not answer with a login status." })
  }
  if (status.loggedIn !== true) return report("claude", { state: "signed_out" })
  const email = jsonText(status, "email")
  const plan = jsonText(status, "subscriptionType")
  const org = jsonText(status, "orgName")
  return report("claude", {
    state: "signed_in",
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(org ? { org } : {}),
  })
}

/** What `codex login status` prints when the CLI holds no login. */
const CODEX_SIGNED_OUT = /not logged in|no (?:stored )?(?:credentials|auth)/i

/**
 * The Codex app-server answers `account/read` and `account/rateLimits/read` for
 * the login the CLI holds. `codex login status` is the presence fallback: it
 * costs one cheap spawn and still separates "signed in" from "signed out" when
 * the app-server cannot be started at all.
 *
 * A non-zero exit is only a signed-out verdict when the CLI SAYS so. An old
 * build with no `login status` subcommand, a timeout, a transient fault — each
 * exits non-zero while the user is signed in, and telling them to run `codex
 * login` sends them to repair something that is not broken.
 */
async function codexMachineLogin(
  run: NonNullable<MachineLoginProbes["run"]>,
  account: NonNullable<MachineLoginProbes["codexAccount"]>,
): Promise<MachineLogin> {
  const presence = await run("codex", ["login", "status"])
  if (!presence.found) return report("codex", { state: "absent" })
  if (!presence.ok) {
    const said = `${presence.stdout}\n${presence.stderr ?? ""}`
    return CODEX_SIGNED_OUT.test(said)
      ? report("codex", { state: "signed_out" })
      : report("codex", { state: "unknown", detail: "Codex did not answer with a login status." })
  }

  const answer = await account().catch((error: unknown) => {
    log.warn("Codex app-server could not be asked about its account", { error: String(error) })
    return undefined
  })
  if (!answer) return report("codex", { state: "signed_in" })
  const chatgpt = jsonRecord(jsonRecord(answer.account)?.account)
  const email = chatgpt ? jsonText(chatgpt, "email") : undefined
  const plan = chatgpt ? jsonText(chatgpt, "planType") : undefined
  const usage = appServerUsageWindows(answer.rateLimits)
  return report("codex", {
    state: "signed_in",
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(usage.length ? { usage } : {}),
  })
}

/** `cursor-agent status --format json` answers from the CLI's own store. */
async function cursorMachineLogin(run: NonNullable<MachineLoginProbes["run"]>): Promise<MachineLogin> {
  const result = await run("cursor-agent", ["status", "--format", "json"])
  if (!result.found) return report("cursor", { state: "absent" })
  const status = parseJsonRecord(result.stdout)
  if (!status) {
    return report("cursor", { state: "unknown", detail: "Cursor did not answer with a login status." })
  }
  return report("cursor", { state: status.isAuthenticated === true ? "signed_in" : "signed_out" })
}

const CODEX_SESSION_WINDOW_MINUTES = 300
const CODEX_WEEKLY_WINDOW_MINUTES = 10_080

/**
 * `rateLimits.primary` / `secondary` as the Codex app-server spells them, which
 * is not how the ChatGPT HTTP usage read spells the same quota: camelCase keys,
 * `windowDurationMins` rather than `limit_window_seconds`. A window is
 * named by `windowDurationMins`, not by its slot: a plan that has only a weekly
 * limit delivers it in the primary slot. `resetsAt` is Unix seconds.
 */
function appServerUsageWindows(input: unknown): CredentialUsageWindow[] {
  const limits = jsonRecord(jsonRecord(input)?.rateLimits)
  return (["primary", "secondary"] as const).flatMap((slot) => {
    const window = jsonRecord(limits?.[slot])
    const used = jsonNumber(window?.usedPercent)
    if (!window || used === undefined) return []
    const minutes = jsonNumber(window.windowDurationMins)
    const name = minutes === CODEX_SESSION_WINDOW_MINUTES
      ? "session"
      : minutes === CODEX_WEEKLY_WINDOW_MINUTES
        ? "weekly"
        : slot
    const resetsAt = jsonNumber(window.resetsAt)
    return [{
      window: name,
      usedPercent: Math.min(100, Math.max(0, Math.round(used))),
      resetsAt: resetsAt === undefined ? null : resetsAt * 1000,
    }]
  })
}

/**
 * One `codex app-server` process, asked two questions and stopped.
 *
 * Deliberately not the session harness's app-server client: that one owns a
 * long-lived process with an observer, MCP servers and an incoming-request
 * handler, none of which a one-shot account read has any use for. The framing
 * is the protocol's own — one JSON object per line on stdin and stdout.
 */
async function codexAccountRead(): Promise<{ account: unknown; rateLimits: unknown }> {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] })
  const pending = new Map<number, (message: Record<string, unknown>) => void>()
  let sequence = 0
  let buffer = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    for (;;) {
      const boundary = buffer.indexOf("\n")
      if (boundary < 0) return
      const line = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 1)
      const message = line ? parseJsonRecord(line) : undefined
      if (!message) continue
      const id = jsonNumber(message.id)
      const resolve = id === undefined ? undefined : pending.get(id)
      if (id === undefined || !resolve) continue
      pending.delete(id)
      resolve(message)
    }
  })

  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    pending.set(id, (message) => {
      const failure = jsonRecord(message.error)
      if (failure) reject(new Error(jsonString(failure.message) ?? `codex app-server rejected ${method}`))
      else resolve(message.result)
    })
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })

  const failed = new Promise<never>((_, reject) => {
    child.on("error", (error) => reject(error))
    child.on("exit", (code, signal) => reject(new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`)))
  })
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error("codex app-server did not answer in time")), TIMEOUT_MS)
    timer.unref()
  })

  try {
    return await Promise.race([deadline, failed, (async () => {
      await request("initialize", {
        clientInfo: { name: "claxedo-machine-login", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
      const [account, rateLimits] = await Promise.all([
        request("account/read", {}),
        request("account/rateLimits/read", {}),
      ])
      return { account, rateLimits }
    })()])
  } finally {
    stopAppServer(child)
  }
}

const KILL_GRACE_MS = 1_000

/**
 * Ask the child to stop, then insist.
 *
 * The app-server owns MCP servers and plugin children of its own, and a build
 * that ignores SIGTERM would otherwise outlive every read the section makes —
 * one process per read, accumulating for as long as the app is open. Exported
 * because that escalation is the whole behaviour and a caller cannot observe it
 * through `readMachineLogins`.
 */
export function stopAppServer(child: ReturnType<typeof spawn>) {
  child.kill("SIGTERM")
  if (child.exitCode !== null || child.signalCode !== null) return
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }, KILL_GRACE_MS)
  timer.unref()
  child.once("exit", () => clearTimeout(timer))
}
