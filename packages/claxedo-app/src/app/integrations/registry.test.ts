import { describe, expect, test } from "bun:test"
import { contributionGateAllows, createContributionRegistry, trustedAgentContributionBundleFromEvent } from "./registry"
import type { SessionRef } from "@/platform/identity/session-ref"

describe("contribution registry gates", () => {
  test("registers lease-bound agent contributions across the same registry", () => {
    const registry = createContributionRegistry()

    registry.addTrustedAgentContributions({
      lease: { leaseId: "lease_1", agentId: "agent_1", expiresAt: 123 },
      surfaces: [{
        id: "agent.surface.review",
        surface: "review-panel",
        slot: "side",
        gate: { backing: "real" },
      }],
      commands: [{
        id: "agent.review",
        title: "Review Session",
        handler: () => undefined,
      }],
      toolbar: [{
        id: "agent.toolbar.review",
        command: "agent.review",
        slot: "session-toolbar",
      }],
      menus: [{
        id: "agent.menu.review",
        command: "agent.review",
        slot: "session-menu",
        menu: "session",
      }],
      renderers: [{
        id: "agent.renderer.markdown",
        kind: "message-part",
      }],
      settings: [{
        id: "agent.settings.review",
        section: "agents",
      }],
    })

    expect(registry.trustedAgentContributions().surfaces.map((item) => item.id)).toEqual(["agent.surface.review"])
    expect(registry.trustedAgentCommands().map((item) => item.id)).toEqual(["agent.review"])
    expect(registry.trustedAgentContributions().toolbar.map((item) => item.id)).toEqual(["agent.toolbar.review"])
    expect(registry.trustedAgentContributions().menus.map((item) => item.id)).toEqual(["agent.menu.review"])
    expect(registry.trustedAgentContributions().renderers.map((item) => item.id)).toEqual(["agent.renderer.markdown"])
    expect(registry.trustedAgentContributions().settings.map((item) => item.id)).toEqual(["agent.settings.review"])
    expect(registry.command("agent.review")?.lease).toEqual({ leaseId: "lease_1", agentId: "agent_1", expiresAt: 123 })
  })

  test("renews lease-bound agent contributions by id", () => {
    const registry = createContributionRegistry()

    registry.addTrustedAgentContributions({
      lease: { leaseId: "lease_old", agentId: "agent_1" },
      surfaces: [{ id: "agent.surface.review", surface: "review-panel" }],
    })
    registry.addTrustedAgentContributions({
      lease: { leaseId: "lease_new", agentId: "agent_1" },
      surfaces: [{ id: "agent.surface.review", surface: "review-panel", slot: "right" }],
    })

    expect(registry.trustedAgentContributions().surfaces).toEqual([{
      id: "agent.surface.review",
      tier: "lease-bound-agent",
      lease: { leaseId: "lease_new", agentId: "agent_1" },
      surface: "review-panel",
      slot: "right",
    }])
  })

  test("loads trusted agent contribution event payloads into the shared registry", () => {
    const registry = createContributionRegistry()
    const bundle = trustedAgentContributionBundleFromEvent({
      type: "trusted-agent.contributions.register",
      properties: {
        lease: { leaseId: "lease_evt", agentId: "agent_evt" },
        surfaces: [{
          id: "agent.surface.context",
          surface: "context",
          gate: { hosting: "workspace", backing: "real" },
        }],
        commands: [{
          id: "agent.context.summarize",
          title: "Summarize Context",
          category: "Agent",
        }],
      },
    })

    expect(bundle?.lease).toEqual({ leaseId: "lease_evt", agentId: "agent_evt" })
    if (bundle) registry.addTrustedAgentContributions(bundle)
    expect(registry.trustedAgentContributions().surfaces).toMatchObject([{
      id: "agent.surface.context",
      tier: "lease-bound-agent",
      lease: { leaseId: "lease_evt", agentId: "agent_evt" },
      gate: { hosting: "workspace", backing: "real" },
    }])
    expect(registry.trustedAgentCommands().map((command) => ({
      id: command.id,
      title: command.title,
      lease: command.lease,
    }))).toEqual([{
      id: "agent.context.summarize",
      title: "Summarize Context",
      lease: { leaseId: "lease_evt", agentId: "agent_evt" },
    }])
  })

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
      toolSandbox: { kind: "workspace", workspaceId: "ws_authz", hosting: "cloud" },
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
