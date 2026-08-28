import { createHash } from "node:crypto";
import os from "node:os";

export type HostState = {
  capturedAt: string;
  wallTimeMs: number;
  monotonicTimeMs: number;
  power: { source: "ac"; raw: string };
  thermal: { state: "nominal"; raw: string };
  displays: { sha256: string; raw: string };
};

export type CommandResult = { code: number; stdout: string; stderr: string };
export type HostCommands = { run(command: string[]): Promise<CommandResult> };

export const systemHostCommands: HostCommands = {
  async run(command) {
    const child = Bun.spawn({ cmd: command, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  },
};

/**
 * A quiet host is a precondition, not a courtesy.
 *
 * This preflight already refuses to measure on battery, under a thermal warning, or without a known
 * display — because each of those silently widens the error bars on every metric. It did not check
 * whether anything ELSE was using the machine. Measured consequence: two orphaned Playwright suites
 * and their ffmpeg video encoders ran for 3h08m at a load average of 11.73 on a 12-core host, THROUGH
 * fourteen packaged benchmark runs, and nothing in the harness noticed. Those runs report numbers with
 * no indication that they are unreadable.
 *
 * The threshold is deliberately loose: this is meant to catch a machine that is busy, not to arbitrate
 * scheduler noise. The load average is always recorded so a reader can see the conditions a number was
 * taken under even when it passed.
 */
export const QUIET_HOST_LOAD_LIMIT = 4;

export function parseLoadAverage(uptimeOutput: string): number | undefined {
  const match = /averages?:\s*(\d+(?:[.,]\d+)?)/iu.exec(uptimeOutput);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

export function assertQuietHost(uptimeOutput: string) {
  const load = parseLoadAverage(uptimeOutput);
  if (load === undefined) throw new Error(`preflight could not read the host load average: ${uptimeOutput.trim()}`);
  if (load > QUIET_HOST_LOAD_LIMIT) {
    if (process.env.CLAXEDO_BENCH_ALLOW_BUSY_HOST === "1") {
      console.warn(
        `CLAXEDO_BENCH_ALLOW_BUSY_HOST=1: 1-minute load average ${load.toFixed(2)} exceeds ${String(QUIET_HOST_LOAD_LIMIT)}; continuing anyway.`,
      );
      return load;
    }
    throw new Error(
      `preflight requires a quiet host: 1-minute load average ${load.toFixed(2)} exceeds ${String(QUIET_HOST_LOAD_LIMIT)}. ` +
        `Something else is using this machine; measuring now produces numbers whose error bars are unknown.`,
    );
  }
  return load;
}

export async function captureHostState(commands: HostCommands = systemHostCommands): Promise<HostState> {
  if (process.platform === "darwin") return captureDarwinState(commands);
  if (process.platform === "linux") return captureLinuxState(commands);
  throw new Error(`strict benchmark preflight is unsupported on ${process.platform}`);
}

async function captureDarwinState(commands: HostCommands): Promise<HostState> {
  const [power, thermal, displays] = await Promise.all([
    checked(commands, ["pmset", "-g", "batt"]),
    checked(commands, ["pmset", "-g", "therm"]),
    checked(commands, ["system_profiler", "SPDisplaysDataType", "-json"]),
  ]);
  if (!/Now drawing from ['"]AC Power['"]/u.test(power)) throw new Error(`preflight requires AC power: ${power.trim()}`);
  if (!/No thermal warning level has been recorded/u.test(thermal) || !/No performance warning level has been recorded/u.test(thermal)) {
    throw new Error(`preflight requires known nominal thermal and performance state: ${thermal.trim()}`);
  }
  const parsed = JSON.parse(displays) as { SPDisplaysDataType?: unknown[] };
  if (!Array.isArray(parsed.SPDisplaysDataType) || parsed.SPDisplaysDataType.length === 0) throw new Error("preflight could not identify a display");
  assertQuietHost(await checked(commands, ["uptime"]));
  return state(power, thermal, displays);
}

async function captureLinuxState(commands: HostCommands): Promise<HostState> {
  const [power, thermal, displays] = await Promise.all([
    checked(commands, ["sh", "-c", "for f in /sys/class/power_supply/*/online; do [ -f \"$f\" ] && printf '%s=' \"$f\" && cat \"$f\"; done"]),
    checked(commands, ["sh", "-c", "for f in /sys/class/thermal/thermal_zone*/temp; do [ -f \"$f\" ] && printf '%s=' \"$f\" && cat \"$f\"; done"]),
    checked(commands, ["xrandr", "--current"]),
  ]);
  if (!/=1(?:\n|$)/u.test(power)) throw new Error(`preflight requires a known online AC supply: ${power.trim()}`);
  const temperatures = [...thermal.matchAll(/=(\d+)(?:\n|$)/gu)].map((match) => Number(match[1]) / 1_000);
  if (temperatures.length === 0 || temperatures.some((value) => !Number.isFinite(value) || value >= 85)) {
    throw new Error(`preflight requires known nominal thermal sensors: ${thermal.trim()}`);
  }
  if (!/ connected /u.test(displays)) throw new Error("preflight could not identify a connected display");
  return state(power, thermal, displays);
}

function state(power: string, thermal: string, displays: string): HostState {
  return {
    capturedAt: new Date().toISOString(),
    wallTimeMs: Date.now(),
    monotonicTimeMs: performance.now(),
    power: { source: "ac", raw: power.trim() },
    thermal: { state: "nominal", raw: thermal.trim() },
    displays: { sha256: createHash("sha256").update(displays).digest("hex"), raw: displays.trim() },
  };
}

async function checked(commands: HostCommands, command: string[]) {
  const result = await commands.run(command);
  if (result.code !== 0) throw new Error(`${command[0]} failed: ${result.stderr.trim()}`);
  if (!result.stdout.trim()) throw new Error(`${command[0]} returned no state`);
  return result.stdout;
}

export function validateHostTransition(before: HostState, after: HostState) {
  const failures: string[] = [];
  if (after.power.source !== "ac") failures.push("power-source-changed");
  if (after.thermal.state !== "nominal") failures.push("thermal-state-invalid");
  if (before.displays.sha256 !== after.displays.sha256) failures.push("display-configuration-changed");
  const wallElapsed = after.wallTimeMs - before.wallTimeMs;
  const monotonicElapsed = after.monotonicTimeMs - before.monotonicTimeMs;
  if (wallElapsed < 0 || monotonicElapsed < 0 || Math.abs(wallElapsed - monotonicElapsed) > 1_000) failures.push("sleep-or-clock-interruption");
  return failures;
}

export type KeepAwakeLease = {
  pid: number;
  assertActive(): void;
  release(): Promise<void>;
};

export async function acquireKeepAwake(): Promise<KeepAwakeLease> {
  const command = process.platform === "darwin"
    ? ["caffeinate", "-dimsu", "-w", String(process.pid)]
    : process.platform === "linux"
      ? ["systemd-inhibit", "--what=sleep:idle", "--mode=block", "--who=claxedo-agent-app-benchmark", "sleep", "infinity"]
      : undefined;
  if (!command) throw new Error(`keep-awake is unsupported on ${process.platform}`);
  const child = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "pipe" });
  let exited = false;
  let exitCode: number | undefined;
  const exit = child.exited.then((code) => {
    exited = true;
    exitCode = code;
    return code;
  });
  await Bun.sleep(25);
  if (exited) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(`keep-awake failed to remain active: ${stderr.trim()}`);
  }
  const waitForExit = async (timeoutMs: number) =>
    await Promise.race([exit.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
  return {
    pid: child.pid,
    assertActive() {
      if (exited) throw new Error(`keep-awake exited with ${String(exitCode)}`);
    },
    async release() {
      if (!exited) child.kill("SIGTERM");
      if (await waitForExit(1_000)) return;
      child.kill("SIGKILL");
      if (!(await waitForExit(1_000))) throw new Error(`keep-awake process ${child.pid} survived release`);
    },
  };
}

export function environmentDisclosure() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    bunVersion: Bun.version,
    window: { width: 1440, height: 900 },
    // Which ambient environment produced this number. The embedded engine reads a
    // GLOBAL OpenCode config from the operator's home directory, and that config can
    // install third-party plugins; one measured example awaits an uncached network
    // fetch inside `plugin.init()`, on the critical path of `app.cold_ready_ms`.
    // "operator-ambient" means the operator's own config and caches were in scope.
    ambientEnvironment:
      process.env.CLAXEDO_BENCH_ISOLATE_AMBIENT === "1" ? "isolated" : "operator-ambient",
  };
}
