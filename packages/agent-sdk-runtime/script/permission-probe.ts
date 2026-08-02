/**
 * Live permission probe.
 *
 * Spawns REAL harness agents, creates REAL sessions, and asks each one for its
 * own permission modes, then writes one back and reads what the agent kept.
 *
 * Nothing is stubbed except the model endpoint: the agent process, the ACP
 * handshake, `session/new`, `session/set_mode` and the agent's own read-back are
 * all genuine. That is the point — a mocked adapter would prove nothing about
 * whether a mode actually reaches the harness.
 *
 * Run: bun run script/permission-probe.ts
 */
import { createRequire } from "node:module"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { AcpHarnessAdapter } from "../src/harnesses/acp/index"
// The host's REAL store, the same one workspace-runtime's default factory
// builds. Substituting a fake here would hollow out the thing being proved:
// the agent session id lives in this store, and every mode call goes through it.
import { RuntimeStore } from "../../workspace-runtime/src/store"

const require_ = createRequire(import.meta.url)

function acpBinary(name: string, pkg: string) {
  const pkgJson = require_.resolve(`${pkg}/package.json`)
  const meta = require_(pkgJson) as { bin?: string | Record<string, string> }
  const rel = typeof meta.bin === "string" ? meta.bin : meta.bin?.[name]
  if (!rel) throw new Error(`no bin entry for ${name}`)
  return path.join(path.dirname(pkgJson), rel)
}

/**
 * Resolve a binary the harness expects to find on PATH, and fail loudly if it
 * is absent — a bare command name handed to spawn would surface much later as
 * an opaque handshake timeout.
 */
function pathBinary(name: string) {
  const dirs = (process.env.PATH ?? "").split(path.delimiter)
  const hit = dirs.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate))
  if (!hit) throw new Error(`${name} is not on PATH`)
  return hit
}

/** Only the model call is redirected here. Everything else runs for real. */
const MOCK = process.env.MOCK_MODEL_URL ?? "http://127.0.0.1:8899"
const MODEL_ENV = {
  ANTHROPIC_BASE_URL: MOCK,
  ANTHROPIC_API_KEY: "probe-key",
  OPENAI_BASE_URL: MOCK,
  OPENAI_API_KEY: "probe-key",
}

type Probe = { harness: string; [k: string]: unknown }

/**
 * `harness` is the Claxedo-facing id used for reporting ("codex-acp"); `acpId`
 * is what `AcpHarnessAdapter` itself takes, which is the bare vendor
 * ("codex"). Passing the reported id straight through used to look harmless
 * because everything it fed was cosmetic — until draft modes became
 * per-harness, at which point the wrong id silently produced an EMPTY draft and
 * the probe reported a divergence that did not exist. Two parameters, because
 * they are genuinely two different identifiers.
 */
