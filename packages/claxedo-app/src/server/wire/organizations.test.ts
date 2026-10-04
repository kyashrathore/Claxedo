/// <reference types="bun" />
import { expect, test } from "bun:test"
import { memberFromWire, membershipFromWire } from "./organizations"

test("a membership row keeps the organization, its name and the caller's role, and refuses an unknown role", () => {
  expect(membershipFromWire({ org_id: "org_acme", name: "Acme", kind: "shared", role: "admin" })).toEqual({ orgId: "org_acme", name: "Acme", role: "admin" } as never)
  expect(membershipFromWire({ org_id: "org_acme", name: "Acme", role: "billing" })).toBeUndefined()
})

test("a member row carries its name only when the auth store has one, and marks the caller", () => {
  expect(memberFromWire({ user_id: "usr_a", role: "owner", name: "Ada", you: true })).toEqual({ userId: "usr_a", role: "owner", name: "Ada", you: true } as never)
  expect(memberFromWire({ user_id: "usr_b", role: "member", name: null, you: false })).toEqual({ userId: "usr_b", role: "member", you: false } as never)
})
