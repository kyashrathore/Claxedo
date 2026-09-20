import { describe, expect, test } from "bun:test"
import { contributionGateAllows, createContributionRegistry } from "./registry"
import type { SessionRef } from "@/platform/identity/session-ref"

describe("contribution registry gates", () => {
  test("requires real backing for workspace-scoped surfaces", () => {
    const centralAuthzOnly: SessionRef = {
      sessionId: "ses_authz",
      host: "central",
      workspaceId: "ws_authz",
      toolSandbox: { kind: "virtual" },
    }
    const workspaceBacked: SessionRef = {
      sessionId: "ses_workspace",
      host: "workspace",
      workspaceId: "ws_authz",
      toolSandbox: { kind: "workspace", workspaceId: "ws_authz", hosting: "provisioner" },
    }
    const registry = createContributionRegistry()
    registry.addSurface({
      id: "surface.workspace.terminal",
      tier: "claxedo-first-party",
      surface: "terminal",
      gate: { workspaceId: "ws_authz", backing: "real" },
    })

    expect(registry.visibleSurfaces({ sessionRef: centralAuthzOnly })).toEqual([])
    expect(registry.visibleSurfaces({ sessionRef: workspaceBacked }).map((surface) => surface.id)).toEqual([
      "surface.workspace.terminal",
    ])
  })

  test("removes a surface by id, leaving the rest in order", () => {
    // `addSurface` had no counterpart, so a contribution registered at runtime
    // stayed registered for the life of the page. Hosted contributions are
    // registered on sign-in and have to come back out on sign-out.
    const registry = createContributionRegistry()
    const surface = (id: string) => ({ id, tier: "claxedo-first-party" as const, surface: id })
    for (const id of ["a", "b", "c"]) registry.addSurface(surface(id))

    registry.removeSurface("b")

    expect(registry.all().surfaces.map((item) => item.id)).toEqual(["a", "c"])
  })

  test("removing an id it never held changes nothing", () => {
    const registry = createContributionRegistry()
    registry.addSurface({ id: "a", tier: "claxedo-first-party", surface: "a" })

    registry.removeSurface("absent")

    expect(registry.all().surfaces.map((item) => item.id)).toEqual(["a"])
  })

  test("treats hosting and role gates as explicit placement constraints", () => {
    expect(contributionGateAllows(
      { hosting: "workspace", role: "editor" },
      {
        sessionRef: {
          sessionId: "ses_1",
          host: "workspace",
          toolSandbox: { kind: "local", cwd: "/repo" },
        },
        role: "viewer",
      },
    )).toBe(false)
    expect(contributionGateAllows(
      { hosting: "workspace", role: "editor" },
      {
        sessionRef: {
          sessionId: "ses_1",
          host: "workspace",
          toolSandbox: { kind: "local", cwd: "/repo" },
        },
        role: "admin",
      },
    )).toBe(true)
  })
})
