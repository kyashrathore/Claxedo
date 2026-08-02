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

  test("ignores an engine project.updated that would duplicate a worktree the control plane owns", () => {
    // The embedded engine reports the same worktree under a hashed id. Inserting
    // it leaves two projects for one directory, and its payload has no name and
    // no workspaces — worktree-keyed consumers then render the basename with no
    // sessions.
    const worktree = "/Users/me/opencode"
    const projects = [
      { id: "ws-uuid", worktree, name: "Claxedo", workspaces: { "ws-uuid": {} } } as Project,
    ]

    applyGlobalProjectEvent({
      event: {
        type: "project.updated",
        properties: { id: "ee9452087e23bf5d5c78b90f6ae74ef692a26b68", worktree, vcs: "git" },
      },
      project: projects,
      refresh: () => {
        throw new Error("refresh should not run")
      },
      setGlobalProject: () => {
        throw new Error("duplicate worktree should not be inserted")
      },
    })

    expect(projects.map((item) => item.id)).toEqual(["ws-uuid"])
  })

  test("still inserts a project whose worktree is not represented yet", () => {
    let projects = [{ id: "a", worktree: "/w/a" } as Project]

    applyGlobalProjectEvent({
      event: { type: "project.updated", properties: { id: "b", worktree: "/w/b" } as Project },
      project: projects,
      refresh: () => {
        throw new Error("refresh should not run")
      },
      setGlobalProject: (next) => {
        projects = typeof next === "function" ? next(projects) : next
      },
    })

    expect(projects.map((item) => item.id)).toEqual(["a", "b"])
  })
})
