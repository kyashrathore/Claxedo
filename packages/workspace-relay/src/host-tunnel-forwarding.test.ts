import { describe, expect, test } from "bun:test"
import { forwardHeadersFor, isHostTunnelTarget, socketKindFor } from "./host-tunnel-forwarding"

const tunnelTarget = { backing: "local-worktree" as const }
const cloudTarget = { backing: "cloud-vm" as const }

describe("isHostTunnelTarget", () => {
  test("is true for a local-worktree target", () => {
    expect(isHostTunnelTarget(tunnelTarget)).toBe(true)
  })

  test("is false for a cloud-vm target", () => {
    expect(isHostTunnelTarget(cloudTarget)).toBe(false)
  })
})

describe("socketKindFor", () => {
  test("tags a tunnelled target's socket as host-tunnel-client", () => {
    expect(socketKindFor(tunnelTarget)).toBe("host-tunnel-client")
  })

  test("tags a cloud-vm target's socket as client", () => {
    expect(socketKindFor(cloudTarget)).toBe("client")
  })
})

describe("forwardHeadersFor", () => {
  test("strips Cookie when forwarding through a host tunnel", () => {
    const inbound = new Headers({
      cookie: "session=abc123",
      "x-other": "keep-me",
    })
    const forwarded = forwardHeadersFor(tunnelTarget, inbound)
    expect(forwarded.has("cookie")).toBe(false)
    expect(forwarded.get("x-other")).toBe("keep-me")
  })

  test("keeps Cookie when forwarding to a cloud-vm", () => {
    const inbound = new Headers({
      cookie: "session=abc123",
      "x-other": "keep-me",
    })
    const forwarded = forwardHeadersFor(cloudTarget, inbound)
    expect(forwarded.get("cookie")).toBe("session=abc123")
    expect(forwarded.get("x-other")).toBe("keep-me")
  })

  test("does not mutate the input Headers", () => {
    const inbound = new Headers({ cookie: "session=abc123" })
    forwardHeadersFor(tunnelTarget, inbound)
    expect(inbound.get("cookie")).toBe("session=abc123")
  })
})
