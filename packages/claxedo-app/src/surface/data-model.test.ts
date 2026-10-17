/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { createEffect, createRoot, indexArray } from "solid-js"
import { createSurfaceData } from "./data-model"
import { parsePointer, resolvePath, itemScope } from "./data-path"
import { readDynamic } from "./binding"
import { SurfaceMessageError, type SurfaceData } from "./model"

function items(count: number) {
  return Array.from({ length: count }, (_, index) => ({ title: `item ${index}`, done: false }))
}

function seeded(value: Record<string, unknown>): SurfaceData {
  const data = createSurfaceData()
  data.write([], value as never)
  return data
}

function countRuns(data: SurfaceData, readers: readonly (() => unknown)[]) {
  return createRoot((dispose) => {
    const runs = readers.map(() => 0)
    readers.forEach((read, index) =>
      createEffect(() => {
        read()
        runs[index] += 1
      }),
    )
    return { runs, dispose }
  })
}

describe("upserts", () => {
  test("an upsert creates the intermediate objects it needs", () => {
    const data = createSurfaceData()
    data.write(parsePointer("/user/address/city"), "Lyon")
    expect(data.snapshot([])).toEqual({ user: { address: { city: "Lyon" } } })
  })

  test("an upsert replaces an object rather than merging into it", () => {
    const data = seeded({ user: { name: "Ada", role: "admin" } })
    data.write(["user"], { name: "Grace" })
    expect(data.snapshot(["user"])).toEqual({ name: "Grace" })
  })

  test("an upsert can turn an object into a list", () => {
    const data = seeded({ value: { a: 1 } })
    data.write(["value"], [1, 2])
    expect(data.snapshot(["value"])).toEqual([1, 2])
  })

})

describe("deletes and whole-model writes", () => {
  test("a write with no value deletes the key", () => {
    const data = seeded({ name: "api", region: "eu" })
    data.write(["region"], undefined)
    expect(data.snapshot([])).toEqual({ name: "api" })
  })

  test("a write with no value removes a list element and closes the gap", () => {
    const data = seeded({ items: ["a", "b", "c"] })
    data.write(parsePointer("/items/1"), undefined)
    expect(data.snapshot(["items"])).toEqual(["a", "c"])
  })

  test("deleting a missing key or index changes nothing", () => {
    const data = seeded({ items: ["a"] })
    data.write(parsePointer("/items/7"), undefined)
    data.write(parsePointer("/missing/key"), undefined)
    expect(data.snapshot([])).toEqual({ items: ["a"] })
  })

  test("a write at / replaces the whole model, and no value empties it", () => {
    const data = seeded({ a: 1, b: 2 })
    data.write([], { b: 3, c: 4 })
    expect(data.snapshot([])).toEqual({ b: 3, c: 4 })
    data.write([], undefined)
    expect(data.snapshot([])).toEqual({})
  })

})

describe("the whole model", () => {
  test("the model at / must be an object", () => {
    const data = createSurfaceData()
    expect(() => data.write([], [1, 2])).toThrow(SurfaceMessageError)
    expect(() => data.write([], "text")).toThrow(SurfaceMessageError)
  })

  test("a snapshot is detached from later writes", () => {
    const data = seeded({ form: { name: "api" } })
    const before = data.snapshot(["form"])
    data.write(["form", "name"], "web")
    expect(before).toEqual({ name: "api" })
  })
})

describe("fine-grained reactivity of a patch", () => {
  test("a patch to /items/3/title re-runs only the binding that reads it", () => {
    const data = seeded({ items: items(200), heading: "List" })
    const readers = [
      ...Array.from({ length: 200 }, (_, index) => () => readDynamic({ path: "title" }, itemScope(["items"], index), data)),
      () => readDynamic({ path: "/heading" }, [], data),
      () => data.read(resolvePath("/items/3/done", [])),
    ]
    const counted = countRuns(data, readers)
    data.write(parsePointer("/items/3/title"), "renamed")
    expect(counted.runs[3]).toBe(2)
    expect(counted.runs.reduce((sum, runs) => sum + runs, 0)).toBe(readers.length + 1)
    expect(readDynamic({ path: "title" }, itemScope(["items"], 3), data)).toBe("renamed")
    counted.dispose()
  })

  test("a whole-model replace re-runs only the bindings whose value changed", () => {
    const data = seeded({ items: items(5), heading: "List" })
    const readers = Array.from({ length: 5 }, (_, index) => () => data.read(["items", String(index), "title"]))
    const counted = countRuns(data, [...readers, () => data.read(["heading"])])
    const next = items(5)
    next[2].title = "changed"
    data.write([], { items: next, heading: "List" })
    expect(counted.runs).toEqual([1, 1, 2, 1, 1, 1])
    counted.dispose()
  })

})

describe("fine-grained reactivity of lists", () => {
  test("editing an item does not re-run a reader of the list itself", () => {
    const data = seeded({ items: items(3) })
    const counted = countRuns(data, [() => (data.read(["items"]) as unknown[]).length])
    data.write(["items", "1", "title"], "edited")
    expect(counted.runs).toEqual([1])
    data.write(["items", "3"], { title: "new", done: false })
    expect(counted.runs).toEqual([2])
    counted.dispose()
  })

  test("a template over the list keeps every item when one item's field changes, and adds one item for an append", () => {
    const data = seeded({ items: items(200) })
    const counts = { mapped: 0, titleRuns: 0 }
    const dispose = createRoot((dispose) => {
      const rows = indexArray(
        () => data.read(["items"]) as unknown[],
        (_, index) => {
          counts.mapped += 1
          createEffect(() => {
            readDynamic({ path: "title" }, itemScope(["items"], index), data)
            counts.titleRuns += 1
          })
          return index
        },
      )
      createEffect(() => rows())
      return dispose
    })
    expect(counts).toEqual({ mapped: 200, titleRuns: 200 })
    data.write(parsePointer("/items/3/title"), "renamed")
    expect(counts).toEqual({ mapped: 200, titleRuns: 201 })
    data.write(parsePointer("/items/200"), { title: "new", done: false })
    expect(counts).toEqual({ mapped: 201, titleRuns: 202 })
    dispose()
  })
})