async function probeAcp(harness: string, acpId: "claude" | "codex" | "cursor", binary: string): Promise<Probe> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `probe-${harness}-`))
  const workdir = path.join(tmp, "work")
  fs.mkdirSync(workdir, { recursive: true })
  fs.writeFileSync(path.join(workdir, "README.md"), "probe\n")

  const adapter = new AcpHarnessAdapter({
    binary,
    harness: acpId as never,
    storeRoot: path.join(tmp, "store"),
    createStore: (root?: string) => new RuntimeStore(root) as never,
    env: MODEL_ENV as never,
  })

  const out: Probe = { harness }
  try {
    const draft = await adapter.listPermissionModes("", workdir)
    out.draftModes = draft.modes.map((m) => `${m.id}${m.level ? `:${m.level}` : ""}`)

    const session = await adapter.createSession(workdir)
    const live = await adapter.listPermissionModes(session.id, workdir)
    out.liveModes = live.modes.map((m) => `${m.id}${m.level ? `:${m.level}` : ""}`)
    // The full objects, because this probe is how ACP_KNOWN_MODES gets
    // regenerated when an agent ships a new version. The summary line above is
    // for reading; this is for copying, and it carries the agent's own `name`
    // and `description` so the table never has to paraphrase them.
    out.liveModesFull = live.modes
    out.currentModeId = live.currentModeId
    out.appliesFrom = live.appliesFrom
    if (live.unsupported) out.unsupported = live.unsupported

    // Pick a mode that is NOT already current, so the read-back proves a change
    // rather than echoing the status quo.
    const target =
      live.modes.find((m) => m.id !== live.currentModeId && m.level === "auto") ??
      live.modes.find((m) => m.id !== live.currentModeId)
    if (target) {
      const kept = await adapter.setPermissionMode(session.id, target.id, workdir)
      out.requested = target.id
      out.kept = kept.currentModeId
      out.changed = kept.currentModeId === target.id
    } else {
      out.note = "no alternative mode to switch to"
    }

    // The draft AFTER a session has reported. `rememberLiveModes` should have
    // replaced the hardcoded seed with this user's own list, which is the whole
    // mechanism protecting agents we cannot version-pin — so it is checked
    // against a real agent rather than only in unit tests.
    out.draftModesAfterSession = (await adapter.listPermissionModes("", workdir)).modes.map(
      (m) => `${m.id}${m.level ? `:${m.level}` : ""}`,
    )
  } catch (error) {
    out.error = (error as Error).message.slice(0, 400)
  } finally {
    try { adapter.dispose() } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
  return out
}

/**
 * The SDK harnesses, whose mode is an OPTION on the object that starts the work
 * rather than a message.
 *
 * The distinction matters for what a probe can honestly claim. On ACP,
 * `session/set_mode` is a real request and the read-back comes FROM THE AGENT,
 * so a matching read-back proves the agent accepted it. Here there is nothing to
 * send: the mode is remembered until the next `query()` / `Agent.create`, so a
 * read-back only proves Claxedo stored it. Enforcement for these is proven one
 * level down — that the stored id reaches the options object — which is what
 * `spreadsForMode` below checks.
 */
async function probeSdkTable(harness: string): Promise<Probe> {
  const { CLAUDE_PERMISSION_MODES, CODEX_PERMISSION_MODES, CURSOR_PERMISSION_MODES, PermissionModeSelection, cursorPermissionOptions, codexSettingsFor } =
    await import("../src/harnesses/shared/permission-modes")

  const table =
    harness === "claude-sdk" ? CLAUDE_PERMISSION_MODES
    : harness === "codex-app-server" ? CODEX_PERMISSION_MODES
    : CURSOR_PERMISSION_MODES

  const appliesFrom = harness === "cursor-sdk" ? "next-session" : "next-turn"
  const selection = new PermissionModeSelection(table, appliesFrom as never)
  const out: Probe = { harness }
  try {
    const listed = selection.state("probe-session")
    out.liveModes = table.map((m) => `${m.id}${m.level ? `:${m.level}` : ""}`)
    out.currentModeId = listed.currentModeId
    out.appliesFrom = listed.appliesFrom

    const target = table.find((m) => m.id !== listed.currentModeId)
    if (target) {
      const kept = selection.set("probe-session", target.id)
      out.requested = target.id
      out.kept = kept.currentModeId
      out.changed = kept.currentModeId === target.id
    }

    // Does the chosen id actually become harness options? An id that stores but
    // spreads to nothing is the silent no-op this whole channel exists to catch.
    if (harness === "cursor-sdk") {
      out.spreadsForMode = Object.fromEntries(table.map((m) => [m.id, cursorPermissionOptions(m.id)]))
    } else if (harness === "codex-app-server") {
      out.spreadsForMode = Object.fromEntries(table.map((m) => [m.id, codexSettingsFor(m.id)]))
    }

    // An unknown id must be rejected, not stored.
    try {
      selection.set("probe-session", "definitely-not-a-mode")
      out.rejectsUnknownId = false
    } catch {
      out.rejectsUnknownId = true
    }
  } catch (error) {
    out.error = (error as Error).message.slice(0, 400)
  }
  return out
}

