import { WorkerPoolManager } from "@pierre/diffs/worker"
import ShikiWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"
import { createDisclosurePool } from "./disclosure-pool"

export type WorkerPoolStyle = "unified" | "split"

export function workerFactory(): Worker {
  return new Worker(ShikiWorkerUrl, { type: "module" })
}

function createPool(lineDiffType: "none" | "word-alt") {
  const pool = new WorkerPoolManager(
    {
      workerFactory,
      // poolSize defaults to 8. More workers = more parallelism but
      // also more memory. Too many can actually slow things down.
      // NOTE: 2 is probably better for OpenCode, as I think 8 might be
      // a bit overkill, especially because Safari has a significantly slower
      // boot up time for workers
      poolSize: 2,
    },
    {
      theme: "OpenCode",
      lineDiffType,
      preferredHighlighter: "shiki-wasm",
    },
  )

  return pool
}

const pools = {
  unified: createDisclosurePool(() => createPool("none")),
  split: createDisclosurePool(() => createPool("word-alt")),
}

function styleKey(style: WorkerPoolStyle | undefined): WorkerPoolStyle {
  return style === "split" ? "split" : "unified"
}

/** Acquires a disclosure-owned pool. The final release terminates workers after synchronous cleanup. */
export function acquireWorkerPool(style: WorkerPoolStyle | undefined) {
  const lease = pools[styleKey(style)].acquire(typeof window !== "undefined")
  return { pool: lease.resource, release: lease.release }
}

/** Compatibility accessor. New renderers should hold an acquireWorkerPool lease. */
export function getWorkerPool(style: WorkerPoolStyle | undefined): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return
  return pools[styleKey(style)].get()
}

export function getWorkerPools() {
  return {
    unified: getWorkerPool("unified"),
    split: getWorkerPool("split"),
  }
}

export function inspectWorkerPools() {
  return {
    unified: pools.unified.inspect(),
    split: pools.split.inspect(),
  }
}
