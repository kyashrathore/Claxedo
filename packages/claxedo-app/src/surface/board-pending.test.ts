/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { SURFACE_CATALOG_ID } from "@claxedo/plugin-api/surface"
import { arrangeBoard, patchSettlesMove, type BoardLaneSource, type BoardMove } from "./board-pending"
import { surfaceState } from "./model"
import { createSurface } from "./store"

const sources: readonly BoardLaneSource[] = [
  { key: "todo", path: ["lanes", "todo"], items: [{ id: "a" }, { id: "b" }, { id: 7 }] },
  { key: "done", path: ["lanes", "done"], items: [{ id: "d" }] },
  { key: "later", path: ["later"], items: [] },
]

const ids = (lanes: ReturnType<typeof arrangeBoard>) => lanes.map((lane) => [lane.key, lane.entries.map((entry) => entry.id)])

describe("arrangeBoard", () => {
  test("keys each item by its itemKey field and keeps its own data path as its scope", () => {
    const lanes = arrangeBoard(sources, "id", undefined)
    expect(ids(lanes)).toEqual([["todo", ["a", "b", "7"]], ["done", ["d"]], ["later", []]])
    expect(lanes[0]?.entries[2]).toEqual({ id: "7", path: ["lanes", "todo", "2"], keyed: true })
  })

  test("draws a pending move at its target while each item keeps its own data path", () => {
    const move: BoardMove = { itemId: "b", fromColumn: "todo", fromIndex: 1, toColumn: "done", toIndex: 0 }
    const lanes = arrangeBoard(sources, "id", move)
    expect(ids(lanes)).toEqual([["todo", ["a", "7"]], ["done", ["b", "d"]], ["later", []]])
    expect(lanes[1]?.entries[0]?.path).toEqual(["lanes", "todo", "1"])
  })

  test("reorders within one column and clamps a target index past the end", () => {
    expect(ids(arrangeBoard(sources, "id", { itemId: "a", fromColumn: "todo", fromIndex: 0, toColumn: "todo", toIndex: 9 }))[0]).toEqual(["todo", ["b", "7", "a"]])
  })

  test("an item without a key, or with a key seen before, is drawn but cannot move", () => {
    const lanes = arrangeBoard([{ key: "x", path: ["x"], items: [{ id: "a" }, { name: "no key" }, { id: "a" }] }], "id", { itemId: "x#1", fromColumn: "x", fromIndex: 1, toColumn: "x", toIndex: 0 })
    expect(lanes[0]?.entries).toEqual([
      { id: "a", path: ["x", "0"], keyed: true },
      { id: "x#1", path: ["x", "1"], keyed: false },
      { id: "x#2", path: ["x", "2"], keyed: false },
    ])
  })
})

describe("patchSettlesMove", () => {
  const move: BoardMove = { itemId: "b", fromColumn: "todo", fromIndex: 1, toColumn: "done", toIndex: 0 }

  test("a patch at, inside or above either column's item list settles the move", () => {
    for (const path of [["lanes", "todo"], ["lanes", "done", "0", "title"], ["lanes"], []]) expect(patchSettlesMove(path, move, sources)).toBe(true)
  })

  test("a patch to another column or another part of the model does not", () => {
    for (const path of [["later"], ["lanes", "doing"], ["query"]]) expect(patchSettlesMove(path, move, sources)).toBe(false)
  })
})

describe("the producer's patches", () => {
  test("reach a watcher with each updateDataModel's path, never for a local write, and stop once disposed", () => {
    const surface = createSurface("s1")
    surface.apply({ version: "v0.9", createSurface: { surfaceId: "s1", catalogId: SURFACE_CATALOG_ID } })
    const seen: string[][] = []
    const stop = surface[surfaceState].watchPatches((path) => void seen.push([...path]))
    surface.apply({ version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/lanes/todo", value: [] } })
    surface[surfaceState].data.write(["query"], "typed")
    surface.apply({ version: "v0.9", updateDataModel: { surfaceId: "s1", value: { lanes: {} } } })
    stop()
    surface.apply({ version: "v0.9", updateDataModel: { surfaceId: "s1", path: "/later", value: [] } })
    expect(seen).toEqual([["lanes", "todo"], []])
  })

  test("leave the data model alone: the renderer writes no move", () => {
    const surface = createSurface("s2")
    surface.apply({ version: "v0.9", createSurface: { surfaceId: "s2", catalogId: SURFACE_CATALOG_ID } })
    surface.apply({ version: "v0.9", updateDataModel: { surfaceId: "s2", value: { todo: [{ id: "a" }, { id: "b" }], done: [] } } })
    const before = surface[surfaceState].data.snapshot([])
    arrangeBoard(
      [
        { key: "todo", path: ["todo"], items: [{ id: "a" }, { id: "b" }] },
        { key: "done", path: ["done"], items: [] },
      ],
      "id",
      { itemId: "a", fromColumn: "todo", fromIndex: 0, toColumn: "done", toIndex: 0 },
    )
    expect(surface[surfaceState].data.snapshot([])).toEqual(before)
  })
})
