import { describe, expect, test } from "vitest"
import { embeddedRuntimeTargetUrl } from "./internals"

/**
 * The embedded hop used to dispatch from a synthetic, portless origin, so
 * `requestPort` in workspace-runtime's PTY route fell through to the http
 * default of 80. Every terminal was then told `CLAXEDO_PORT=80`, the agent
 * hooks posted lifecycle events to a dead port, and coding agents in terminals
 * never showed status — silently, because notify.sh discards its curl output.
 */
describe("embeddedRuntimeTargetUrl", () => {
  test("preserves the caller's port, which becomes CLAXEDO_PORT for spawned terminals", () => {
    const target = embeddedRuntimeTargetUrl(
      new URL("http://127.0.0.1:3001/api/wr/pty?directory=%2Frepo"),
      "/api/wr/pty",
    )
    expect(target.port).toBe("3001")
  })

  // The exact expression the runtime applies to this URL (routes/pty.ts).
  test("survives the runtime's own port derivation instead of defaulting to 80", () => {
    const target = embeddedRuntimeTargetUrl(new URL("http://127.0.0.1:3001/api/wr/pty"), "/api/wr/pty")
    const derived = target.port || (target.protocol === "https:" ? "443" : target.protocol === "http:" ? "80" : undefined)
    expect(derived).toBe("3001")
  })

  test("carries a non-default port from any host", () => {
    expect(embeddedRuntimeTargetUrl(new URL("http://localhost:52100/api/wr/pty"), "/api/wr/pty").port)
      .toBe("52100")
  })

  test("keeps the caller's scheme and host rather than inventing an origin", () => {
    const target = embeddedRuntimeTargetUrl(new URL("https://claxedo.example:8443/api/wr/pty"), "/api/wr/pty")
    expect(target.protocol).toBe("https:")
    expect(target.hostname).toBe("claxedo.example")
    expect(target.port).toBe("8443")
  })

  test("preserves the query string, including the directory selector", () => {
    const target = embeddedRuntimeTargetUrl(
      new URL("http://127.0.0.1:3001/api/wr/pty?directory=%2Frepo&harness=claude"),
      "/api/wr/pty",
    )
    expect(target.searchParams.get("directory")).toBe("/repo")
    expect(target.searchParams.get("harness")).toBe("claude")
  })

  // Callers pass an override path for rewritten routes; it must win over the
  // caller's own pathname while everything else about the origin is kept.
  test("uses the supplied target path over the caller's pathname", () => {
    const target = embeddedRuntimeTargetUrl(
      new URL("http://127.0.0.1:3001/session/abc?directory=%2Frepo"),
      "/api/wr/session",
    )
    expect(target.pathname).toBe("/api/wr/session")
    expect(target.port).toBe("3001")
  })
})
