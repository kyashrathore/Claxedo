import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { terminalWorkloadContract } from "./agent-terminal-workload-contract"
import type { BenchmarkPage as Page } from "./agent-cdp-page"
import { beginTerminalObservation, finishTerminalObservation } from "./agent-browser-observer"

export const TERMINAL_START_MARKER = "⟦t3-benchmark-start⟧\r\n"
export const TERMINAL_COMPLETE_MARKER = "\u001b[32m⟦t3-benchmark-complete⟧\u001b[0m\r\n"

type TerminalStream = {
  id: string
  chunks: Array<{ sequence: number; atMs: number; bytesBase64: string }>
  inputSentinels: string[]
  columns: number
  rows: number
  expectedBytes: number
  expectedSha256: string
}

export async function runTerminalScenario(input: {
  page: Page
  runDirectory: string
  stream: TerminalStream
}) {
  const workload = await createTerminalWorkload(input.runDirectory, input.stream)
  await input.page.getByTestId("workspace-scope-new-terminal").click()
  const shellLauncher = input.page.locator('[data-launcher-id="shell"]')
  await terminalStage("shell launcher visibility", () => shellLauncher.waitFor({ state: "visible" }))
  await shellLauncher.click()
  const pane = input.page.getByTestId("terminal-pane").last()
  await terminalStage("created terminal pane visibility", () => pane.waitFor({ state: "visible" }))
  const terminalId = await pane.getAttribute("data-terminal-id")
  if (!terminalId) throw new Error("created terminal has no terminal id")
  await terminalStage("terminal PTY connection", () => input.page.waitForFunction((id) => {
    const candidate = [...document.querySelectorAll<HTMLElement>('[data-testid="terminal-pane"]')]
      .find((item) => item.dataset.terminalId === id)
    return candidate?.dataset.terminalConnected === "true"
  }, terminalId))
  await terminalStage("first parsed PTY output", () => input.page.waitForFunction((id) =>
    window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalOutputObserved(id) === true, terminalId))
  const terminalHost = pane.locator('[data-component="terminal"]')
  const textarea = pane.locator(".xterm-helper-textarea")
  await terminalStage("xterm input attachment", () => textarea.waitFor({ state: "attached" }))
  const instanceId = await terminalHost.getAttribute("data-terminal-benchmark-instance-id")
  if (!instanceId) throw new Error("created terminal has no benchmark instance id")
  await textarea.focus()
  const readyMarker = `T3_TERMINAL_READY_${terminalId.replaceAll(/[^a-zA-Z0-9]/g, "_")}`
  await input.page.keyboard.type(`printf '${readyMarker}\\n'`)
  await input.page.keyboard.press("Enter")
  await terminalStage("trusted shell-input readiness marker", () => input.page.waitForFunction(({ id, marker }) =>
    window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalOutputIncludes(id, marker) === true,
  { id: terminalId, marker: readyMarker }))
  await beginTerminalObservation(input.page, {
    terminalId,
    instanceId,
    startSentinel: TERMINAL_START_MARKER,
    rawEndSentinel: TERMINAL_COMPLETE_MARKER,
    modelEndSentinel: "⟦t3-benchmark-complete⟧",
    expectedEchoes: input.stream.inputSentinels.map((sentinel) => `⟦input:${sentinel}⟧`),
    bytes: workload.expectedBytes,
  })
  await input.page.keyboard.type(workload.command)
  await input.page.keyboard.press("Enter")
  // The workload process is setup, not part of a key interaction. Wait until
  // its start marker has crossed both the socket-arrival and xterm-parse
  // boundaries before arming the first trusted key, otherwise cold process
  // startup is incorrectly charged to terminal input-to-paint.
  await terminalStage("terminal workload start", () => input.page.waitForFunction(() =>
    window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalObservationStarted() === true))
  for (const [index, sentinel] of input.stream.inputSentinels.entries()) {
    const threshold = workload.inputByteThresholds[index]
    if (threshold === undefined) throw new Error(`terminal input threshold is missing for ${sentinel}`)
    const ready = `⟦input-ready:${sentinel}⟧`
    await terminalStage(`terminal sustained progress ${sentinel}`, () => input.page.waitForFunction((value) =>
      window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalAcceptedMarkerObserved(value) === true, ready))
    const echo = `⟦input:${sentinel}⟧`
    await input.page.evaluate((value) => window.__CLAXEDO_AGENT_APP_BENCHMARK__?.armTerminalInput(value), echo)
    await textarea.focus()
    await input.page.keyboard.type(sentinel)
    await input.page.keyboard.press("Enter")
    await terminalStage(`terminal input echo ${sentinel}`, () => input.page.waitForFunction((value) =>
      window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalInputObserved(value) === true, echo))
  }
  try {
    await terminalStage("terminal stream completion", () => input.page.waitForFunction(() =>
      window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalObservationComplete() === true))
  } catch (cause) {
    const status = await input.page.evaluate(() => ({
      observer: window.__CLAXEDO_AGENT_APP_BENCHMARK__?.terminalObservationStatus(),
      visibleInstanceId: document.querySelector<HTMLElement>(
        '[data-testid="terminal-pane"]:not([aria-hidden="true"]) [data-component="terminal"]',
      )?.dataset.terminalBenchmarkInstanceId,
    }))
    throw new Error(`Terminal observation did not complete: ${JSON.stringify(status)}`, { cause })
  }
  const result = await finishTerminalObservation(input.page, {
      outputHash: workload.expectedSha256,
      bytes: workload.expectedBytes,
      minimumDurationMs: workload.sustainedDurationMs,
    })
  // Let the measured renderer drain and capture the complete model before the
  // workload process exits. PTY removal otherwise unmounts the active xterm
  // while its FIFO still owns the final parsed receipt.
  await textarea.focus()
  await input.page.keyboard.type("T3_TERMINAL_SHUTDOWN")
  await input.page.keyboard.press("Enter")
  if (result.evidence && !("state" in result.evidence)) {
    if (!workload.expectedModelHash) throw new Error("terminal workload is missing its pinned model hash")
    workload.actualColumns = result.evidence.cols
    workload.actualRows = result.evidence.rows
    workload.geometryMatched = result.evidence.cols === workload.expectedColumns &&
      result.evidence.rows === workload.expectedRows
    workload.actualModelHash = result.evidence.modelHash
    workload.modelMatched = workload.geometryMatched && workload.expectedModelHash === workload.actualModelHash
    if (!workload.modelMatched) result.metric = {
      state: "invalid",
      reason: workload.geometryMatched ? "terminal-model-mismatch" : "terminal-geometry-mismatch",
    }
  }
  return {
    ...result,
    workload,
  }
}

