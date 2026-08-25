import { WorkerPoolManager } from "@pierre/diffs/worker"
import ShikiWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"

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

  void pool.initialize()
  return pool
}

let unified: WorkerPoolManager | undefined
let split: WorkerPoolManager | undefined

export function getWorkerPool(style: WorkerPoolStyle | undefined): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return

  if (style === "split") {
    if (!split) split = createPool("word-alt")
    return split
  }

  if (!unified) unified = createPool("none")
  return unified
}

/**
 * The pool for a surface that highlights a WHOLE FILE rather than a diff.
 *
 * The two pools above differ in exactly one render option, `lineDiffType`, and
 * that option is read in exactly one place inside `@pierre/diffs`:
 * `computeLineDiffDecorations`, on the deletion/addition line pair of a DIFF.
 * A whole-file highlight (`getPlainFileAST` / `highlightFileAST`) never reaches
 * it, so for a file viewer the two pools are interchangeable.
 *
 * Asking for a specific style therefore does not select behaviour — it only
 * decides whether the surface reuses a pool the app has already built or boots
 * a second one. Booting is not cheap: `getPlainFileAST` returns nothing until
 * `initialize()` has resolved the shiki highlighter, so a cold pool means the
 * viewer's first render draws NOTHING and re-runs itself a few hundred
 * milliseconds later, off the interaction that opened the file. The workspace
 * panel makes that the normal case: Review warms the pool for ITS diff style
 * (`split` above the md breakpoint), and a file tab that insisted on `unified`
 * then paid a second worker boot plus a second wasm load for a distinction that
 * does not apply to it.
 */
export function getFileWorkerPool(): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return
  return unified ?? split ?? getWorkerPool("unified")
}

export function getWorkerPools() {
  return {
    unified: getWorkerPool("unified"),
    split: getWorkerPool("split"),
  }
}
