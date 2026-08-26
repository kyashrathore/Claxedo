import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { installAgentBrowserObserver, measureSessionActivation, type PaintedMessage, type SessionReadinessTarget } from "./agent-browser-observer";
import { processFamily, readProcessTable, sameProcessIdentity, type ProcessSnapshot } from "./agent-process-family";
import { connectCdpPage, type BenchmarkPage } from "./agent-cdp-page";
import { AGENT_APP_WINDOW } from "./agent-display-contract";
import { writeJson } from "./storage";

export type OwnedProcess = {
  pid: number;
  startTimeMs: number;
  owner: "application" | "harness";
  category: string;
};

export type ClaxedoLaunch = {
  application: Bun.Subprocess;
  page: BenchmarkPage;
  serverUrl: string;
  process: OwnedProcess;
  coldReady: {
    startTimestamp: number;
    endTimestamp: number;
    durationMs: number;
    resolutionMs: number;
    trustedInputAccepted: boolean;
    reloadCount: number;
    crashCount: number;
    semantic: PaintedMessage;
  };
  inspect(): Promise<{
    surface: { visibilityState: string; focused: boolean; hidden: boolean; viewport: { width: number; height: number } };
    processes: ProcessSnapshot[];
  }>;
  shutdown(): Promise<{
    terminated: OwnedProcess[];
    survivors: OwnedProcess[];
    forced: OwnedProcess[];
  }>;
};

// Cold-ready critical-path diagnostics. HARNESS-ONLY — never ships.
//
// PRODUCERS, named because this reads marks WHOLESALE via
// `performance.getEntriesByType("mark")` and therefore cannot fail when one
// disappears: app/entry/app.tsx (diag.entry.*, diag.persister.*, diag.chain.*,
// diag.connectionGate.*, diag.appShellHost.*, diag.runtimeProviders.*),
// providers/global-sync/provider.tsx (diag.globalSync.*),
// providers/global-sync/shell-bootstrap.ts (diag.shellBootstrap.*),
// workbench/rail/rail-sidebar.tsx (diag.rail.*),
// features/session/data/query/session-list.ts (diag.sessionList.*),
// platform/query/persister.ts (diag.persister.*).
// Deleting a mark on the product side silently blinds this dump. The coupling is
// invisible in both directions, which is why it is written down at both ends.
let coldReadyDiagnosticsSerial = 0;

/**
 * Cold-boot startup clock. HARNESS-ONLY, and OFF by default.
 *
 * The one quantity cold-boot reasoning could not obtain: the LEAD, from the
 * instant the local server can serve a request to the instant the renderer
 * issues the first engine-bound one. It was unobtainable for a structural
 * reason rather than an oversight — the two events live in different processes,
 * the renderer's clock is `performance.timeOrigin`-relative, the server's own
 * log line is formatted to whole seconds, and this launcher DISCARDS the
 * application's stdio (`drain`), so nothing the child said ever survived.
 *
 * With `CLAXEDO_BENCH_STARTUP_CLOCK=1` the app is asked to append epoch-
 * millisecond stamps for that handoff (`shared/startup-clock-probe.ts` in
 * @claxedo/desktop) to a file this run owns, and the application's stdio is
 * kept instead of dropped. Every number recorded before this existed keeps its
 * meaning because the default run is byte-identical to what it always was: no
 * extra env var reaches the app, and stdio is drained exactly as before.
 */
export function startupClockEnabled() {
  return process.env.CLAXEDO_BENCH_STARTUP_CLOCK === "1";
}

type StartupClockEvent = {
  event: string;
  epochMs: number;
  pid: number;
  processStartEpochMs: number;
  detail?: Record<string, number | string | boolean>;
};

/**
 * The subtraction the candidate turns on, done once and written down, so a
 * reader is never left to re-derive it from two files on two clocks.
 *
 * `firstRequest`/`firstProviderRequest` are renderer-clock resource starts
 * lifted onto wall clock through `timeOrigin`; `serverListening` is the server
 * child's own stamp at the listen callback. Their difference IS the lead, and
 * it is the ceiling on anything a server-side prewarm can recover.
 */
