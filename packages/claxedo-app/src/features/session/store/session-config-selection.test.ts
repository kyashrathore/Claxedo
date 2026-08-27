import { describe, expect, test } from "bun:test"
import type { SessionRef } from "@/platform/identity/session-ref"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  localSelectionStateFromSessionConfig,
  sessionConfigPatchFromLocalSelection,
  sessionConfigRawQueryKey,
  sessionConfigSelectionQueryKey,
  sessionConfigSelectionSyncQueryKey,
  shouldExposeDefaultLocalModelFallback,
} from "./session-config-selection"
import { sessionResourceAuthorityKey } from "./session-resource-authority"

describe("session config selection", () => {
  test("uses a root session-scoped query key", () => {
    const scope = { sessionID: "ses_1", directory: "/repo", serverUrl: "https://server.example/" }
    const authority = sessionResourceAuthorityKey(scope)
    expect(sessionConfigSelectionQueryKey(scope)).toEqual(
      shellDataKeys.sessionId("ses_1", "config-selection", authority),
    )
    expect(sessionConfigRawQueryKey(scope)).toEqual(
      shellDataKeys.sessionId("ses_1", "config-raw", authority),
    )
    expect(sessionConfigSelectionSyncQueryKey("ses_1")).toEqual(shellDataKeys.sessionId("ses_1", "config-selection-sync"))
  })

  test("isolates raw and derived config for the same opaque id by placement and authority", () => {
    const first = {
      sessionID: "shared",
      directory: "/runtime/repo",
      workspaceId: "ws_1",
      serverUrl: "https://one.example",
    }
    const second = { ...first, workspaceId: "ws_2" }
    const third = { ...first, serverUrl: "https://two.example" }

    expect(sessionConfigRawQueryKey(first)).not.toEqual(sessionConfigRawQueryKey(second))
    expect(sessionConfigRawQueryKey(first)).not.toEqual(sessionConfigRawQueryKey(third))
    expect(sessionConfigSelectionQueryKey(first)).not.toEqual(sessionConfigSelectionQueryKey(second))
    expect(sessionConfigSelectionQueryKey(first)).not.toEqual(sessionConfigSelectionQueryKey(third))
  })

  test("normalizes equivalent server URLs without merging different servers", () => {
    const scope = { sessionID: "shared", directory: "/repo" }
    expect(sessionConfigRawQueryKey({ ...scope, serverUrl: " https://one.example/// " })).toEqual(
      sessionConfigRawQueryKey({ ...scope, serverUrl: "https://one.example" }),
    )
    expect(sessionConfigRawQueryKey({ ...scope, serverUrl: "https://one.example" })).not.toEqual(
      sessionConfigRawQueryKey({ ...scope, serverUrl: "https://two.example" }),
    )
  })

  test("does not merge central and workspace-backed refs with the same visible placement", () => {
    const central = {
      sessionId: "shared",
      host: "central",
      workspaceId: "ws_1",
      toolSandbox: { kind: "virtual" },
      harness: { id: "opencode" },
    } satisfies SessionRef
    const workspace = {
      sessionId: "shared",
      host: "workspace",
      workspaceId: "ws_1",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_1",
        hosting: "cloud",
        hostId: "host_1",
      },
      harness: { id: "opencode" },
    } satisfies SessionRef
    const scope = {
      sessionID: "shared",
      directory: "/repo",
      workspaceId: "ws_1",
      serverUrl: "https://one.example",
    }

    expect(sessionConfigRawQueryKey({ ...scope, sessionRef: central })).not.toEqual(
      sessionConfigRawQueryKey({ ...scope, sessionRef: workspace }),
    )
    expect(sessionConfigSelectionQueryKey({ ...scope, sessionRef: central })).not.toEqual(
      sessionConfigSelectionQueryKey({ ...scope, sessionRef: workspace }),
    )
  })

  test("lets a complete SessionRef dominate incomplete redundant workspace fields", () => {
    const sessionRef = {
      sessionId: "shared",
      host: "workspace",
      workspaceId: "ws_authoritative",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_authoritative",
        hosting: "user-hosted",
        hostId: "host_1",
      },
      harness: { id: "codex-acp", binary: "/opt/codex" },
    } satisfies SessionRef
    const scope = {
      sessionID: "shared",
      directory: "/repo",
      serverUrl: "https://one.example",
      sessionRef,
    }

    expect(sessionConfigRawQueryKey(scope)).toEqual(sessionConfigRawQueryKey({
      ...scope,
      workspaceId: "stale-redundant-value",
      workspaceKind: "cloud",
    }))
  })

  test("keeps harness backing in the authority even when placement is identical", () => {
    const baseRef = {
      sessionId: "shared",
      host: "workspace",
      cwd: "/repo",
      toolSandbox: { kind: "local", cwd: "/repo" },
    } satisfies SessionRef
    const scope = { sessionID: "shared", directory: "/repo", serverUrl: "https://one.example" }

    expect(sessionConfigRawQueryKey({
      ...scope,
      sessionRef: { ...baseRef, harness: { id: "codex-acp", binary: "/opt/codex-a" } },
    })).not.toEqual(sessionConfigRawQueryKey({
      ...scope,
      sessionRef: { ...baseRef, harness: { id: "codex-acp", binary: "/opt/codex-b" } },
    }))
  })

  test("decodes model, agent, and variant from session config", () => {
    expect(localSelectionStateFromSessionConfig({
      harness: { id: "opencode", access: "native" },
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      variant: "fast",
    })).toEqual({
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-chat" },
      variant: "fast",
    })
  })

  test("keeps a null variant because session config uses it as explicit default", () => {
    expect(localSelectionStateFromSessionConfig({
      agent: "build",
      model: { providerID: "nvidia", modelID: "nemotron" },
      variant: null,
    })).toEqual({
      agent: "build",
      model: { providerID: "nvidia", modelID: "nemotron" },
      variant: null,
    })
  })

  test("ignores malformed model config instead of inventing a fallback", () => {
    expect(localSelectionStateFromSessionConfig({
      agent: "build",
      model: { providerID: "deepseek" },
    })).toEqual({ agent: "build" })
  })

  test("builds an opencode session-config patch from an explicit local selection", () => {
    expect(sessionConfigPatchFromLocalSelection({
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4" },
      variant: null,
    })).toEqual({
      harness: { id: "opencode", access: "native" },
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4" },
      variant: null,
    })
  })

  test("uses null model and variant when clearing explicit opencode selection", () => {
    expect(sessionConfigPatchFromLocalSelection({ agent: "build" })).toEqual({
      harness: { id: "opencode", access: "native" },
      agent: "build",
      model: null,
      variant: null,
    })
  })

  test("only exposes the default model fallback for uninitialized drafts", () => {
    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: false,
      hasSelection: false,
      restoreLoading: false,
    })).toBe(true)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: true,
      hasSelection: false,
      restoreLoading: false,
    })).toBe(false)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: false,
      hasSelection: true,
      hasValidSelection: true,
      restoreLoading: false,
    })).toBe(false)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: true,
      hasSelection: true,
      hasValidSelection: false,
      restoreLoading: false,
    })).toBe(true)

    expect(shouldExposeDefaultLocalModelFallback({
      existingSession: false,
      hasSelection: false,
      restoreLoading: true,
    })).toBe(false)
  })
})
