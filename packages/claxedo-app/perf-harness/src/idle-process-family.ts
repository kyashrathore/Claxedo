export type IdleProcessRow = {
  pid: number
  ppid: number
  rssBytes: number
  cpuSeconds: number
  startedAtMs: number
  command: string
}

export type IdleProcessFamilyObservation = {
  atMs: number
  rssBytes: number
  processCount: number
  pids: number[]
  discoveredPids: number[]
  disappearedPids: number[]
  cpuPercent?: number
}

export type IdleResourceSummary = {
  peakRssBytes: number
  rssP95Bytes: number
  finalRssBytes: number
  cpuP95Percent: number
  expectedCpuSamples: number
  achievedCpuSamples: number
  maxSampleGapMs: number
  valid: boolean
  invalidReasons: string[]
}

const processIdentity = (row: Pick<IdleProcessRow, "pid" | "startedAtMs">) =>
  `${String(row.pid)}:${String(row.startedAtMs)}`

/**
 * Tracks identities, rather than bare PIDs, across a dynamic process family.
 * Once a descendant is observed it remains owned even if an ancestor exits and
 * the OS reparents it. Every observation expands to a fixed point, so family
 * depth is not capped by an arbitrary number of passes.
 */
export class IdleProcessFamilyTracker {
  readonly #rootPid: number
  readonly #knownIdentities = new Set<string>()
  #previous?: { atMs: number; rows: Map<string, IdleProcessRow> }

  constructor(rootPid: number) {
    if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error(`invalid process-family root PID: ${String(rootPid)}`)
    this.#rootPid = rootPid
  }

  observe(rows: IdleProcessRow[], atMs: number): IdleProcessFamilyObservation {
    if (!Number.isFinite(atMs) || atMs < 0) throw new Error(`invalid process sample time: ${String(atMs)}`)
    const family = this.#discover(rows)
    const current = new Map(family.map((row) => [processIdentity(row), row]))
    const previous = this.#previous
    const discoveredPids = family.filter((row) => !previous?.rows.has(processIdentity(row))).map((row) => row.pid)
    const disappearedPids = previous
      ? [...previous.rows.values()].filter((row) => !current.has(processIdentity(row))).map((row) => row.pid)
      : []

    let cpuPercent: number | undefined
    if (previous) {
      const elapsedSeconds = (atMs - previous.atMs) / 1_000
      if (!(elapsedSeconds > 0)) throw new Error("process samples must have strictly increasing times")
      let cpuDeltaSeconds = 0
      for (const row of family) {
        const prior = previous.rows.get(processIdentity(row))
        if (prior) {
          cpuDeltaSeconds += Math.max(0, row.cpuSeconds - prior.cpuSeconds)
          continue
        }
        // Full fixed-point discovery means a previously unseen descendant was
        // born since the prior family snapshot, so its lifetime counter has an
        // implicit zero baseline at or after that snapshot.
        cpuDeltaSeconds += Math.max(0, row.cpuSeconds)
      }
      cpuPercent = (cpuDeltaSeconds / elapsedSeconds) * 100
    }

    this.#previous = { atMs, rows: current }
    return {
      atMs,
      rssBytes: family.reduce((total, row) => total + row.rssBytes, 0),
      processCount: family.length,
      pids: family.map((row) => row.pid).toSorted((left, right) => left - right),
      discoveredPids: discoveredPids.toSorted((left, right) => left - right),
      disappearedPids: disappearedPids.toSorted((left, right) => left - right),
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
    }
  }

  resetSamplingBaseline() {
    this.#previous = undefined
  }

  survivors(rows: IdleProcessRow[]) {
    // Expand once more before reporting so a descendant forked during shutdown
    // cannot evade ownership merely because it was absent from the last sample.
    return this.#discover(rows).toSorted((left, right) => left.pid - right.pid)
  }

