import { IdleProcessFamilyTracker, parseIdleProcessTable, type IdleProcessRow } from "./idle-process-family";

export type ProcessSnapshot = {
  pid: number;
  parentPid: number;
  startTimeMs: number;
  rssBytes: number;
  cpuSeconds: number;
  executable: string;
  command: string;
  /**
   * macOS `ri_phys_footprint` for this process, when the packaged diagnostics
   * helper is available. Reported alongside `rssBytes`, never instead of it:
   * `resource.peak_process_family_rss_mib` is defined on the summed `ps rss`
   * and is deliberately left untouched. Summed RSS charges shared pages to
   * every process that maps them, so a five-process family counts one Electron
   * Framework up to five times; `ri_phys_footprint` is what the OS actually
   * attributes. Recording both makes that difference visible per run instead of
   * arguable.
   */
  physFootprintBytes?: number;
};

export async function readProcessTable(): Promise<ProcessSnapshot[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`process-family observation is unsupported on ${process.platform}`);
  const child = Bun.spawn({ cmd: ["ps", "-axo", "pid=,ppid=,rss=,time=,lstart=,command="], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`ps failed: ${stderr.trim()}`);
  const parsed = parseProcessTable(stdout);
  if (!parsed.length) throw new Error("ps returned no parseable process rows");
  return parsed;
}

export function parseProcessTable(output: string): ProcessSnapshot[] {
  return parseIdleProcessTable(output).map(fromIdleRow);
}

export function toIdleRows(table: readonly ProcessSnapshot[]): IdleProcessRow[] {
  return table.map((row) => ({ pid: row.pid, ppid: row.parentPid, rssBytes: row.rssBytes, cpuSeconds: row.cpuSeconds, startedAtMs: row.startTimeMs, command: row.command }));
}

export function processFamily(table: readonly ProcessSnapshot[], rootPid: number) {
  const tracker = new IdleProcessFamilyTracker(rootPid);
  const ids = new Set(tracker.observe(toIdleRows(table), performance.now()).pids);
  return table.filter((row) => ids.has(row.pid));
}

export function processLineage(table: readonly ProcessSnapshot[], pid: number) {
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const result: ProcessSnapshot[] = [];
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && !seen.has(current.pid)) { result.push(current); seen.add(current.pid); current = byPid.get(current.parentPid); }
  return result;
}
export function isT3Process(process: Pick<ProcessSnapshot, "executable" | "command">) {
  return /(^|[\s/\\])(?:t3|t3code)(?=$|[\s/\\.:-])/iu.test(`${process.executable} ${process.command}`);
}
export function sameProcessIdentity(left: Pick<ProcessSnapshot, "pid" | "startTimeMs">, right: Pick<ProcessSnapshot, "pid" | "startTimeMs">) {
  return left.pid === right.pid && Math.abs(left.startTimeMs - right.startTimeMs) < 1_000;
}

/**
 * The product already ships and locates this helper: `src/main/index.ts` builds
 * `<resourcesPath>/diagnostics/macos-memory-impact` and hands it to the
 * diagnostics worker. Resolve it the same way from the packaged executable so
 * the benchmark reads the same instrument the application reports from, rather
 * than inventing a second definition of physical footprint.
 */
export function macMemoryHelperPath(executable: string) {
  const marker = "/Contents/MacOS/";
  const index = executable.lastIndexOf(marker);
  if (index === -1) return undefined;
  return `${executable.slice(0, index)}/Contents/Resources/diagnostics/macos-memory-impact`;
}

/** Matches the helper's `<pid> <bytes>` line contract in `resources/diagnostics/macos-memory-impact.c`. */
export function parseMacMemoryImpact(output: string) {
  return new Map(
    output.split("\n").flatMap((line) => {
      const match = /^(\d+) (\d+)$/u.exec(line.trim());
      if (!match) return [];
      const pid = Number(match[1]);
      const bytes = Number(match[2]);
      return Number.isInteger(pid) && pid > 0 && Number.isSafeInteger(bytes) && bytes >= 0 ? [[pid, bytes] as const] : [];
    }),
  );
}

/**
 * One spawn for the whole family, never one per process: the helper's own
 * `argc` bound is 512 pids and a benchmark samples at 1 Hz beside a `ps` that
 * already costs an order of magnitude more.
 *
 * Every failure path returns no readings. A missing, unbuilt, or unsigned
 * helper must never fail a sample, because this series gates nothing.
 */
export async function readPhysFootprint(pids: readonly number[], helperPath: string | undefined) {
  const empty = new Map<number, number>();
  if (!helperPath || pids.length === 0 || pids.length > 512) return empty;
  try {
    const child = Bun.spawn({ cmd: [helperPath, ...pids.map(String)], stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? parseMacMemoryImpact(stdout) : empty;
  } catch {
    return empty;
  }
}

/** Attaches readings without disturbing any existing field, and omits the key entirely when a process has none. */
export function withPhysFootprint(family: readonly ProcessSnapshot[], readings: ReadonlyMap<number, number>) {
  return family.map((row) => {
    const bytes = readings.get(row.pid);
    return bytes === undefined ? row : { ...row, physFootprintBytes: bytes };
  });
}

/** Summed physical footprint, reported only when every family member was read, so a partial sum can never be mistaken for a total. */
export function totalPhysFootprintBytes(family: readonly ProcessSnapshot[]) {
  if (family.length === 0 || family.some((row) => row.physFootprintBytes === undefined)) return undefined;
  return family.reduce((total, row) => total + (row.physFootprintBytes ?? 0), 0);
}
function fromIdleRow(row: IdleProcessRow): ProcessSnapshot {
  const executable = row.command.trim().split(/\s+/u)[0] ?? "";
  return { pid: row.pid, parentPid: row.ppid, startTimeMs: row.startedAtMs, rssBytes: row.rssBytes, cpuSeconds: row.cpuSeconds, executable, command: row.command };
}
