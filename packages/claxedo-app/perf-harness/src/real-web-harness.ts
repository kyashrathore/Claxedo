import { createHash } from "node:crypto"
import { fork, spawn, type ChildProcess } from "node:child_process"
import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { agentAppViewport } from "./agent-display-contract"
import {
  installAgentBrowserObserver,
  measureSessionActivation,
  type SessionReadinessTarget,
} from "./agent-browser-observer"
import { materializeActualSessions, type ActualSessionMaterialization } from "./actual-session-materializer"
import { materializeClaxedoPublicCorpus } from "./public-corpus-materializer"

/**
 * The real-load web surface, as a reusable environment.
 *
 * "Real load" means every layer under the browser is the shipped one: the
 * packaged desktop server process with the embedded OpenCode engine, a
 * production Vite build of the local product served over HTTP, and the
 * canonical benchmark corpus materialized into that server's data directory.
 * The synthetic fixture this replaced could stub routes; nothing here can,
 * which is the whole point — it is what makes cold-path numbers trustworthy.
 *
 * It lives apart from any one runner because two different questions are asked
 * of the same environment: `real-web-public-session-switch.ts` asks *how long*
 * a session switch takes, and `real-web-switch-profile.ts` asks *where that time
 * goes*. Those must observe an identical surface or the second cannot explain
 * the first, and a copied 400-line setup would stop being identical the first
 * time either side was touched.
 */

export type CorpusManifest = {
  corpusId: string
  corpusDigestSha256: string
  definitionDigestSha256: string
  seed: string
  sourceEventFormat: { schemaDigestSha256: string }
}

export type RealWebTarget = SessionReadinessTarget & {
  logicalSessionId: string
  /** Actual-session raw latest-turn contract; retained in memory and excluded from artifacts. */
  eventualFullPartIds?: readonly string[]
}

export type RealWebTargets = ReadonlyMap<string, RealWebTarget>

export type RealWebHarness = {
  page: Page
  context: BrowserContext
  targets: RealWebTargets
  manifest: CorpusManifest
  materialization: Awaited<ReturnType<typeof materializeClaxedoPublicCorpus>> | ActualSessionMaterialization
  loadKind: "public-corpus" | "actual-session"
  sourceCommit: string
  artifacts: {
    workingTreeSha256: string
    appAsarSha256: string
    embeddedEngineSha256: string
    buildContractSha256: string
    rendererBuildSha256: string
  }
  previewUrl: string
  backendUrl: string
  buildDirectory: string
  currentWorkingTreeDigest: () => Promise<string>
  requireTarget: (logicalSessionId: string) => RealWebTarget
  requireActivation: (target: SessionReadinessTarget, phase: string) => Promise<void>
  close: () => Promise<void>
}

export type RealWebHarnessOptions = {
  outputDirectory: string
  /** A read-only OpenCode database used only to build an ephemeral anonymized load slice. */
  actualSessionDatabasePath?: string
  /**
   * Emit and serve build sourcemaps. Off for latency runs — a `//# sourceMappingURL`
   * comment is one extra line the engine parses and the map is never fetched, but
   * "off unless asked" keeps the latency artifact byte-identical to what ships.
   */
  sourcemap?: boolean
  /**
   * Arm the app's own `measureRendererPhase` instrumentation.
   *
   * A sampled profile says which FUNCTION ran; these say which named PHASE of
   * the app's own session-open sequence it ran in, unsampled. Off for latency
   * runs because the wrapper takes two `performance.now()` readings per phase
   * once armed.
   */
  rendererTrace?: boolean
}

export type RendererPhase = { name: string; durationMs: number }

declare global {
  interface Window {
    /** Armed by {@link startRealWebHarness} when `rendererTrace` is set. */
    __claxedoPerfTrace?: boolean
    /** Pre-created here so the app's tracer has somewhere to push. */
    __claxedoPerfRendererPhases?: RendererPhase[]
  }
}

export const repoRoot = path.resolve(import.meta.dir, "../../../..")

export function benchmarkRoot() {
  return process.env.AGENT_APP_BENCHMARK_ROOT?.trim()
    ? path.resolve(process.env.AGENT_APP_BENCHMARK_ROOT)
    : path.resolve(repoRoot, "../agent-app-benchmark")
}

export function corpusDirectory() {
  return process.env.CLAXEDO_REAL_WEB_CORPUS?.trim()
    ? path.resolve(process.env.CLAXEDO_REAL_WEB_CORPUS)
    : path.join(benchmarkRoot(), "artifacts/corpora/opencode-completed-sessions-v3")
}

