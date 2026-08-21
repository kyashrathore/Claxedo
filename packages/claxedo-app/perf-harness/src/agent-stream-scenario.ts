import type { BenchmarkPage as Page } from "./agent-cdp-page"
import {
  beginStreamObservation,
  finishStreamObservation,
  measureSessionActivation,
  type SessionReadinessTarget,
} from "./agent-browser-observer"
import type { AgentAppCorpus } from "./agent-corpus-materializer"
import type { startFakeEngine } from "./agent-fake-engine"

type FakeEngine = Awaited<ReturnType<typeof startFakeEngine>>

type LifecycleEvent = {
  sequence?: unknown
  atMs?: unknown
  type?: unknown
}

/**
 * Streams the corpus stream turn through the app's REAL ingestion pipeline:
 * the app runs with OPENCODE_URL pointed at the harness's fake engine
 * (`agent-fake-engine.ts`), the scenario sends one real prompt through the
 * claxedo server, and the fake engine replays the corpus lifecycle events
 * over `/global/event` on the corpus timing — adapter -> runtime event hub ->
 * claxedo events -> renderer, the same seam the T3 arm fakes with its replay
 * server. Interaction probes (trusted ArrowDown presses) interleave on the
 * same schedule as before; Event Timing + LoAF observation is unchanged.
 */
export async function runControlledStreamScenario(input: {
  page: Page
  serverUrl: string
  workspaces: Map<string, { directory: string }>
  corpus: AgentAppCorpus
  materializedSessions: Map<string, string>
  readinessTargets: readonly SessionReadinessTarget[]
  fakeEngine: FakeEngine
}) {
  const session = input.corpus.sessions.toSorted((a, b) => a.order - b.order)[0]
  if (!session) throw new Error("controlled stream requires a corpus session")
  const home = input.workspaces.get(session.workspaceId ?? "")
  if (!home) throw new Error(`controlled stream session workspace is unknown: ${session.workspaceId ?? "(root)"}`)
  const events = (session.events as LifecycleEvent[])
    .filter((event) => Number.isFinite(event.atMs))
    .toSorted((left, right) => Number(left.sequence) - Number(right.sequence))
  if (events.length === 0) throw new Error("controlled stream requires lifecycle events")
  const contentEvents = events.filter((event) => event.type !== "stream-complete")
  const finalRevision = [...events]
    .reverse()
    .find((event): event is LifecycleEvent & { content: string } =>
      event.type === "message-part-revision" && typeof (event as { content?: unknown }).content === "string")

  const materializedSessionId = input.materializedSessions.get(session.id)
  if (!materializedSessionId) throw new Error(`controlled stream session was not materialized: ${session.id}`)
  if (materializedSessionId !== input.fakeEngine.streamSessionId) {
    throw new Error("fake engine targets a different stream session than the scenario")
  }
  const readinessTarget = input.readinessTargets.find((target) => target.sessionId === materializedSessionId)
  if (!readinessTarget) throw new Error(`controlled stream readiness target was not materialized: ${session.id}`)
  await measureSessionActivation(input.page, readinessTarget)
  await beginStreamObservation(input.page)

  // Fire the prompt through the app's own server surface; the route blocks
  // for the whole turn, so hold the promise while probing.
  const promptUrl = new URL(`/session/${encodeURIComponent(materializedSessionId)}/message`, input.serverUrl)
  promptUrl.searchParams.set("directory", home.directory)
  const promptPromise = fetch(promptUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "benchmark stream replay" }] }),
  })

  // Align the probe clock to the moment the fake engine starts replaying.
  const promptDeadline = performance.now() + 30_000
  while (!input.fakeEngine.promptReceived()) {
    if (performance.now() > promptDeadline) {
      throw new Error("stream prompt never reached the fake engine (prompt_async not called)")
    }
    await Bun.sleep(25)
  }

  const durationMs = Math.max(...events.map((event) => Number(event.atMs)))
  const probeCount = 40
  const startedAtMs = performance.now()
  for (let index = 0; index < probeCount; index++) {
    const atMs = Math.round(((index + 0.5) / probeCount) * Math.max(durationMs, probeCount))
    const remaining = startedAtMs + atMs - performance.now()
    if (remaining > 0) await Bun.sleep(remaining)
    await input.page.keyboard.press("ArrowDown")
  }
  await input.fakeEngine.replayFinished()

  if (finalRevision) {
    const tail = finalRevision.content.slice(-128)
    await input.page.waitForFunction((expected) => document.body.textContent?.includes(expected), tail)
  }
  await input.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  const result = await finishStreamObservation(input.page)
  // The prompt turn should settle once the fake emits its terminal event;
  // don't let a hung turn wedge the scenario, but record it in validity.
  const promptSettled = await Promise.race([
    promptPromise.then((response) => response.ok, () => false),
    Bun.sleep(15_000).then(() => false),
  ])
  const emitted = input.fakeEngine.emissions().filter((entry) => entry.type === "message.part.updated").length
  const actualProbeCount = result.evidence?.probeCount ?? 0
  return {
    ...result,
    validity: {
      expectedEvents: contentEvents.length,
      actualEvents: emitted,
      expectedProbes: probeCount,
      actualProbes: actualProbeCount,
      finalContentMatched: finalRevision !== undefined && promptSettled,
    },
  }
}
