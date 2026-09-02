import { describe, expect, test } from "bun:test"
import { forwardHeadersFor, isUserHostedTarget, socketKindFor } from "./user-hosted-forwarding"

const userHostedTarget = { access: "user-hosted" as const }
const cloudTarget = { access: "cloud" as const }

describe("isUserHostedTarget", () => {
  test("is true for a user-hosted target", () => {
    expect(isUserHostedTarget(userHostedTarget)).toBe(true)
  })

  test("is false for a cloud target", () => {
    expect(isUserHostedTarget(cloudTarget)).toBe(false)
  })
})

describe("socketKindFor", () => {
  test("tags a user-hosted target's socket as user-hosted-client", () => {
    expect(socketKindFor(userHostedTarget)).toBe("user-hosted-client")
  })

  test("tags a cloud target's socket as client", () => {
    expect(socketKindFor(cloudTarget)).toBe("client")
  })
})

describe("forwardHeadersFor", () => {
  test("strips Cookie when forwarding into a user-hosted workspace", () => {
    const inbound = new Headers({
      cookie: "session=abc123",
      "x-other": "keep-me",
    })
    const forwarded = forwardHeadersFor(userHostedTarget, inbound)
    expect(forwarded.has("cookie")).toBe(false)
    expect(forwarded.get("x-other")).toBe("keep-me")
  })

  test("keeps Cookie when forwarding into a cloud workspace", () => {
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
    forwardHeadersFor(userHostedTarget, inbound)
    expect(inbound.get("cookie")).toBe("session=abc123")
  })
})
