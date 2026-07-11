import { describe, expect, it } from "bun:test"
import type { SessionRef } from "../shell/identity/session-ref"
import {
  resolveRuntimePlacement,
  resolveSessionResourceRoute,
  shouldUseRuntimeSessionTransport,
} from "./placement-table"

const LOOPBACK = { serverUrl: "http://127.0.0.1:3001/", baseUrl: "http://127.0.0.1:3001/" }
const SIGNED = { serverUrl: "https://control.example/", baseUrl: "https://control.example/" }

describe("shouldUseRuntimeSessionTransport", () => {
  it("always uses runtime transport when signed", () => {
    expect(shouldUseRuntimeSessionTransport({ directory: "opencode", signed: true })).toBe(true)
  })

  it("uses runtime transport for central-hosted refs", () => {
    const sessionRef: SessionRef = { sessionId: "s", host: "central", toolSandbox: { kind: "virtual" } }
    expect(shouldUseRuntimeSessionTransport({ directory: "", signed: false, sessionRef })).toBe(true)
  })

  it("uses runtime transport for workspace tool-sandbox refs", () => {
    const sessionRef: SessionRef = {
      sessionId: "s",
      host: "workspace",
      workspaceId: "ws_1",
      toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "cloud" },
    }
    expect(shouldUseRuntimeSessionTransport({ directory: "/x", signed: false, sessionRef })).toBe(true)
  })

  it("keeps plain opencode sessions off the runtime transport", () => {
    expect(shouldUseRuntimeSessionTransport({ directory: "opencode", sessionID: "ses_1", signed: false })).toBe(false)
  })

  it("routes filesystem-directory sessions through the runtime transport", () => {
    expect(shouldUseRuntimeSessionTransport({ directory: "/repo/main", sessionID: "ses_1", signed: false })).toBe(true)
  })
})

describe("resolveRuntimePlacement", () => {
  it("routes central-hosted refs to the control plane with the server's transport", () => {
    const sessionRef: SessionRef = { sessionId: "s", host: "central", toolSandbox: { kind: "virtual" } }
    expect(resolveRuntimePlacement({ sessionRef }, LOOPBACK)).toEqual({ hosting: "central", transport: "loopback" })
    expect(resolveRuntimePlacement({ sessionRef }, SIGNED)).toEqual({ hosting: "central", transport: "signed-web" })
  })

  it("carries the workspaceId for central refs that have one", () => {
    const sessionRef: SessionRef = { sessionId: "s", host: "central", workspaceId: "ws_c", toolSandbox: { kind: "virtual" } }
    expect(resolveRuntimePlacement({ sessionRef }, SIGNED)).toEqual({
      workspaceId: "ws_c",
      hosting: "central",
      transport: "signed-web",
    })
  })

  it("routes workspace tool-sandbox refs to the workspace relay", () => {
    const sessionRef: SessionRef = {
      sessionId: "s",
      host: "workspace",
      workspaceId: "ws_1",
      toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "cloud" },
    }
    expect(resolveRuntimePlacement({ sessionRef }, SIGNED)).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })

  it("keeps local tool-sandbox refs on the loopback runtime", () => {
    const sessionRef: SessionRef = {
      sessionId: "s",
      host: "workspace",
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    }
    expect(resolveRuntimePlacement({ sessionRef }, LOOPBACK)).toEqual({ hosting: "workspace", transport: "loopback" })
  })

  it("routes a bare workspaceId to its runtime, loopback unless relay is forced", () => {
    expect(resolveRuntimePlacement({ workspaceId: "ws_1" }, LOOPBACK)).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "loopback",
    })
    expect(resolveRuntimePlacement({ workspaceId: "ws_1", preferRelayOnLoopback: true }, LOOPBACK)).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
    })
    expect(resolveRuntimePlacement({ workspaceId: "ws_1" }, SIGNED)).toEqual({
      workspaceId: "ws_1",
      hosting: "workspace",
      transport: "workspace-relay",
    })
  })

  it("keeps Local Personal Mode (loopback + filesystem dir) on the loopback runtime", () => {
    expect(resolveRuntimePlacement({ directory: "/repo/main" }, LOOPBACK)).toEqual({
      hosting: "workspace",
      transport: "loopback",
    })
  })

  it("defaults to the central control plane when nothing else matches", () => {
    expect(resolveRuntimePlacement({ directory: "" }, SIGNED)).toEqual({ hosting: "central", transport: "signed-web" })
  })
})

