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

  test("keys a relay-backed workspace's config once, whichever spelling of its directory the reader holds", () => {
    const ref = {
      sessionId: "ses_1",
      host: "workspace",
      workspaceId: "ws_1",
      toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "cloud" },
    } satisfies SessionRef
    const byRoute = { sessionID: "ses_1", directory: "ws_1", serverUrl: "https://one.example", sessionRef: ref }
    const byAddress = { ...byRoute, directory: "workspace:ws_1" }
    expect(sessionConfigRawQueryKey(byRoute)).toEqual(sessionConfigRawQueryKey(byAddress))
    expect(sessionConfigRawQueryKey({ ...byRoute, directory: "/private/tmp/repo" })).toEqual(
      sessionConfigRawQueryKey({ ...byRoute, directory: "/tmp/repo" }),
    )
    expect(sessionConfigRawQueryKey(byRoute)).not.toEqual(sessionConfigRawQueryKey({ ...byRoute, directory: "ws_2" }))
  })

  test("does not merge user-hosted and cloud refs with the same visible placement", () => {
    const userHosted = {
      sessionId: "shared",
      host: "workspace",
      workspaceId: "ws_1",
      toolSandbox: { kind: "workspace", workspaceId: "ws_1", hosting: "user-hosted", hostId: "host_local" },
      harness: { kind: "native", harnessId: "opencode" },
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
      harness: { kind: "native", harnessId: "opencode" },
    } satisfies SessionRef
    const scope = {
      sessionID: "shared",
      directory: "/repo",
      workspaceId: "ws_1",
      serverUrl: "https://one.example",
    }

    expect(sessionConfigRawQueryKey({ ...scope, sessionRef: userHosted })).not.toEqual(
      sessionConfigRawQueryKey({ ...scope, sessionRef: workspace }),
    )
    expect(sessionConfigSelectionQueryKey({ ...scope, sessionRef: userHosted })).not.toEqual(
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
      harness: { kind: "connection", connectionId: "codex-team" },
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
      sessionRef: { ...baseRef, harness: { kind: "connection", connectionId: "codex-team-a" } },
    })).not.toEqual(sessionConfigRawQueryKey({
      ...scope,
      sessionRef: { ...baseRef, harness: { kind: "connection", connectionId: "codex-team-b" } },
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

  test("builds a session-config patch from an explicit local selection without changing its harness", () => {
    expect(sessionConfigPatchFromLocalSelection({
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4" },
      variant: null,
    })).toEqual({
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4" },
      variant: null,
    })
  })

  test("uses null model and variant when clearing an explicit selection", () => {
    expect(sessionConfigPatchFromLocalSelection({ agent: "build" })).toEqual({
      agent: "build",
      model: null,
      variant: null,
    })
  })

  test("exposes the default model only after restoration when no valid selection exists", () => {
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