  #discover(rows: IdleProcessRow[]) {
    const root = rows.find((row) => row.pid === this.#rootPid)
    if (this.#knownIdentities.size === 0) {
      if (!root) throw new Error(`process-family root ${String(this.#rootPid)} was absent from the first sample`)
      this.#knownIdentities.add(processIdentity(root))
    }

    const family = new Map<string, IdleProcessRow>()
    for (const row of rows) {
      const identity = processIdentity(row)
      if (this.#knownIdentities.has(identity)) family.set(identity, row)
    }

    let changed = true
    while (changed) {
      changed = false
      const familyPids = new Set([...family.values()].map((row) => row.pid))
      for (const row of rows) {
        const identity = processIdentity(row)
        if (family.has(identity) || !familyPids.has(row.ppid)) continue
        family.set(identity, row)
        this.#knownIdentities.add(identity)
        changed = true
      }
    }
    return [...family.values()]
  }
}

/** Parse the portable fields emitted by `ps -axo pid=,ppid=,rss=,time=,lstart=,command=`. */
export function parseIdleProcessTable(output: string): IdleProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{4})\s+(.+)$/,
    )
    if (!match) return []
    const startedAtMs = Date.parse(`${match[5]} ${match[6]} ${match[7]} ${match[8]} ${match[9]}`)
    const cpuSeconds = parseCpuTime(match[4]!)
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(cpuSeconds)) return []
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1_024,
      cpuSeconds,
      startedAtMs,
      command: match[10]!,
    }]
  })
}

export function summarizeIdleResourceWindow(
  observations: IdleProcessFamilyObservation[],
  requestedDurationMs: number,
  requestedIntervalMs: number,
): IdleResourceSummary {
  const invalidReasons: string[] = []
  if (!(requestedDurationMs > 0) || !(requestedIntervalMs > 0)) invalidReasons.push("invalid-window")
  if (observations.length < 2) invalidReasons.push("insufficient-samples")
  const ordered = observations.toSorted((left, right) => left.atMs - right.atMs)
  const gaps = ordered.slice(1).map((sample, index) => sample.atMs - ordered[index]!.atMs)
  const maxSampleGapMs = gaps.length === 0 ? 0 : Math.max(...gaps)
  if (gaps.some((gap) => gap <= 0 || gap > requestedIntervalMs * 2)) invalidReasons.push("sample-gap")
  const coveredDurationMs = ordered.length < 2 ? 0 : ordered.at(-1)!.atMs - ordered[0]!.atMs
  if (coveredDurationMs < requestedDurationMs * 0.99) invalidReasons.push("short-window")

  const expectedCpuSamples = Math.ceil(requestedDurationMs / requestedIntervalMs)
  const cpuValues = ordered.flatMap((sample) => sample.cpuPercent === undefined ? [] : [sample.cpuPercent])
  if (cpuValues.length < Math.ceil(expectedCpuSamples * 0.95)) invalidReasons.push("insufficient-cpu-samples")
  const rssValues = ordered.map((sample) => sample.rssBytes)
  return {
    peakRssBytes: rssValues.length === 0 ? 0 : Math.max(...rssValues),
    rssP95Bytes: nearestRank(rssValues, 95),
    finalRssBytes: rssValues.at(-1) ?? 0,
    cpuP95Percent: nearestRank(cpuValues, 95),
    expectedCpuSamples,
    achievedCpuSamples: cpuValues.length,
    maxSampleGapMs,
    valid: invalidReasons.length === 0,
    invalidReasons,
  }
}

function parseCpuTime(value: string) {
  const dayParts = value.split("-")
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0
  const clock = dayParts.at(-1)!.split(":").map(Number)
  if (clock.some((part) => !Number.isFinite(part)) || clock.length < 2 || clock.length > 3) return Number.NaN
  const seconds = clock.at(-1)!
  const minutes = clock.at(-2)!
  const hours = clock.length === 3 ? clock[0]! : 0
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

function nearestRank(values: number[], rank: number) {
  if (values.length === 0) return 0
  const ordered = values.toSorted((left, right) => left - right)
  const index = Math.max(0, Math.ceil((rank / 100) * ordered.length) - 1)
  return ordered[Math.min(index, ordered.length - 1)]!
}
