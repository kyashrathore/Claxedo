/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createComputed, createRoot, createSignal } from "solid-js"
import { createRequestedFiles, MAX_REQUESTED_FILES } from "./requested-files"

function observed(scopeKey: () => string) {
  return createRoot((dispose) => {
    const requested = createRequestedFiles(scopeKey)
    const seen: (readonly string[])[] = []
    createComputed(() => seen.push(requested.files()))
    return { requested, seen, dispose }
  })
}

test("a request that leaves the list as it is notifies no reader", () => {
  const { requested, seen, dispose } = observed(() => "working-tree")
  requested.request(["a.ts", "b.ts"])
  expect(seen).toEqual([[], ["a.ts", "b.ts"]])

  requested.request(["a.ts", "b.ts"])
  requested.request(["a.ts"])
  expect(seen).toHaveLength(2)

  requested.request(["b.ts"])
  expect(seen.at(-1)).toEqual(["b.ts", "a.ts"])
  dispose()
})

test("the list keeps the most recent files first and at most the cap", () => {
  const { requested, dispose } = observed(() => "working-tree")
  const files = Array.from({ length: MAX_REQUESTED_FILES + 6 }, (_, index) => `f${index}.ts`)
  requested.request(files)
  expect(requested.files()).toEqual(files.slice(0, MAX_REQUESTED_FILES))

  requested.request(["new.ts", "f3.ts"])
  expect(requested.files()).toEqual(["new.ts", "f3.ts", ...files.slice(0, MAX_REQUESTED_FILES).filter((file) => file !== "f3.ts").slice(0, MAX_REQUESTED_FILES - 2)])
  dispose()
})

test("another scope starts a fresh list", () => {
  const [scope, setScope] = createSignal("working-tree")
  const { requested, dispose } = observed(scope)
  requested.request(["a.ts"])
  setScope("staged")
  expect(requested.files()).toEqual([])
  requested.request(["b.ts"])
  expect(requested.files()).toEqual(["b.ts"])
  dispose()
})
