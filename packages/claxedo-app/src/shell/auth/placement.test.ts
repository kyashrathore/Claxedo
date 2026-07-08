import { describe, expect, test } from "bun:test"
import {
  centralSessionRef,
  localSessionRef,
  workspaceBackedSessionRef,
} from "../identity/session-ref"
import { placementFor } from "./placement"

describe("placementFor", () => {
  test("fails closed without signed access", () => {
    expect(placementFor({
      hasSignedAccess: false,
      serverUrl: "https://control.test",
      legacy: { directory: "ws_1", workspaceKind: "cloud" },
    })).toBeUndefined()
  })

  test("maps central refs to signed central placement", () => {
    expect(placementFor({
      ref: centralSessionRef({ sessionId: "ses_1" }),
      hasSignedAccess: true,
      serverUrl: "https://control.test",
    })).toEqual({
      hosting: "central",
      transport: "signed-web",
    })
    expect(placementFor({
      ref: centralSessionRef({ sessionId: "ses_1", workspaceId: "ws_authz" }),
      hasSignedAccess: true,
      serverUrl: "http://127.0.0.1:3001",
    })).toEqual({
      workspaceId: "ws_authz",
      hosting: "central",
      transport: "loopback",
    })
  })

  test("maps workspace refs to workspace relay placement", () => {
    expect(placementFor({
      ref: workspaceBackedSessionRef({
        sessionId: "ses_1",
        workspace: { workspaceId: "ws_hosted", kind: "user-hosted" },
      }),
      hasSignedAccess: true,
      serverUrl: "https://control.test",
    })).toEqual({
      workspaceId: "ws_hosted",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })

  test("keeps loopback local refs unsigned", () => {
    expect(placementFor({
      ref: localSessionRef({ sessionId: "ses_1", cwd: "/repo/main" }),
      hasSignedAccess: true,
      serverUrl: "http://127.0.0.1:3001",
    })).toEqual({
      hosting: "workspace",
      transport: "loopback",
    })
    expect(placementFor({
      ref: localSessionRef({ sessionId: "ses_1", cwd: "/repo/main" }),
      hasSignedAccess: true,
      serverUrl: "https://control.test",
    })).toEqual({
      hosting: "workspace",
      transport: "loopback",
    })
  })

  test("preserves legacy directory behavior for call sites not yet on SessionRef", () => {
    expect(placementFor({
      hasSignedAccess: true,
      serverUrl: "http://127.0.0.1:3001",
      legacy: { directory: "ws_1", workspaceKind: "cloud" },
    })).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
    })
    expect(placementFor({
      hasSignedAccess: true,
      serverUrl: "https://control.test",
      legacy: { directory: "/repo/.claxedo/user-hosted/workspaces/ws_1" },
    })).toEqual({
      hosting: "central",
      transport: "signed-web",
    })
    expect(placementFor({
      hasSignedAccess: true,
      serverUrl: "http://127.0.0.1:3001",
      legacy: { directory: "/repo/main" },
    })).toEqual({
      hosting: "workspace",
      transport: "loopback",
    })
  })

})