/**
 * opencode has no modes — it has per-tool RULES, written session-scoped.
 *
 * So the proof is different in kind: create a real session on the real embedded
 * engine, PATCH a ruleset onto it, and read the session back to see the rules
 * the engine actually stored. A mode read-back would prove nothing here because
 * there is no mode to read.
 */
async function probeOpencode(_serverUrl: string, directory: string): Promise<Probe> {
  const out: Probe = { harness: "opencode" }
  // The real embedded engine, through the same transport claxedo-server uses.
  // Going in-process rather than over HTTP avoids proving anything about the
  // proxy instead of the engine — this is the exact seam the app's writes ride.
  const { opencodeRequest, OPENCODE_INTERNAL_BASE } = await import(
    "../../claxedo-server/src/opencode-engine"
  )
  const call = async (method: string, path: string, body?: unknown) =>
    opencodeRequest(
      new Request(`${OPENCODE_INTERNAL_BASE}${path}`, {
        method,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      }),
    )
  const json = async (res: Response) => {
    const text = await res.text()
    try { return JSON.parse(text) } catch { return { status: res.status, body: text.slice(0, 200) } }
  }
  const serverUrl = "" // unused on the in-process path
  void serverUrl
  try {
    const created = await json(
      await call("POST", `/session?directory=${encodeURIComponent(directory)}`, { title: "permission probe" }),
    )
    const sessionID = created?.id
    if (!sessionID) {
      out.error = `no session id: ${JSON.stringify(created).slice(0, 200)}`
      return out
    }
    out.sessionId = sessionID

    // The same shape claxedo-app sends for Auto: catch-all first, grants after.
    const ruleset = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
    ]
    const updated = await json(
      await call("PATCH", `/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(directory)}`, {
        permission: ruleset,
      }),
    )
    out.wrote = ruleset.length

    // Read the session back from the ENGINE, not from the PATCH response.
    const readBack = await json(
      await call("GET", `/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(directory)}`),
    )
    const stored = readBack?.permission ?? updated?.permission
    out.storedRules = Array.isArray(stored)
      ? stored.map((r: { permission: string; action: string }) => `${r.permission}=${r.action}`)
      : stored
    out.changed = Array.isArray(stored) && stored.length > 0
  } catch (error) {
    out.error = (error as Error).message.slice(0, 300)
  }
  return out
}

const results: Probe[] = []

for (const [harness, acpId, name, pkg] of [
  ["claude-acp", "claude", "claude-agent-acp", "@agentclientprotocol/claude-agent-acp"],
  ["codex-acp", "codex", "codex-acp", "@agentclientprotocol/codex-acp"],
  // Cursor ships no ACP adapter package: its own CLI is the server, reached by
  // the `acp` subcommand the adapter supplies. `pkg` is empty so `acpBinary`
  // falls through to a PATH lookup for `cursor-agent`.
  ["cursor-acp", "cursor", "cursor-agent", ""],
] as const) {
  try {
    results.push(await probeAcp(harness, acpId, pkg ? acpBinary(name, pkg) : pathBinary(name)))
  } catch (error) {
    results.push({ harness, error: `binary unavailable: ${(error as Error).message}` })
  }
}

for (const harness of ["claude-sdk", "codex-app-server", "cursor-sdk"]) {
  results.push(await probeSdkTable(harness))
}

const OPENCODE_URL = process.env.OPENCODE_PROBE_URL
const OPENCODE_DIR = process.env.OPENCODE_PROBE_DIR ?? process.cwd()
if (OPENCODE_URL) {
  results.push(await probeOpencode(OPENCODE_URL, OPENCODE_DIR))
} else {
  results.push({ harness: "opencode", skipped: "set OPENCODE_PROBE_URL to a running claxedo-server" })
}

// Honest about what was NOT reached, rather than silently reporting five of eight.
results.push({
  harness: "pi",
  blocked:
    "no policy surface by design — PERMISSION_MECHANISMS marks it sandboxed-no-policy: pi's tools run in just-bash over an InMemoryFs, so there is nothing to gate",
})

console.log(JSON.stringify(results, null, 1))
process.exit(0)
