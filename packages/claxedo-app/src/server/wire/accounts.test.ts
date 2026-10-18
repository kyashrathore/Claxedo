/// <reference types="bun" />
import { expect, test } from "bun:test"
import { accountFromWire } from "./accounts"

const row = { id: "cred-1", provider_id: "cursor-sdk", kind: "api_key", source: "managed", is_active: true, has_secret: true }

test("a stored key's hint is its vendor prefix and last four, and a row without one or with a malformed one has none", () => {
  expect(accountFromWire({ ...row, secret_hint: "key_…rsor" })?.keyHint).toEqual({ prefix: "key_", tail: "rsor" })
  expect(accountFromWire({ ...row, secret_hint: "…rsor" })?.keyHint).toEqual({ prefix: "", tail: "rsor" })
  expect(accountFromWire({ ...row, secret_hint: null })?.keyHint).toBeUndefined()
  expect(accountFromWire({ ...row, secret_hint: "key_abcdefghij…rsor" })?.keyHint).toBeUndefined()
})
