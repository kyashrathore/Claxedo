/// <reference types="bun" />
import { expect, test } from "bun:test"
import { signInGate } from "./sign-in-gate"

const issuing = { signedIn: true }
const local = { signedIn: false }
const user = { id: "user_1", fullName: "Ada", email: "ada@claxedo.test" }

test("sign-in gate: a server that issues sessions sends a signed-out or expired reader to /login, and holds while sign-in settles", () => {
  expect(signInGate({ kind: "signedOut" }, issuing)).toBe("login")
  expect(signInGate({ kind: "expired" }, issuing)).toBe("login")
  expect(signInGate({ kind: "signingIn" }, issuing)).toBe("hold")
  expect(signInGate({ kind: "signedIn", user }, issuing)).toBe("open")
})

test("sign-in gate: a server that issues no sessions, or one not read yet, never redirects", () => {
  expect(signInGate({ kind: "signedOut" }, local)).toBe("open")
  expect(signInGate({ kind: "signedOut" }, undefined)).toBe("open")
})
