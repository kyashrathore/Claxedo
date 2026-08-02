/**
 * W0 probe: does each REAL harness path complete a turn against the scripted
 * model server? Run manually (never in CI — CI trusts the Tier R specs, which
 * subsume this): from packages/claxedo-app,
 *
 *   bun run e2e/helpers/scripted-model-server.probe.ts            # all legs
 *   ONLY=claude bun run e2e/helpers/scripted-model-server.probe.ts
 *   ONLY=codex  ...   ONLY=engine ...
 *
 * Three legs, one per injection seam:
 *   engine — spawns the real packages/opencode engine with
 *     OPENCODE_CONFIG_CONTENT carrying the scripted provider, creates a
 *     session, prompts, and asserts the marker text lands in the transcript.
 *   claude — drives the real `claude` binary through AcpHarnessAdapter with
 *     ANTHROPIC_BASE_URL pointed here (enforcement-probe's exact mechanism).
 *   codex — same adapter, `-c model_providers.*` overrides → CODEX_CONFIG.
 *
 * Each leg prints PASS/FAIL plus the scripted server's per-dialect counts, so
 * a leg that "passed" without ever calling the model is visibly not evidence
 * (the enforcement-probe lesson).
 */
import { spawn, type ChildProcess } from "node:child_process"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  claudeScriptedEnv,
  codexScriptedConfigJson,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "./scripted-model-server"

const execFileAsync = promisify(execFile)
const repository = path.resolve(import.meta.dirname, "../../../..")
const only = process.env.ONLY