async function terminalStage<T>(name: string, run: () => Promise<T>) {
  try {
    return await run()
  } catch (cause) {
    throw new Error(`Terminal benchmark failed while waiting for ${name}`, { cause })
  }
}

const TERMINAL_CONTRACT = terminalWorkloadContract()
export const TERMINAL_SUSTAINED_DURATION_MS = TERMINAL_CONTRACT.activeDurationMs
export const TERMINAL_SUSTAINED_LOAD_MIB_S = TERMINAL_CONTRACT.offeredMiBS
const TERMINAL_SUSTAINED_TICKS = TERMINAL_CONTRACT.ticks
const TERMINAL_HASH_BLOCK_BYTES = 1024 * 1024

type TerminalWorkloadOptions = {
  durationMs?: number
  loadMiBS?: number
  ticks?: number
}

export async function createTerminalWorkload(
  runDirectory: string,
  stream: TerminalStream,
  options: TerminalWorkloadOptions = {},
) {
  const ordered = stream.chunks.toSorted((left, right) => left.sequence - right.sequence)
  ordered.forEach((chunk, index) => {
    if (chunk.sequence !== index) throw new Error(`terminal stream ${stream.id} sequence must be contiguous`)
  })
  const chunks = ordered.map((chunk) => Buffer.from(chunk.bytesBase64, "base64"))
  const cycle = Buffer.concat(chunks)
  if (cycle.byteLength === 0) throw new Error(`terminal stream ${stream.id} must contain output bytes`)
  const productionContract = Object.keys(options).length === 0 ? TERMINAL_CONTRACT : undefined
  if (productionContract) {
    const source = productionContract.sourceStream
    const sentinelsMatch = stream.inputSentinels.length === source.inputSentinels.length &&
      stream.inputSentinels.every((value, index) => value === source.inputSentinels[index])
    if (
      stream.id !== source.id ||
      cycle.byteLength !== source.expectedBytes ||
      createHash("sha256").update(cycle).digest("hex") !== source.expectedSha256 ||
      stream.expectedBytes !== source.expectedBytes ||
      stream.expectedSha256 !== source.expectedSha256 ||
      stream.columns !== source.columns ||
      stream.rows !== source.rows ||
      !sentinelsMatch
    ) throw new Error("terminal corpus stream does not match terminal-output-v1")
  }
  const durationMs = options.durationMs ?? TERMINAL_SUSTAINED_DURATION_MS
  const loadMiBS = options.loadMiBS ?? TERMINAL_SUSTAINED_LOAD_MIB_S
  const ticks = options.ticks ?? TERMINAL_SUSTAINED_TICKS
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("terminal workload duration must be positive")
  if (!Number.isFinite(loadMiBS) || loadMiBS <= 0) throw new Error("terminal workload load must be positive")
  if (!Number.isInteger(ticks) || ticks <= 0) throw new Error("terminal workload ticks must be a positive integer")
  const targetPayloadBytes = Math.ceil(loadMiBS * 1024 * 1024 * (durationMs / 1_000))
  const repeatCount = Math.ceil(targetPayloadBytes / cycle.byteLength)
  const sentinelAfterCycles = stream.inputSentinels.map((_, index) =>
    Math.max(1, Math.min(repeatCount - 1, Math.round(repeatCount * ((index + 1) / (stream.inputSentinels.length + 1))))),
  )
  if (new Set(sentinelAfterCycles).size !== sentinelAfterCycles.length) {
    throw new Error("terminal workload is too small to place every input sentinel")
  }
  const start = Buffer.from(TERMINAL_START_MARKER)
  const complete = Buffer.from(TERMINAL_COMPLETE_MARKER)
  const readyMarkers = stream.inputSentinels.map((sentinel) => Buffer.from(`\u001b[33m⟦input-ready:${sentinel}⟧\u001b[0m\r\n`))
  const echoes = stream.inputSentinels.map((sentinel) => Buffer.from(`\u001b[36m⟦input:${sentinel}⟧\u001b[0m\r\n`))
  const expectedSegments = function* (): Generator<Uint8Array> {
    yield start
    let sentinelIndex = 0
    for (let completed = 1; completed <= repeatCount; completed += 1) {
      yield cycle
      if (sentinelAfterCycles[sentinelIndex] !== completed) continue
      yield readyMarkers[sentinelIndex]!
      yield echoes[sentinelIndex]!
      sentinelIndex += 1
    }
    yield complete
  }
  const expectedBytes =
    start.byteLength + cycle.byteLength * repeatCount +
    readyMarkers.reduce((total, value) => total + value.byteLength, 0) +
    echoes.reduce((total, value) => total + value.byteLength, 0) + complete.byteLength
  const inputByteThresholds = sentinelAfterCycles.map((cycles) => start.byteLength + cycles * cycle.byteLength)
  const expectedSha256 = terminalChunkTreeHash(expectedSegments())
  if (productionContract && (
    repeatCount !== productionContract.repetitions ||
    expectedBytes !== productionContract.expectedWireBytes ||
    expectedSha256 !== productionContract.expectedWireSha256
  )) throw new Error("generated terminal wire stream does not match terminal-output-v1")
  const directory = path.join(runDirectory, "terminal-workloads")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const configPath = path.join(directory, `${safeName(stream.id)}.json`)
  const scriptPath = path.join(directory, "terminal-workload.mjs")
  await Promise.all([
    writeFile(configPath, JSON.stringify({
      chunks: ordered.map((chunk) => chunk.bytesBase64),
      sentinels: stream.inputSentinels,
      sentinelAfterCycles,
      repeatCount,
      durationMs,
      ticks,
      shutdownSentinel: "T3_TERMINAL_SHUTDOWN",
    }), { encoding: "utf8", mode: 0o600 }),
    writeFile(scriptPath, TERMINAL_CHILD_SOURCE, { encoding: "utf8", mode: 0o700 }),
  ])
  return {
    command: `stty -echo -opost; exec ${[shellQuote(process.execPath), shellQuote(scriptPath), shellQuote(configPath)].join(" ")}`,
    expectedBytes,
    expectedSha256,
    expectedSegments,
    inputByteThresholds,
    sustainedDurationMs: durationMs,
    offeredLoadMiBS: (cycle.byteLength * repeatCount) / 1024 / 1024 / (durationMs / 1_000),
    expectedModelHash: productionContract?.expectedModelSha256,
    expectedColumns: productionContract?.geometry.columns,
    expectedRows: productionContract?.geometry.rows,
    actualColumns: undefined as number | undefined,
    actualRows: undefined as number | undefined,
    geometryMatched: false,
    actualModelHash: undefined as string | undefined,
    modelMatched: false,
  }
}

