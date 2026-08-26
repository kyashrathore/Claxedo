import { describe, expect, test } from "bun:test"
import { can, type Capability, type PrincipalCapability, type WorkspaceCapability } from "./role"
import type { RelayRole } from "./role"
import { placementFromWorkspaceConnection, signedCentralPlacement, type Placement } from "@/platform/runtime/placement"
import type { Principal } from "./identity-provider"

describe("role policy", () => {
  const workspaceCapabilities = [
    "read.workspace",
    "view.workspace-tools",
    "use.terminal",
    "mutate.session",
    "mutate.workspace",
    "manage.runners",
  ] satisfies WorkspaceCapability[]

  const workspaceMatrix = {
    owner: {
      "read.workspace": true,
      "view.workspace-tools": true,
      "use.terminal": true,
      "mutate.session": true,
      "mutate.workspace": true,
      "manage.runners": true,
    },
    admin: {
      "read.workspace": true,
      "view.workspace-tools": true,
      "use.terminal": true,
      "mutate.session": true,
      "mutate.workspace": true,
      "manage.runners": true,
    },
    editor: {
      "read.workspace": true,
      "view.workspace-tools": true,
      "use.terminal": true,
      "mutate.session": true,
      "mutate.workspace": false,
      "manage.runners": false,
    },
    viewer: {
      "read.workspace": true,
      "view.workspace-tools": true,
      "use.terminal": false,
      "mutate.session": false,
      "mutate.workspace": false,
      "manage.runners": false,
    },
  } satisfies Record<RelayRole, Record<WorkspaceCapability, boolean>>

  test("exhaustively gates workspace capabilities by relay role", () => {
    for (const role of Object.keys(workspaceMatrix) as RelayRole[]) {
      const placement: Placement = {
        workspaceId: "ws_1",
        hosting: "workspace",
        transport: "workspace-relay",
        role,
      }
      for (const capability of workspaceCapabilities) {
        expect(can(capability, placement)).toBe(workspaceMatrix[role][capability])
      }
    }
    expect(can("read.workspace", undefined)).toBe(false)
    const editor: Placement = {
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
      role: "editor",
    }
    expect(can("mutate.workspace", editor)).toBe(false)
  })

  const principalCapabilities = ["share.workspace", "view.account"] satisfies PrincipalCapability[]

  const principalMatrix = {
    anonymous: {
      "share.workspace": false,
      "view.account": true,
    },
    local: {
      "share.workspace": false,
      "view.account": false,
    },
    signed: {
      "share.workspace": true,
      "view.account": true,
    },
    "org-member": {
      "share.workspace": true,
      "view.account": true,
    },
  } satisfies Record<Principal["kind"], Record<PrincipalCapability, boolean>>

  test("exhaustively gates principal capabilities by principal kind", () => {
    const principals = {
      anonymous: { kind: "anonymous" },
      local: { kind: "local", deviceId: "local" },
      signed: { kind: "signed", userId: "usr_1" },
      "org-member": {
        kind: "org-member",
        userId: "usr_1",
        orgId: "org_1",
        memberships: [],
      },
    } satisfies Record<Principal["kind"], Principal>

    for (const kind of Object.keys(principalMatrix) as Principal["kind"][]) {
      for (const capability of principalCapabilities) {
        expect(can(capability, principals[kind])).toBe(principalMatrix[kind][capability])
      }
    }
  })

  test("fails closed for cross-axis capabilities and missing subjects", () => {
    const viewer: Placement = {
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
      role: "viewer",
    }
    const signed: Principal = { kind: "signed", userId: "usr_1" }

    expect(can("share.workspace" satisfies Capability, viewer)).toBe(false)
    expect(can("mutate.workspace" satisfies Capability, signed)).toBe(false)
    expect(can("share.workspace", undefined)).toBe(false)
  })

  test("models signed web central access separately from workspace-hosted placement", () => {
    expect(signedCentralPlacement({ workspaceId: "ws_authz", role: "viewer" })).toEqual({
      workspaceId: "ws_authz",
      hosting: "central",
      transport: "signed-web",
      role: "viewer",
    })
  })

  test("uses the backend workspace connection role at the UI policy boundary", () => {
    expect(
      placementFromWorkspaceConnection({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId: "ws_1",
        role: "viewer",
        relayUrl: "https://relay.test",
        runtimeAccessToken: "token-with-stale-role",
        tokenExpiresAt: Date.now() + 60_000,
      }),
    ).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
      role: "viewer",
    })
  })
})