async function main() {
  const scripted = await startScriptedModelServer()
  console.log(`scripted model server: ${scripted.url}`)
  const results: Array<{ leg: string; ok: boolean; detail: string }> = []

  for (const leg of ["engine", "claude", "codex"] as const) {
    if (only && only !== leg) continue
    scripted.resetCounts()
    try {
      const detail = await LEGS[leg](scripted)
      const counts = scripted.counts()
      const total = counts.chat + counts.messages + counts.responses
      if (total === 0) {
        results.push({ leg, ok: false, detail: `no model calls reached the scripted server (inconclusive) — ${detail}` })
      } else {
        results.push({ leg, ok: true, detail: `${detail} [calls: chat=${counts.chat} messages=${counts.messages} responses=${counts.responses}]` })
      }
    } catch (error) {
      results.push({ leg, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  await scripted.close()
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.leg}: ${result.detail}`)
  process.exit(results.every((result) => result.ok) ? 0 : 1)
}

const LEGS: Record<string, (scripted: ScriptedModelServer) => Promise<string>> = {
  engine: probeEngine,
  claude: (scripted) => probeAcp("claude", scripted),
  codex: (scripted) => probeAcp("codex", scripted),
}

async function probeEngine(scripted: ScriptedModelServer) {
  const marker = `TIER-REAL-PROBE-${Date.now() % 1_000_000}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-real-probe-engine-"))
  const workdir = fs.realpathSync(dir)
  await execFileAsync("git", ["init"], { cwd: workdir })
  const port = 40000 + Math.floor((Date.now() % 10_000))
  const config = opencodeScriptedProviderConfig(scripted.v1Url)

  const engine: ChildProcess = spawn(
    "bun",
    ["run", "--conditions=browser", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: path.join(repository, "packages/opencode"),
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        TIER_REAL_API_KEY: "test-key",
        XDG_CACHE_HOME: path.join(workdir, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(workdir, "xdg-config"),
        XDG_DATA_HOME: path.join(workdir, "xdg-data"),
        OPENCODE_DISABLE_AUTOSHARE: "true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let log = ""
  engine.stdout?.on("data", (chunk) => (log += chunk.toString()))
  engine.stderr?.on("data", (chunk) => (log += chunk.toString()))

  try {
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 120_000
    for (;;) {
      // Bound every probe: the engine binds its socket before routes wire, and
      // an untimed fetch hangs forever in that window.
      const health = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined)
      if (health?.ok) break
      if (Date.now() > deadline) throw new Error(`engine never became healthy\n${log.slice(-2000)}`)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    const headers = { "content-type": "application/json", "x-opencode-directory": workdir }
    const created = await fetch(`${base}/session`, { method: "POST", headers, body: JSON.stringify({}) })
    if (!created.ok) throw new Error(`session create ${created.status}: ${await created.text()}`)
    const session = (await created.json()) as { id: string }

    const prompted = await fetch(`${base}/session/${session.id}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: { providerID: "tier-real", modelID: "scripted-model" },
        parts: [{ type: "text", text: `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}` }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!prompted.ok) throw new Error(`prompt ${prompted.status}: ${await prompted.text()}`)
    const reply = JSON.stringify(await prompted.json())
    if (!reply.includes(marker)) throw new Error(`marker ${marker} missing from reply: ${reply.slice(0, 500)}`)
    return `engine turn completed, marker echoed`
  } finally {
    engine.kill("SIGKILL")
    fs.rmSync(workdir, { recursive: true, force: true })
  }
}

async function probeAcp(harness: "claude" | "codex", scripted: ScriptedModelServer) {
  // The ACP adapter speaks the Agent Client Protocol, so the binary is the ACP
  // wrapper package (claude-agent-acp / codex-acp), NOT the raw CLI — same
  // resolution enforcement-probe uses. The wrapper spawns the real CLI itself.
  const { defaultAcpBinary } = await import(
    path.join(repository, "packages/agent-sdk-runtime/src/harnesses/acp/default-binaries.ts")
  )
  const binary = defaultAcpBinary(harness === "claude" ? "claude-agent-acp" : "codex-acp")
  if (!binary || binary === "claude-agent-acp" || binary === "codex-acp") {
    const onPath = await which(binary)
    if (!onPath) throw new Error(`${harness} ACP wrapper binary not resolvable — bun install first`)
  }
  const marker = `TIER-REAL-PROBE-${harness}-${Date.now() % 1_000_000}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `tier-real-probe-${harness}-`))
  const workdir = path.join(tmp, "work")
  fs.mkdirSync(workdir, { recursive: true })
  fs.writeFileSync(path.join(workdir, "README.md"), "probe\n")

  const { AcpHarnessAdapter } = await import(path.join(repository, "packages/agent-sdk-runtime/src/harnesses/acp/index.ts"))
  const { RuntimeStore } = await import(path.join(repository, "packages/workspace-runtime/src/store.ts"))

  const adapter = new AcpHarnessAdapter({
    binary,
    harness,
    storeRoot: path.join(tmp, "store"),
    createStore: (root?: string) => new RuntimeStore(root) as never,
    ...(harness === "codex"
      ? {
          args: [
            "-c", "model_provider=scripted",
            "-c", 'model_providers.scripted.name="scripted"',
            "-c", `model_providers.scripted.base_url="${scripted.v1Url}"`,
            "-c", 'model_providers.scripted.wire_api="responses"',
            "-c", 'model_providers.scripted.env_key="OPENAI_API_KEY"',
            "-c", "model_providers.scripted.requires_openai_auth=false",
          ],
          env: { OPENAI_API_KEY: "test-key", CODEX_CONFIG: codexScriptedConfigJson(scripted.v1Url) } as never,
        }
      : {
          env: { ...claudeScriptedEnv(scripted.url, path.join(tmp, "claude-config")), OPENAI_API_KEY: "test-key" } as never,
        }),
  })

  try {
    const session = await adapter.createSession(workdir)
    const events: unknown[] = []
    const iterator = adapter.sendMessage(
      session.id,
      {
        parts: [{ type: "text", text: `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}` }],
        model: { providerID: harness, modelID: "scripted-model" },
        agent: "tier-real-probe",
      } as never,
      workdir,
    )
    await Promise.race([
      (async () => {
        for await (const event of iterator) events.push(event)
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`turn did not finish within 60s (${events.length} events)`)), 60_000)),
    ])
    const transcript = JSON.stringify(events)
    if (!transcript.includes(marker)) throw new Error(`marker missing from ${events.length} events: ${transcript.slice(0, 500)}`)
    return `${harness} turn completed, marker echoed`
  } finally {
    adapter.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function which(name: string) {
  try {
    const { stdout } = await execFileAsync("which", [name])
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

await main()
