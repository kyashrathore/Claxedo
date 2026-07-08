import { describe, expect, test } from "bun:test"
import type { Project } from "@opencode-ai/sdk/v2/client"
import { applyGlobalProjectEvent } from "./global-event-projector"

const project = (id: string, title = id) => ({ id, title }) as Project

describe("global event shell projector", () => {
  test("refreshes global inventory for connection lifecycle events", () => {
    const refreshes: string[] = []

    applyGlobalProjectEvent({
      event: { type: "server.connected" },
      project: [],
      refresh: () => refreshes.push("refresh"),
      setGlobalProject: () => {
        throw new Error("project update should not run")
      },
    })
    applyGlobalProjectEvent({
      event: { type: "global.disposed" },
      project: [],
      refresh: () => refreshes.push("refresh"),
      setGlobalProject: () => {
        throw new Error("project update should not run")
      },
    })

    expect(refreshes).toEqual(["refresh", "refresh"])
  })

  test("upserts project updates without relying on upstream global-sync reducer", () => {
    let projects = [project("p1", "One"), project("p3", "Three")]
    const apply = (event: { type: string; properties?: unknown }) =>
      applyGlobalProjectEvent({
        event,
        project: projects,
        refresh: () => {
          throw new Error("refresh should not run")
        },
        setGlobalProject: (next) => {
          projects = typeof next === "function" ? next(projects) : next
        },
      })

    apply({ type: "project.updated", properties: project("p2", "Two") })
    apply({ type: "project.updated", properties: project("p1", "One updated") })

    expect(projects.map((item) => [item.id, item.title])).toEqual([
      ["p1", "One updated"],
      ["p2", "Two"],
      ["p3", "Three"],
    ])
  })
})
