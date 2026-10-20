/// <reference types="bun" />
import { expect, test } from "bun:test"
import { parseRoute, sameRoute } from "./routes"
import type { PageEntry } from "./types"

function page(id: string, path: string): PageEntry {
  return { id, path, title: () => id, icon: "checklist", sidebar: "main", view: () => null }
}

const settings = page("settings", "/settings/:section?")
const tasks = page("tasks", "/tasks/:taskId?")

test("routes: a page registered after boot leaves the route on another path the same", () => {
  for (const path of ["/", "/w/p1/session", "/w/p1/session/s1", "/s/s1", "/w/p1/terminal/t1", "/settings/models", "/nowhere"]) {
    expect(sameRoute(parseRoute(path, [settings], []), parseRoute(path, [settings, tasks], []))).toBe(true)
  }
})

test("routes: a path that the new page claims becomes a different route", () => {
  expect(sameRoute(parseRoute("/tasks", [settings], []), parseRoute("/tasks", [settings, tasks], []))).toBe(false)
})

test("routes: routes differ by placement, session, page and params", () => {
  expect(sameRoute(parseRoute("/w/p1/session", [], []), parseRoute("/w/p2/session", [], []))).toBe(false)
  expect(sameRoute(parseRoute("/w/p1/session/s1", [], []), parseRoute("/w/p1/session/s2", [], []))).toBe(false)
  expect(sameRoute(parseRoute("/tasks/t1", [tasks], []), parseRoute("/tasks/t2", [tasks], []))).toBe(false)
  expect(sameRoute(parseRoute("/tasks", [tasks], []), parseRoute("/settings", [settings], []))).toBe(false)
  expect(sameRoute(parseRoute("/w/p1/session", [], []), parseRoute("/", [], []))).toBe(false)
})
