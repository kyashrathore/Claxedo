import { describe, expect, test } from "vitest"
import type { PluginBackendActivation } from "./activations"
import { PluginBackendRuns, type PluginDispatch } from "./runs"

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function activation(generation: string): PluginBackendActivation {
  return {
    orgId: "org_1",
    pluginId: "counter",
    bundleHash: "a".repeat(64),
    generation,
    manifest: {
      id: "counter",
      name: "Counter",
      version: "0.1.0",
      app: "./app.js",
      requires: [],
      server: { routes: [], operations: [] },
      backend: { entry: "./backend.js", objects: ["Counter"], outbound: [], routes: ["GET /count"] },
    },
  }
}

/** Every activation read and Worker load waits until the test settles it. */
function harness() {
  const reads: Deferred<PluginBackendActivation | undefined>[] = []
  const loads: Deferred<string | undefined>[] = []
  const aborted: string[] = []
  const runs = new PluginBackendRuns<string>({
    readActivation: () => {
      const read = deferred<PluginBackendActivation | undefined>()
      reads.push(read)
      return read.promise
    },
    loadWorker: (loading) => {
      const load = deferred<string | undefined>()
      loads.push(load)
      return load.promise.then((worker) => worker && `${worker}@${loading.generation}`)
    },
    abortFacet: (facet) => aborted.push(facet),
  })
  const sent: string[] = []
  const dispatch: PluginDispatch<string, string> = {
    refuse: () => undefined,
    send: (worker, _activation, track) => {
      track(`facet:${worker}`)
      sent.push(worker)
      return `sent:${worker}`
    },
    inactive: () => "inactive",
    unavailable: () => "unavailable",
    changing: () => "changing",
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { runs, reads, loads, aborted, sent, dispatch, settle }
}

describe("plugin backend runs", () => {
  test("a changed generation ends the previous run and aborts its facets", async () => {
    const { runs, reads, loads, aborted, dispatch, settle } = harness()
    const first = runs.dispatch("counter", dispatch)
    await settle()
    reads[0]!.resolve(activation("g1"))
    await settle()
    loads[0]!.resolve("worker")
    expect(await first).toBe("sent:worker@g1")

    const refresh = runs.current("counter")
    await settle()
    reads[1]!.resolve(activation("g2"))
    expect((await refresh)?.activation.generation).toBe("g2")
    expect(aborted).toEqual(["facet:worker@g1"])
  })

  test("a read that started earlier never replaces one that started later", async () => {
    const { runs, reads, aborted, settle } = harness()
    const older = runs.current("counter")
    const newer = runs.current("counter")
    await settle()
    reads[1]!.resolve(activation("g2"))
    expect((await newer)?.activation.generation).toBe("g2")
    reads[0]!.resolve(activation("g1"))
    expect((await older)?.activation.generation).toBe("g2")
    expect(aborted).toEqual([])
  })

  test("work that resumes after its run was replaced starts nothing on it and runs on the current one", async () => {
    const { runs, reads, loads, sent, aborted, dispatch, settle } = harness()
    const request = runs.dispatch("counter", dispatch)
    await settle()
    reads[0]!.resolve(activation("g1"))
    await settle()
    const refresh = runs.current("counter")
    await settle()
    reads[1]!.resolve(activation("g2"))
    await refresh
    loads[0]!.resolve("worker")
    await settle()
    reads[2]!.resolve(activation("g2"))
    await settle()
    loads[1]!.resolve("worker")
    expect(await request).toBe("sent:worker@g2")
    expect(sent).toEqual(["worker@g2"])
    expect(aborted).toEqual([])
  })

  test("work that resumes after deactivation starts no facet", async () => {
    const { runs, reads, loads, sent, dispatch, settle } = harness()
    const request = runs.dispatch("counter", dispatch)
    await settle()
    reads[0]!.resolve(activation("g1"))
    await settle()
    const refresh = runs.current("counter")
    await settle()
    reads[1]!.resolve(undefined)
    await refresh
    loads[0]!.resolve("worker")
    await settle()
    reads[2]!.resolve(undefined)
    expect(await request).toBe("inactive")
    expect(sent).toEqual([])
  })

  test("a missing bundle is read again on the next dispatch", async () => {
    const { runs, reads, loads, dispatch, settle } = harness()
    const first = runs.dispatch("counter", dispatch)
    await settle()
    reads[0]!.resolve(activation("g1"))
    await settle()
    loads[0]!.resolve(undefined)
    expect(await first).toBe("unavailable")
    const second = runs.dispatch("counter", dispatch)
    await settle()
    reads[1]!.resolve(activation("g1"))
    await settle()
    loads[1]!.resolve("worker")
    expect(await second).toBe("sent:worker@g1")
  })

  test("admits only the current generation", async () => {
    const { runs, reads, settle } = harness()
    const current = runs.admits("counter", "g1")
    const stale = runs.admits("counter", "g0")
    await settle()
    reads[0]!.resolve(activation("g1"))
    reads[1]!.resolve(activation("g1"))
    expect(await current).toBe(true)
    expect(await stale).toBe(false)
  })
})
