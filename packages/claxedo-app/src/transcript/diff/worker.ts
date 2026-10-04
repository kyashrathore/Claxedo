import { WorkerPoolManager } from "@pierre/diffs/worker"
import ShikiWorkerUrl from "@pierre/diffs/worker/worker.js?worker&url"
import { codeTheme } from "../code-theme"

export type WorkerPoolStyle = "unified" | "split"

export function workerFactory(): Worker {
  return new Worker(ShikiWorkerUrl, { type: "module" })
}

function createPool(lineDiffType: "none" | "word-alt") {
  const pool = new WorkerPoolManager(
    {
      workerFactory,
      poolSize: 2,
    },
    {
      theme: codeTheme.name,
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
  if (typeof window === "undefined") return undefined

  if (style === "split") {
    if (!split) split = createPool("word-alt")
    return split
  }

  if (!unified) unified = createPool("none")
  return unified
}

export function getFileWorkerPool(): WorkerPoolManager | undefined {
  if (typeof window === "undefined") return undefined
  return unified ?? split ?? getWorkerPool("unified")
}
