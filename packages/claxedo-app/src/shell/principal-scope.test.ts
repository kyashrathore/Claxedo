/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId } from "@/server"
import { principalScope } from "./principal-scope"

const desktop = { signedIn: false, principal: { kind: "machine", machineId: machineId("enr_1") } } as const
const hosted = { signedIn: true, principal: { kind: "machine" } } as const

test("per-browser state belongs to the signed-in user and its organization, so another account on the same desktop starts empty", () => {
  const ada = principalScope({ kind: "signedIn", user: { id: "ada", orgId: "org_a" } }, desktop)
  const grace = principalScope({ kind: "signedIn", user: { id: "grace" } }, desktop)
  expect(ada).toBe("user:ada:org:org_a")
  expect(grace).toBe("user:grace")
  expect(principalScope({ kind: "signedIn", user: { id: "ada" } }, hosted)).toBe("user:ada")
})

test("only a signed-out reader of a local server that issues no sign-in is scoped by its machine; nothing is scoped while the account still answers", () => {
  expect(principalScope({ kind: "signedOut" }, desktop)).toBe("machine:enr_1")
  expect(principalScope({ kind: "signedOut" }, { signedIn: false, principal: { kind: "machine" } })).toBe("machine")
  expect(principalScope({ kind: "signedOut" }, hosted)).toBeUndefined()
  expect(principalScope({ kind: "signingIn" }, desktop)).toBeUndefined()
  expect(principalScope({ kind: "signedIn", user: { id: "ada" } }, undefined)).toBeUndefined()
})