export function startupClockLead(input: {
  events: readonly StartupClockEvent[];
  timeOrigin: number;
  resources: readonly { name: string; startTime: number }[];
}) {
  const at = (event: string) => input.events.find((entry) => entry.event === event)?.epochMs;
  const serverListening = at("server-listening");
  const isProvider = (name: string) => {
    try {
      return new URL(name).pathname === "/provider";
    } catch {
      return false;
    }
  };
  const earliest = (predicate: (name: string) => boolean) => {
    const starts = input.resources.filter((entry) => predicate(entry.name)).map((entry) => entry.startTime);
    return starts.length ? input.timeOrigin + Math.min(...starts) : undefined;
  };
  const firstRequest = earliest(() => true);
  const firstProviderRequest = earliest(isProvider);
  const lead = (arrival: number | undefined) =>
    serverListening !== undefined && arrival !== undefined ? arrival - serverListening : undefined;
  return {
    serverProcessStartEpochMs: input.events.find((entry) => entry.event === "server-listening")?.processStartEpochMs,
    serverListeningEpochMs: serverListening,
    mainReadyMessageEpochMs: at("main-server-ready-message"),
    mainHealthVerifiedEpochMs: at("main-server-health-verified"),
    mainReadyPublishedEpochMs: at("main-server-ready-published"),
    rendererTimeOriginEpochMs: input.timeOrigin,
    firstRequestEpochMs: firstRequest,
    firstProviderRequestEpochMs: firstProviderRequest,
    /** Wall-clock ms the server spends able to serve while nothing has asked it for engine work. */
    leadToFirstRequestMs: lead(firstRequest),
    leadToFirstProviderRequestMs: lead(firstProviderRequest),
  };
}

export function parseStartupClockLog(contents: string): StartupClockEvent[] {
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<StartupClockEvent>;
        return typeof parsed.event === "string" && typeof parsed.epochMs === "number"
          ? [parsed as StartupClockEvent]
          : [];
      } catch {
        return [];
      }
    });
}

export function startupClockPath(runDirectory: string) {
  return path.join(runDirectory, "startup-clock.jsonl");
}

async function captureStartupClock(runDirectory: string, snapshot: {
  timeOrigin: number;
  resources: readonly { name: string; startTime: number }[];
}) {
  if (!startupClockEnabled()) return;
  const events = parseStartupClockLog(await readFile(startupClockPath(runDirectory), "utf8"));
  await writeJson(path.join(runDirectory, "startup-clock-lead.json"), {
    ...startupClockLead({ events, ...snapshot }),
    events,
  });
}

async function captureColdReadyDiagnostics(input: {
  page: BenchmarkPage;
  runDirectory: string;
  serial: number;
  phase: string;
  coldReadyMs: number;
}) {
  const snapshot = await input.page.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    now: performance.now(),
    marks: performance
      .getEntriesByType("mark")
      .map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
        detail: (entry as PerformanceMark).detail ?? null,
      })),
    paints: performance
      .getEntriesByType("paint")
      .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
    navigation: performance.getEntriesByType("navigation").map((entry) => {
      const nav = entry as PerformanceNavigationTiming;
      return {
        startTime: nav.startTime,
        fetchStart: nav.fetchStart,
        responseEnd: nav.responseEnd,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        loadEventEnd: nav.loadEventEnd,
        duration: nav.duration,
      };
    }),
    resources: performance.getEntriesByType("resource").map((entry) => {
      const res = entry as PerformanceResourceTiming;
      return {
        name: res.name,
        initiatorType: res.initiatorType,
        startTime: res.startTime,
        requestStart: res.requestStart,
        responseStart: res.responseStart,
        responseEnd: res.responseEnd,
        duration: res.duration,
        transferSize: res.transferSize,
        decodedBodySize: res.decodedBodySize,
      };
    }),
  }));
  const file = path.join(
    input.runDirectory,
    `cold-ready-diagnostics-${String(input.serial).padStart(3, "0")}-${input.phase}.json`,
  );
  await writeJson(file, {
    serial: input.serial,
    phase: input.phase,
    coldReadyMs: input.coldReadyMs,
    ...snapshot,
  });
  // Best-effort and last: the renderer dump is the load-bearing artifact, and a
  // missing startup clock must not cost it.
  try {
    await captureStartupClock(input.runDirectory, snapshot);
  } catch {}
  return file;
}