describe("resolveSessionResourceRoute", () => {
  it("A: unsigned op with a resolved ref rides the ref's runtime transport", () => {
    expect(resolveSessionResourceRoute({ signed: false, hasSessionRef: true, loopback: true })).toEqual({
      via: "runtime-session-ref",
    })
  })

  it("B: signed loopback message reads divert to the workspace runtime", () => {
    expect(resolveSessionResourceRoute({
      signed: true,
      hasSessionRef: false,
      targetWorkspaceId: "ws_1",
      resource: "messages",
      loopback: true,
    })).toEqual({ via: "runtime-workspace", workspaceId: "ws_1" })
  })

  it("B does not fire for non-message signed loopback reads", () => {
    expect(resolveSessionResourceRoute({
      signed: true,
      hasSessionRef: false,
      targetWorkspaceId: "ws_1",
      resource: "todo",
      loopback: true,
    })).toEqual({ via: "control-plane" })
  })

  it("C: signed user-hosted diverts to the relay runtime (prefer relay)", () => {
    expect(resolveSessionResourceRoute({
      signed: true,
      hasSessionRef: false,
      targetWorkspaceId: "ws_uh",
      targetKind: "user-hosted",
      resource: "session",
      loopback: false,
    })).toEqual({ via: "runtime-workspace", workspaceId: "ws_uh", preferRelayOnLoopback: true })
  })

  it("C: signed unresolved-kind legacy ws_ ref also diverts to the relay runtime", () => {
    expect(resolveSessionResourceRoute({
      signed: true,
      hasSessionRef: false,
      targetWorkspaceId: "ws_legacy",
      targetKind: undefined,
      directoryWorkspaceId: "ws_legacy",
      resource: "session",
      loopback: false,
    })).toEqual({ via: "runtime-workspace", workspaceId: "ws_legacy", preferRelayOnLoopback: true })
  })

  it("C does not fire for a confirmed cloud workspace (falls to control plane)", () => {
    expect(resolveSessionResourceRoute({
      signed: true,
      hasSessionRef: false,
      targetWorkspaceId: "ws_cloud",
      targetKind: "cloud",
      resource: "session",
      loopback: false,
    })).toEqual({ via: "control-plane" })
  })

  it("C does not fire for a confirmed local kind (falls to control plane)", () => {
    expect(resolveSessionResourceRoute({
      signed: true,
      hasSessionRef: false,
      targetWorkspaceId: "ws_x",
      targetKind: "local",
      directoryWorkspaceId: "ws_x",
      resource: "session",
      loopback: false,
    })).toEqual({ via: "control-plane" })
  })

  it("D: unsigned relay-backed directory ref rides that workspace's runtime", () => {
    expect(resolveSessionResourceRoute({
      signed: false,
      hasSessionRef: false,
      directoryWorkspaceId: "ws_1",
      resource: "messages",
      loopback: true,
    })).toEqual({ via: "runtime-workspace", workspaceId: "ws_1" })
  })

  it("E: signed with no divert goes to the control plane", () => {
    expect(resolveSessionResourceRoute({ signed: true, hasSessionRef: false, resource: "session", loopback: false }))
      .toEqual({ via: "control-plane" })
  })

  it("E: unsigned with no ref and no workspace goes direct", () => {
    expect(resolveSessionResourceRoute({ signed: false, hasSessionRef: false, resource: "session", loopback: false }))
      .toEqual({ via: "direct" })
  })
})
