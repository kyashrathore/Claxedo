import { expect, test } from "bun:test"
import { validateDescriptors } from "./snapshot"
import { fakeConnectionProvider, FakeTransport } from "@claxedo/session-core/testing"

test("invalid connection diagnostics retain nested protocol error details", () => {
  const error = Object.assign(new Error("Invalid config"), { data: { message: "command is missing" } })
  expect(() => validateDescriptors([
    { connectionId: "broken", providerKey: "fixture", configRevision: 1, enabled: true, config: {} },
  ], [fakeConnectionProvider({ providerKey: "fixture", validateConfig: () => { throw error }, transport: () => new FakeTransport() })]))
    .toThrow("Invalid config: command is missing")
})
