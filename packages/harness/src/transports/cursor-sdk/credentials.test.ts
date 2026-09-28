import { expect, test } from "bun:test"
import type { DraftLaunch, ResolvedCredentials } from "../../contract"
import { cursorCredential } from "./credentials"

const launch = (providers: ResolvedCredentials["providers"]): DraftLaunch => ({
  workspaceId: "w1", directory: "/work", locality: "local", owner: { kind: "person", userId: "owner" },
  config: { harness: { id: "cursor", access: "native" } },
  credentials: { providers, secrets: {}, leaseGeneration: "g1" },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
})
const login = { placement: "desktop", machineOwnerUserId: "machine", canUseOwnLogin: false } as const

test("a stored cursor vendor account selects the Cursor binding", () => {
  expect(cursorCredential(launch({ cursor: { baseUrl: "http://127.0.0.1:48850", placeholder: "selected-cursor", authMode: "api-key" } }),
    { CURSOR_API_KEY: "operator-own" }, login))
    .toEqual({ apiKey: "selected-cursor", backendUrl: "http://127.0.0.1:48850", key: "http://127.0.0.1:48850", bound: true, ownerLogin: false })
})

test("another harness binding never selects Cursor credentials", () => {
  expect(() => cursorCredential(launch({ "claude-sdk": { baseUrl: "http://127.0.0.1:48851", placeholder: "foreign", authMode: "api-key" } }),
    { CURSOR_API_KEY: "operator-own" }, login)).toThrow("Cursor SDK requires an API key")
})