function terminalChunkTreeHash(segments: Iterable<Uint8Array>) {
  let block = Buffer.allocUnsafe(TERMINAL_HASH_BLOCK_BYTES)
  let length = 0
  const root = createHash("sha256")
  const flush = () => {
    if (length === 0) return
    root.update(createHash("sha256").update(block.subarray(0, length)).digest())
    block = Buffer.allocUnsafe(TERMINAL_HASH_BLOCK_BYTES)
    length = 0
  }
  for (const segment of segments) {
    let offset = 0
    while (offset < segment.byteLength) {
      const count = Math.min(TERMINAL_HASH_BLOCK_BYTES - length, segment.byteLength - offset)
      block.set(segment.subarray(offset, offset + count), length)
      length += count
      offset += count
      if (length === TERMINAL_HASH_BLOCK_BYTES) flush()
    }
  }
  flush()
  return root.digest("hex")
}


function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function safeName(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128)
}

const TERMINAL_CHILD_SOURCE = String.raw`
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cycle = Buffer.concat(config.chunks.map((value) => Buffer.from(value, "base64")));
const sentinels = config.sentinels;
const sentinelAfterCycles = config.sentinelAfterCycles;
const repeatCount = config.repeatCount;
const durationMs = config.durationMs;
const ticks = config.ticks;
const shutdownSentinel = config.shutdownSentinel;
let nextSentinel = 0;
let completedCycles = 0;
let tick = 0;
let buffered = "";
let finished = false;
let waitingForInput = false;
let pumping = false;
const startedAt = performance.now();
const write = (bytes) => new Promise((resolve, reject) => {
  if (process.stdout.write(bytes)) {
    resolve();
    return;
  }
  const onDrain = () => { cleanup(); resolve(); };
  const onError = (error) => { cleanup(); reject(error); };
  const cleanup = () => {
    process.stdout.off("drain", onDrain);
    process.stdout.off("error", onError);
  };
  process.stdout.once("drain", onDrain);
  process.stdout.once("error", onError);
});
const schedule = () => {
  if (finished || waitingForInput) return;
  const dueAt = startedAt + (tick + 1) * (durationMs / ticks);
  setTimeout(() => void pump(), Math.max(0, dueAt - performance.now()));
};
const finish = async () => {
  await write(Buffer.from("\u001b[32m⟦t3-benchmark-complete⟧\u001b[0m\r\n", "utf8"));
  finished = true;
};
const pump = async () => {
  if (pumping || finished || waitingForInput) return;
  pumping = true;
  try {
    const targetCycles = Math.ceil(((tick + 1) / ticks) * repeatCount);
    while (completedCycles < targetCycles && completedCycles < repeatCount) {
      if (sentinelAfterCycles[nextSentinel] === completedCycles) {
        waitingForInput = true;
        await write(Buffer.from("\u001b[33m⟦input-ready:" + sentinels[nextSentinel] + "⟧\u001b[0m\r\n", "utf8"));
        return;
      }
      await write(cycle);
      completedCycles += 1;
    }
    if (sentinelAfterCycles[nextSentinel] === completedCycles) {
      waitingForInput = true;
      await write(Buffer.from("\u001b[33m⟦input-ready:" + sentinels[nextSentinel] + "⟧\u001b[0m\r\n", "utf8"));
      return;
    }
    tick += 1;
    if (completedCycles >= repeatCount) await finish();
    else schedule();
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 2;
    process.stdin.pause();
  } finally {
    pumping = false;
  }
};
void (async () => {
  await write(Buffer.from("\u001bc", "utf8"));
  await write(Buffer.from("⟦t3-benchmark-start⟧\r\n", "utf8"));
  schedule();
})();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (value) => {
  buffered += value;
  void (async () => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const received = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (finished) {
        if (received === shutdownSentinel) {
          process.exitCode = 0;
          process.stdin.pause();
        }
        return;
      }
      const expected = sentinels[nextSentinel];
      if (!waitingForInput || received !== expected) {
        process.stderr.write("Unexpected terminal sentinel\n");
        process.exitCode = 2;
        process.stdin.pause();
        return;
      }
      await write(Buffer.from("\u001b[36m⟦input:" + received + "⟧\u001b[0m\r\n", "utf8"));
      nextSentinel += 1;
      waitingForInput = false;
      schedule();
    }
  })();
});
`