/**
 * The embedded OpenCode engine reads a GLOBAL config from the operator's home
 * directory, and that config can install third-party plugins. Measured: one such
 * plugin (`opencode-antigravity-auth`) awaits an uncached network fetch with a
 * 5,000 ms timeout inside `plugin.init()`, which `InstanceContextMiddleware`
 * awaits before the `/provider` handler runs — 366-395 ms on the binding
 * constraint of `app.cold_ready_ms`, from a package this product does not own.
 *
 * The harness already isolates the desktop profile, the data directory and the
 * corpus. It did not isolate this. Runs therefore measured whichever plugins the
 * operator happened to have installed, and could reach the network.
 *
 * OFF BY DEFAULT so every number recorded before this existed keeps its meaning.
 * Set `CLAXEDO_BENCH_ISOLATE_AMBIENT=1` to pin the ambient environment to an
 * empty directory under the run's own isolated profile. `provenance.json` records
 * which mode produced a number, because the difference between the two arms is
 * itself a finding rather than a detail.
 */
export function ambientIsolationEnv(isolatedProfilePath: string): Record<string, string> {
  if (process.env.CLAXEDO_BENCH_ISOLATE_AMBIENT !== "1") return {}
  const root = path.join(isolatedProfilePath, "ambient")
  return { XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"), HOME: root }
}

export function ambientIsolationMode(): "isolated" | "operator-ambient" {
  return process.env.CLAXEDO_BENCH_ISOLATE_AMBIENT === "1" ? "isolated" : "operator-ambient"
}

/**
 * The startup-clock request, expressed the only way a launcher can express one:
 * as an environment the packaged app inherits. Empty unless asked for, so the
 * default run hands the app exactly the environment it always did.
 */
export function startupClockEnv(runDirectory: string): Record<string, string> {
  if (!startupClockEnabled()) return {}
  return { CLAXEDO_DIAG_STARTUP_CLOCK: startupClockPath(runDirectory) }
}

export async function launchPackagedClaxedo(input: {
  executable: string;
  isolatedProfilePath: string;
  dataDirectory: string;
  readinessTargets: readonly SessionReadinessTarget[];
  timeoutMs?: number;
  /** Composition overrides for special arms (e.g. OPENCODE_URL for the
   * fake-engine stream profile). Applied last, so they win. */
  extraEnv?: Record<string, string>;
}): Promise<ClaxedoLaunch> {
  const timeoutMs = input.timeoutMs ?? 60_000;
  await Promise.all([
    mkdir(input.isolatedProfilePath, { recursive: true, mode: 0o700 }),
    mkdir(input.dataDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const [debugPort, serverPort] = await Promise.all([
    availablePort(),
    availablePort(),
  ]);
  const runDirectory = path.dirname(input.isolatedProfilePath);
  const startTimestamp = performance.now();
  const application = Bun.spawn({
    cmd: [
      input.executable,
      `--remote-debugging-port=${String(debugPort)}`,
      `--claxedo-window-size=${String(AGENT_APP_WINDOW.width)},${String(AGENT_APP_WINDOW.height)}`,
      "--claxedo-window-maximized",
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ],
    env: {
      ...process.env,
      ...ambientIsolationEnv(input.isolatedProfilePath),
      ...startupClockEnv(runDirectory),
      CLAXEDO_DESKTOP_USER_DATA_DIR: input.isolatedProfilePath,
      CLAXEDO_DATA_DIR: input.dataDirectory,
      CLAXEDO_SERVER_PORT: String(serverPort),
      CLAXEDO_DEVTOOLS: "0",
      GOMAXPROCS: process.env.GOMAXPROCS ?? "2",
      ...(input.extraEnv ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Kept rather than dropped only when the startup clock is on. Discarding the
  // application's stdio is what made the server child mute for the whole
  // effort; keeping it unconditionally would put harness-process file writes
  // beside a measured application on a single machine, so the blindness is
  // lifted exactly in the window someone is looking.
  void drain(application.stdout, startupClockEnabled() ? path.join(runDirectory, "app-stdout.log") : undefined);
  void drain(application.stderr, startupClockEnabled() ? path.join(runDirectory, "app-stderr.log") : undefined);

  let page: BenchmarkPage | undefined;
  try {
    page = await connectCdpPage({
      port: debugPort,
      process: application,
      timeoutMs,
    });
    const connectedPage = page;
    await installAgentBrowserObserver(connectedPage);
    let reloadCount = 0;
    let crashCount = 0;
    let ready = false;
    connectedPage.on("framenavigated", (frame) => {
      if (ready && frame === connectedPage.mainFrame()) reloadCount++;
    });
    connectedPage.on("crash", () => {
      crashCount++;
    });
    try {
      await connectedPage.waitForFunction(
        (sessionIds) => {
          return sessionIds.some((sessionId) => {
            const row = document.querySelector<HTMLElement>(
              `[data-testid="rail-sidebar-session-row"][data-session-id="${CSS.escape(sessionId)}"]`,
            );
            if (!row) return false;
            const bounds = row.getBoundingClientRect();
            return (
              bounds.width > 0 &&
              bounds.height > 0 &&
              getComputedStyle(row).visibility !== "hidden"
            );
          });
        },
        input.readinessTargets.map((target) => target.sessionId),
        { timeout: timeoutMs },
      );
    } catch (error) {
      const snapshot = await connectedPage.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText.slice(0, 1_000) ?? "",
        sessionRows: [
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid="rail-sidebar-session-row"]',
          ),
        ]
          .slice(0, 20)
          .map((row) => ({
            id: row.dataset.sessionId,
            text: row.innerText.slice(0, 120),
          })),
        fatal: document.querySelector<HTMLElement>(
          '[data-testid="fatal-error"], [data-fatal-error]',
        )?.innerText,
      }));
      throw new Error(
        `Packaged Claxedo semantic readiness timed out: ${JSON.stringify(snapshot)}`,
        { cause: error },
      );
    }
    // Both comparison drivers maximize the native Electron window on the host
    // display before any measured interaction. This keeps the content viewport
    // dynamic for the machine instead of silently benchmarking two geometries.
    const requestedViewport = await stableAgentAppBenchmarkViewport(connectedPage);
    // [PERF-DIAG TEMPORARY] renderer clock at the exact semantic-readiness row paint.
    const rowVisibleRendererNow = await connectedPage.evaluate(() => performance.now());
    // Check after the first production session row so electron-window-state has
    // completed its startup bounds work before any measured action begins.
    const exactViewport = await connectedPage.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (
      exactViewport.width !== requestedViewport.width ||
      exactViewport.height !== requestedViewport.height
    ) {
      throw new Error(`Packaged Claxedo could not establish the maximized viewport: ${JSON.stringify({ requestedViewport, exactViewport })}`);
    }
    const readinessTarget = input.readinessTargets[0];
    if (!readinessTarget) throw new Error("Packaged Claxedo readiness requires a canonical session target");
    const semanticReadiness = await measureSessionActivation(connectedPage, readinessTarget);
    if (semanticReadiness.state !== "exact") {
      throw new Error(`Packaged Claxedo strict semantic readiness failed: ${semanticReadiness.reason}`);
    }
    await stablePaint(connectedPage);
    ready = true;
    const token = `cold-ready-${crypto.randomUUID()}`;
    await connectedPage.evaluate(
      (value) => window.__CLAXEDO_AGENT_APP_BENCHMARK__?.armAction(value),
      token,
    );
    await connectedPage.keyboard.press("Tab");
    const trusted = await connectedPage.evaluate(
      async (value) =>
        await window.__CLAXEDO_AGENT_APP_BENCHMARK__?.finishAction(value),
      token,
    );
    if (!trusted || trusted.state !== "exact")
      throw new Error(
        "Claxedo did not accept the cold-ready trusted input probe",
      );
    const endTimestamp = performance.now();
    // [PERF-DIAG TEMPORARY] deterministic cold-ready critical-path dump.
    try {
      const serial = coldReadyDiagnosticsSerial++;
      await captureColdReadyDiagnostics({
        page: connectedPage,
        runDirectory,
        serial,
        phase: "cold-ready",
        coldReadyMs: endTimestamp - startTimestamp,
      });
      await writeJson(
        path.join(runDirectory, `cold-ready-diagnostics-${String(serial).padStart(3, "0")}-row-visible.json`),
        { serial, rowVisibleRendererNow },
      );
    } catch {}
    const initialTable = await readProcessTable();
    const rootSnapshot = initialTable.find((item) => item.pid === application.pid);
    if (!rootSnapshot) throw new Error(`Unable to resolve Claxedo root process ${application.pid}`);
    const processRecord: OwnedProcess = {
      pid: application.pid,
      startTimeMs: rootSnapshot.startTimeMs,
      owner: "application",
      category: "claxedo-root",
    };
    const known = new Map<string, ProcessSnapshot>();
    const refreshKnown = async () => {
      const family = processFamily(await readProcessTable(), application.pid);
      for (const item of family) known.set(`${item.pid}:${item.startTimeMs}`, item);
      return family;
    };
    await refreshKnown();
    const ownershipTimer = setInterval(() => void refreshKnown().catch(() => undefined), 100);
    ownershipTimer.unref();

    return {
      application,
      page: connectedPage,
      serverUrl: `http://127.0.0.1:${String(serverPort)}`,
      process: processRecord,
      coldReady: {
        startTimestamp,
        endTimestamp,
        durationMs: endTimestamp - startTimestamp,
        resolutionMs: monotonicResolutionMs(),
        trustedInputAccepted: true,
        reloadCount,
        crashCount,
        semantic: semanticReadiness.paintedMessage,
      },
      async inspect() {
        const [surface, processes] = await Promise.all([
          connectedPage.evaluate(() => ({
            visibilityState: document.visibilityState,
            focused: document.hasFocus(),
            hidden: document.hidden,
            viewport: { width: innerWidth, height: innerHeight },
          })),
          refreshKnown(),
        ]);
        return { surface, processes };
      },
      async shutdown() {
        clearInterval(ownershipTimer);
        await refreshKnown().catch(() => []);
        await connectedPage
          .evaluate(() =>
            (window as Window & { api?: { quit?: () => void } }).api?.quit?.(),
          )
          .catch(() => undefined);
        await Promise.race([application.exited, Bun.sleep(5_000)]);
        if (application.exitCode === null) application.kill("SIGTERM");
        await Promise.race([application.exited, Bun.sleep(3_000)]);
        if (application.exitCode === null) {
          application.kill("SIGKILL");
          await Promise.race([application.exited, Bun.sleep(3_000)]);
        }
        connectedPage.close();
        const beforeCleanup = await readProcessTable();
        const forced: OwnedProcess[] = [];
        for (const item of known.values()) {
          const alive = beforeCleanup.find((candidate) => sameProcessIdentity(candidate, item));
          if (!alive) continue;
          forced.push({ pid: item.pid, startTimeMs: item.startTimeMs, owner: "application", category: item.pid === application.pid ? "claxedo-root" : "claxedo-descendant" });
          try { process.kill(item.pid, "SIGKILL"); } catch {}
        }
        await Bun.sleep(100);
        const finalTable = await readProcessTable();
        const survivors = [...known.values()]
          .filter((item) => finalTable.some((candidate) => sameProcessIdentity(candidate, item)))
          .map((item) => ({ pid: item.pid, startTimeMs: item.startTimeMs, owner: "application" as const, category: item.pid === application.pid ? "claxedo-root" : "claxedo-descendant" }));
        const survivorKeys = new Set(survivors.map((item) => `${item.pid}:${item.startTimeMs}`));
        const terminated = [...known.values()]
          .filter((item) => !survivorKeys.has(`${item.pid}:${item.startTimeMs}`))
          .map((item) => ({ pid: item.pid, startTimeMs: item.startTimeMs, owner: "application" as const, category: item.pid === application.pid ? "claxedo-root" : "claxedo-descendant" }));
        return { terminated, survivors, forced };
      },
    };
  } catch (error) {
    page?.close();
    if (application.exitCode === null) application.kill("SIGTERM");
    await Promise.race([application.exited, Bun.sleep(3_000)]);
    if (application.exitCode === null) {
      application.kill("SIGKILL");
      await Promise.race([application.exited, Bun.sleep(3_000)]);
    }
    throw error;
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to reserve loopback port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function stablePaint(page: BenchmarkPage) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function stableAgentAppBenchmarkViewport(page: BenchmarkPage) {
  return page.evaluate(
    () =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        let previous = "";
        let stableFrames = 0;
        const sample = () => {
          const current = `${innerWidth}x${innerHeight}`;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 2) {
            if (innerWidth !== screen.availWidth) {
              reject(new Error(`Benchmark window is not maximized: ${innerWidth}x${innerHeight}; display ${screen.availWidth}x${screen.availHeight}`));
              return;
            }
            resolve({ width: innerWidth, height: innerHeight });
          }
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}

async function drain(stream: ReadableStream<Uint8Array>, sink?: string) {
  const reader = stream.getReader();
  const file = sink ? Bun.file(sink).writer() : undefined;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (file && chunk.value) file.write(chunk.value);
    }
  } finally {
    await file?.end();
  }
}

function monotonicResolutionMs() {
  let previous = performance.now();
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 10_000; index++) {
    const next = performance.now();
    if (next > previous) minimum = Math.min(minimum, next - previous);
    previous = next;
  }
  return Number.isFinite(minimum) ? minimum : 1;
}
