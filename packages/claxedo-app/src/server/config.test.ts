import { expect, test } from "bun:test"
import { serverAccess } from "./config"

test("signed browser access reuses its session cookie without a bearer or desktop port", () => {
  expect(serverAccess({ controlPlane: { kind: "cookie" } }, "user_1")).toEqual({ auth: { kind: "none" }, cookies: true })
})

test("a signed-out browser has no account access", () => {
  expect(serverAccess({ controlPlane: { kind: "cookie" } }, undefined)).toEqual({ auth: { kind: "none" } })
})

test("signed desktop access keeps the main-owned operation port", () => {
  const run = async () => ({})
  expect(serverAccess({ controlPlane: { kind: "port", run } }, "user_1")).toEqual({ auth: { kind: "none" }, account: run })
})
