import { expect, test } from "bun:test"
import path from "node:path"
import { CURSOR_WORKER_ENV, requireCursorWorker } from "./cursor"

test("the Cursor worker resolves through the harness package and runs on this host's runtime", () => {
  expect(requireCursorWorker({})).toEqual({ file: process.execPath,
    args: [path.resolve(import.meta.dirname, "../../../../harness/src/transports/cursor-sdk/host.ts")] })
})

test("an explicit Cursor worker path wins and must exist", () => {
  expect(requireCursorWorker({ [CURSOR_WORKER_ENV]: import.meta.filename }).args).toEqual([import.meta.filename])
  expect(() => requireCursorWorker({ [CURSOR_WORKER_ENV]: path.join(import.meta.dirname, "missing-worker.js") })).toThrow(CURSOR_WORKER_ENV)
})