export async function startRealWebHarness(options: RealWebHarnessOptions): Promise<RealWebHarness> {
  const appDir = path.join(repoRoot, "packages/claxedo-app")
  const desktopApp = path.join(repoRoot, "packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app")
  const executable = path.join(desktopApp, "Contents/MacOS/Claxedo Dev")
  const resources = path.join(desktopApp, "Contents/Resources")
  const serverEntry = path.join(resources, "app.asar/out/main/claxedo-server/index.js")
  const engineEntry = path.join(resources, "opencode-engine/node.js")
  const appAsar = path.join(resources, "app.asar")
  const buildContract = path.join(repoRoot, "packages/claxedo-desktop/dist/.build-contract.json")
  const buildDirectory = path.join(options.outputDirectory, "web-build")
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "claxedo-real-web-benchmark-"))
  const stateRoot = path.join(scratchRoot, "state")
  const dataDirectory = path.join(stateRoot, "data")
  const workspaceDirectory = path.join(stateRoot, "workspaces")
  const ambientDirectory = path.join(stateRoot, "ambient")
  const corpus = options.actualSessionDatabasePath ? undefined : corpusDirectory()
  const manifestPath = corpus ? path.join(corpus, "manifest.json") : undefined
  let manifest = manifestPath
    ? JSON.parse(await readFile(manifestPath, "utf8")) as CorpusManifest
    : undefined
  const sourceCommit = (await commandOutput("git", ["rev-parse", "HEAD"], repoRoot)).trim()
  const [workingTreeSha256, appAsarSha256, embeddedEngineSha256, buildContractSha256] = await Promise.all([
    workingTreeDigest(sourceCommit),
    hashFile(appAsar),
    hashFile(engineEntry),
    hashFile(buildContract),
  ])
  const [backendPort, previewPort] = await Promise.all([availablePort(), availablePort()])
  const backendUrl = `http://127.0.0.1:${backendPort}`
  const previewUrl = `http://127.0.0.1:${previewPort}/index.local.html`

  await Promise.all([
    mkdir(options.outputDirectory, { recursive: true }),
    mkdir(dataDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
    mkdir(path.join(stateRoot, "profile"), { recursive: true }),
    mkdir(ambientDirectory, { recursive: true }),
  ])

  let server: ChildProcess | undefined
  let preview: ChildProcess | undefined
  let browser: Browser | undefined
  let serverLog = ""
  let previewLog = ""

  const close = async () => {
    await browser?.close().catch(() => undefined)
    await stopChild(preview)
    await stopChild(server)
    await rm(scratchRoot, { recursive: true, force: true })
  }

  try {
    const materialization = options.actualSessionDatabasePath
      ? await materializeActualSessions({
          sourceDatabasePath: options.actualSessionDatabasePath,
          dataDirectory,
          workspaceDirectory,
        })
      : await materializeClaxedoPublicCorpus({
          corpusDirectory: corpus!,
          corpusManifestPath: manifestPath!,
          expectedCorpusDigestSha256: manifest!.corpusDigestSha256,
          expectedEventSchemaDigestSha256: manifest!.sourceEventFormat.schemaDigestSha256,
          dataDirectory,
          workspaceDirectory,
        })
    manifest ??= {
      corpusId: "private-actual-session-load-v1",
      corpusDigestSha256: materialization.corpusDigestSha256,
      definitionDigestSha256: materialization.mappingDigestSha256,
      seed: "private-actual-session-load-v1",
      sourceEventFormat: { schemaDigestSha256: materialization.eventSchemaDigestSha256 },
    }

    await runChild(
      "node",
      [
        "./node_modules/vite/bin/vite.js",
        "build",
        "--config",
        "vite.local.config.ts",
        "--outDir",
        buildDirectory,
        ...(options.sourcemap ? ["--sourcemap"] : []),
      ],
      appDir,
      {
        ...process.env,
        VITE_CLAXEDO_SERVER_URL: backendUrl,
        VITE_OPENCODE_BACKEND_URL: backendUrl,
        VITE_AUTH_ENABLED: "false",
      },
    )
    const rendererBuildSha256 = await hashDirectory(buildDirectory)

    server = fork(serverEntry, [], {
      execPath: executable,
      execArgv: ["--expose-gc", "--optimize-for-size", "--max-old-space-size=512"],
      env: {
        ...process.env,
        HOME: ambientDirectory,
        XDG_CONFIG_HOME: path.join(ambientDirectory, "config"),
        XDG_CACHE_HOME: path.join(ambientDirectory, "cache"),
        ELECTRON_RUN_AS_NODE: "1",
        CLAXEDO_CHILD_PORT: String(backendPort),
        CLAXEDO_DESKTOP_PARENT_PID: String(process.pid),
        CLAXEDO_DATA_DIR: dataDirectory,
        CLAXEDO_CHILD_OPENCODE_EMBED_PATH: engineEntry,
        CLAXEDO_CHILD_OPENCODE_COMPILE_CACHE_DIR: path.join(resources, "opencode-compile-cache"),
        CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR: path.join(resources, "claxedo-server-compile-cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        GOMAXPROCS: "2",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    server.stdout?.on("data", (chunk) => { serverLog += chunk.toString() })
    server.stderr?.on("data", (chunk) => { serverLog += chunk.toString() })
    await waitForHealth(`${backendUrl}/api/claxedo/health`, () => serverLog)

    preview = spawn(
      "node",
      [
        "./node_modules/vite/bin/vite.js",
        "preview",
        "--config",
        "vite.local.config.ts",
        "--outDir",
        buildDirectory,
        "--port",
        String(previewPort),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: appDir, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    )
    preview.stdout?.on("data", (chunk) => { previewLog += chunk.toString() })
    preview.stderr?.on("data", (chunk) => { previewLog += chunk.toString() })
    await waitForHealth(previewUrl, () => previewLog)

    browser = await chromium.launch({
      headless: true,
      args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
    })
    const context = await browser.newContext({ viewport: agentAppViewport() })
    const page = await context.newPage()
    const workspaceA = path.join(workspaceDirectory, "workspace-a")
    const workspaceB = path.join(workspaceDirectory, "workspace-b")
    if (options.rendererTrace) {
      await page.addInitScript(() => {
        window.__claxedoPerfTrace = true
        window.__claxedoPerfRendererPhases = []
      })
    }
    await page.addInitScript(
      ({ serverUrl, directories }) => {
        const state = window as typeof window & {
          __OPENCODE__?: { serverUrl: string; activeDirectory: string }
        }
        state.__OPENCODE__ = { serverUrl, activeDirectory: directories[0]! }
        localStorage.clear()
        localStorage.setItem(
          "opencode.global.dat:server",
          JSON.stringify({
            list: [],
            projects: { local: directories.map((worktree) => ({ worktree, expanded: true })) },
            lastProject: {},
            workspaceServer: {},
            closedProjects: {},
          }),
        )
      },
      { serverUrl: backendUrl, directories: [workspaceA, workspaceB] },
    )
    await installAgentBrowserObserver(page as never)
    await page.goto(previewUrl, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      (ids) => ids.some((id) => document.querySelector(`[data-testid="rail-sidebar-session-row"][data-session-id="${CSS.escape(id)}"]`)),
      [...materialization.readinessTargets.values()].map((target) => target.sessionId),
      { timeout: 120_000 },
    )

    const targets = materialization.readinessTargets
    const requireTarget = (logicalSessionId: string) => {
      const target = targets.get(logicalSessionId)
      if (!target) throw new Error(`missing canonical target ${logicalSessionId}`)
      return target
    }
    const requireActivation = async (target: SessionReadinessTarget, phase: string) => {
      const ready = () => page.evaluate((sessionId) => {
        const root = document.querySelector<HTMLElement>(
          `[data-testid="session-page-root"][data-session-id="${CSS.escape(sessionId)}"]`,
        )
        const surface = root?.closest<HTMLElement>("[data-workbench-content]")
        return !!root && !!surface &&
          surface.getAttribute("aria-hidden") !== "true" && !surface.hasAttribute("inert") &&
          root.dataset.sessionFirstFoldReady === "true" && root.dataset.sessionMessagesReady === "true"
      }, target.sessionId)
      if (await ready()) return
      const result = await measureSessionActivation(page as never, target)
      // The preview may finish loading its initially selected control session
      // between the readiness probe above and the trusted setup click. In that
      // setup-only race the semantic observer can see two stable frames before
      // pointerdown, so the duration clock correctly rejects the timestamp.
      // Accept only the now-canonical ready state; measured switches always
      // begin from an explicitly activated control session and keep the strict
      // timestamp contract.
      if (result.state === "invalid" && result.reason === "invalid-paint-timestamp" && await ready()) return
      if (result.state !== "exact") throw new Error(`${phase} activation failed: ${result.reason}`)
    }

    await requireActivation(requireTarget("control"), "control")

    return {
      page,
      context,
      targets,
      manifest,
      materialization,
      loadKind: options.actualSessionDatabasePath ? "actual-session" : "public-corpus",
      sourceCommit,
      artifacts: { workingTreeSha256, appAsarSha256, embeddedEngineSha256, buildContractSha256, rendererBuildSha256 },
      previewUrl,
      backendUrl,
      buildDirectory,
      currentWorkingTreeDigest: () => workingTreeDigest(sourceCommit),
      requireTarget,
      requireActivation,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

export type Lane = {
  id: "within-workspace-cold" | "within-workspace-warm" | "across-workspaces-cold" | "across-workspaces-warm"
  workspaceRelation: "within-workspace" | "across-workspaces"
  sessionState: "cold" | "warm"
}

export type BenchmarkCase = Lane & {
  caseId: string
  destinationSessionId: string
  sample: number
}

export const LANES: readonly Lane[] = [
  { id: "within-workspace-cold", workspaceRelation: "within-workspace", sessionState: "cold" },
  { id: "within-workspace-warm", workspaceRelation: "within-workspace", sessionState: "warm" },
  { id: "across-workspaces-cold", workspaceRelation: "across-workspaces", sessionState: "cold" },
  { id: "across-workspaces-warm", workspaceRelation: "across-workspaces", sessionState: "warm" },
]

export function latencyCases(seed: string, lanes: readonly Lane[] = LANES): BenchmarkCase[] {
  const values = lanes.flatMap((lane) => Array.from({ length: 10 }, (_, sample) => ({
    ...lane,
    sample,
    caseId: `isolated-latency-0-${lane.id}-1048576-${sample}`,
    destinationSessionId: `latency-${lane.id}-${sample}-1048576`,
  })))
  return values.toSorted(
    (left, right) =>
      score(`${seed}|standard-cases|0`, left.caseId) - score(`${seed}|standard-cases|0`, right.caseId),
  )
}

function score(seed: string, identity: string) {
  return Number.parseInt(createHash("sha256").update(`${seed}|${identity}`).digest("hex").slice(0, 12), 16)
}

async function waitForHealth(url: string, log: () => string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(3_000) }).then((response) => response.ok).catch(() => false)
    if (ok) return
    await Bun.sleep(200)
  }
  throw new Error(`service did not become healthy at ${url}:\n${log().split("\n").slice(-80).join("\n")}`)
}

async function runChild(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout?.on("data", (chunk) => { output += chunk.toString() })
  child.stderr?.on("data", (chunk) => { output += chunk.toString() })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve)
    child.once("error", reject)
  })
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${String(code)}:\n${output}`)
}

async function commandOutput(command: string, args: string[], cwd: string) {
  const child = Bun.spawn({ cmd: [command, ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command} failed: ${stderr}`)
  return stdout
}

async function workingTreeDigest(sourceCommit: string) {
  const [trackedDiff, untrackedOutput] = await Promise.all([
    commandOutput("git", ["diff", "--binary", "HEAD"], repoRoot),
    commandOutput("git", ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot),
  ])
  const hash = createHash("sha256")
  hash.update(sourceCommit).update("\0tracked\0").update(trackedDiff).update("\0untracked\0")
  const untracked = untrackedOutput.split("\0").filter(Boolean).toSorted()
  for (const relativePath of untracked) {
    hash.update(relativePath).update("\0")
    for await (const chunk of createReadStream(path.join(repoRoot, relativePath))) hash.update(chunk)
    hash.update("\0")
  }
  return hash.digest("hex")
}

async function hashFile(filePath: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest("hex")
}

async function hashDirectory(directory: string) {
  const hash = createHash("sha256")
  const visit = async (relativeDirectory: string) => {
    const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true })
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(relativePath)
        continue
      }
      if (!entry.isFile()) throw new Error(`renderer build contains unsupported entry: ${relativePath}`)
      hash.update(relativePath).update("\0")
      for await (const chunk of createReadStream(path.join(directory, relativePath))) hash.update(chunk)
      hash.update("\0")
    }
  }
  await visit("")
  return hash.digest("hex")
}

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("failed to allocate benchmark port")
  return address.port
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    Bun.sleep(5_000),
  ])
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL")
}
