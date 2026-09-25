import { expect, test } from "bun:test"
import { TransportError } from "./errors"

test("transport errors carry owner, code, cause, and the existing retry policies", () => {
  const cause = new Error("offline")
  const acp = new TransportError("acp", "connection", "unavailable", { cause })
  expect(acp).toMatchObject({ transport: "acp", code: "connection", retryable: true, name: "AcpTransportError" })
  expect(acp.cause).toBe(cause)
  expect(new TransportError("pi", "retirement", "unverified").retryable).toBe(false)
  expect(new TransportError("cursor", "sdk", "failed").retryable).toBe(true)
  expect(new TransportError("claude", "process", "failed", { retryable: true }).retryable).toBe(true)
  expect(new TransportError("provider", "invalid_config", "bad").name).toBe("HarnessProviderError")
})
