import { describe, expect, test } from "vitest"
import type { PluginBackendActivation, PluginBackendState } from "./activations"
import { PluginBackendRuns, type PluginDispatch } from "./runs"

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** The row at `epoch`, active unless `active` is false; every epoch here runs the same configuration. */
function state(epoch: number, active = true): PluginBackendState {
  return active ? { epoch, activation: activation(epoch) } : { epoch }
}

function activation(epoch: number): PluginBackendActivation {
  return {
    orgId: "org_1",
    pluginId: "counter",
    epoch,
    bundleHash: "a".repeat(64),
    generation: "same-configuration",
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
  const reads: Deferred<PluginBackendState>[] = []
  const loads: Deferred<string | undefined>[] = []
  const aborted: string[] = []
  const runs = new PluginBackendRuns<string>({
    readState: () => {
      const read = deferred<PluginBackendState>()
      reads.push(read)
      return read.promise
    },
    loadWorker: (loading) => {
      const load = deferred<string | undefined>()
      loads.push(load)
      return load.promise.then((worker) => worker && `${worker}@${loading.epoch}`)
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
  test("a newer epoch ends the previous run and aborts its facets", async () => {
    const { runs, reads, loads, aborted, dispatch, settle } = harness()
    const first = runs.dispatch("counter", dispatch)
    await settle()
    reads[0].resolve(state(1))
    await settle()
    loads[0].resolve("worker")
    expect(await first).toBe("sent:worker@1")

    const refresh = runs.current("counter")
    await settle()
    reads[1].resolve(state(2))
    expect((await refresh)?.activation.epoch).toBe(2)
    expect(aborted).toEqual(["facet:worker@1"])
  })

  test("a read that started earlier never replaces one that started later", async () => {
    const { runs, reads, aborted, settle } = harness()
    const older = runs.current("counter")
    const newer = runs.current("counter")
    await settle()
    reads[1].resolve(state(2))
    expect((await newer)?.activation.epoch).toBe(2)
    reads[0].resolve(state(1))
    expect((await older)?.activation.epoch).toBe(2)
    expect(aborted).toEqual([])
  })

  test("work that resumes after its run was replaced starts nothing on it and runs on the current one", async () => {
    const { runs, reads, loads, sent, aborted, dispatch, settle } = harness()
    const request = runs.dispatch("counter", dispatch)
    await settle()
    reads[0].resolve(state(1))
    await settle()
    const refresh = runs.current("counter")
    await settle()
    reads[1].resolve(state(2))
    await refresh
    loads[0].resolve("worker")
    await settle()
    reads[2].resolve(state(2))
    await settle()
    loads[1].resolve("worker")
    expect(await request).toBe("sent:worker@2")
    expect(sent).toEqual(["worker@2"])
    expect(aborted).toEqual([])
  })

  test("work that resumes after deactivation starts no facet", async () => {
    const { runs, reads, loads, sent, dispatch, settle } = harness()
    const request = runs.dispatch("counter", dispatch)
    await settle()
    reads[0].resolve(state(1))
    await settle()
    const refresh = runs.current("counter")
    await settle()
    reads[1].resolve(state(2, false))
    await refresh
    loads[0].resolve("worker")
    await settle()
    reads[2].resolve(state(2, false))
    expect(await request).toBe("inactive")
    expect(sent).toEqual([])
  })

  test("work suspended across a deactivation and an identical reactivation runs only on the new epoch", async () => {
    const { runs, reads, loads, sent, aborted, dispatch, settle } = harness()
    const request = runs.dispatch("counter", dispatch)
    await settle()
    reads[0].resolve(state(1))
    await settle()
    const deactivate = runs.current("counter")
    await settle()
    reads[1].resolve(state(2, false))
    await deactivate
    const reactivate = runs.current("counter")
    await settle()
    reads[2].resolve(state(3))
    await reactivate
    loads[0].resolve("worker")
    await settle()
    reads[3].resolve(state(3))
    await settle()
    loads[1].resolve("worker")
    expect(await request).toBe("sent:worker@3")
    expect(sent).toEqual(["worker@3"])
    expect(aborted).toEqual([])
    const stale = runs.admits("counter", 1)
    await settle()
    reads[4].resolve(state(3))
    expect(await stale).toBe(false)
  })

  test("a missing bundle is read again on the next dispatch", async () => {
    const { runs, reads, loads, dispatch, settle } = harness()
    const first = runs.dispatch("counter", dispatch)
    await settle()
    reads[0].resolve(state(1))
    await settle()
    loads[0].resolve(undefined)
    expect(await first).toBe("unavailable")
    const second = runs.dispatch("counter", dispatch)
    await settle()
    reads[1].resolve(state(1))
    await settle()
    loads[1].resolve("worker")
    expect(await second).toBe("sent:worker@1")
  })

  test("admits only the current generation", async () => {
    const { runs, reads, settle } = harness()
    const current = runs.admits("counter", 1)
    const stale = runs.admits("counter", 0)
    await settle()
    reads[0].resolve(state(1))
    reads[1].resolve(state(1))
    expect(await current).toBe(true)
    expect(await stale).toBe(false)
  })
})
