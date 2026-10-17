/// <reference types="bun" />
import { expect, test } from "bun:test"
import { desktopAccountBridge, desktopAccountState } from "./desktop-bridge"

const member = () => Promise.resolve(undefined)

test("desktop bridge: only a preload exposing every account member, its event stream's included, is a bridge", () => {
  const unsubscribe = () => () => undefined
  const account = {
    state: member, onState: unsubscribe, signIn: member, signOut: member, cancelSignIn: member, run: member,
    streamOpen: member, streamStart: member, streamClose: member, onStreamChunk: unsubscribe, onStreamEnd: unsubscribe, onStreamError: unsubscribe,
  }
  expect(desktopAccountBridge({ api: { account } })).toBe(account)
  expect(desktopAccountBridge({ api: { account: { ...account, run: undefined } } })).toBeUndefined()
  expect(desktopAccountBridge({ api: { account: { ...account, onStreamChunk: undefined } } })).toBeUndefined()
  expect(desktopAccountBridge({ api: { account: { ...account, cancelSignIn: undefined } } })).toBeUndefined()
  expect(desktopAccountBridge({})).toBeUndefined()
})

test("desktop bridge: main's states decode into the account's states", () => {
  expect(desktopAccountState({ status: "unsigned", detail: "remote revoked" })).toEqual({ kind: "unsigned" })
  expect(desktopAccountState({ status: "pending" })).toEqual({ kind: "awaitingBrowser" })
  expect(desktopAccountState({ status: "unsigned", detail: "no callback within 600000ms", signInUnfinished: true })).toEqual({ kind: "signInUnfinished" })
  expect(desktopAccountState({ status: "signed", identity: { userId: "u1", displayName: "Ada", email: "ada@claxedo.test", orgId: "org" } })).toEqual({
    kind: "signed",
    user: { id: "u1", fullName: "Ada", email: "ada@claxedo.test", orgId: "org" },
    identity: "known",
  })
  expect(desktopAccountState({ status: "unavailable", reason: "no-secure-storage", detail: "No keychain" })).toEqual({ kind: "unavailable", reason: "No keychain" })
})

test("desktop bridge: a signed account with no name is resolving until the lookup answers or fails", () => {
  expect(desktopAccountState({ status: "signed", identity: { userId: "u1" } })).toMatchObject({ kind: "signed", identity: "resolving" })
  expect(desktopAccountState({ status: "signed", identity: { userId: "u1" }, identityLookup: "failed" })).toMatchObject({ kind: "signed", identity: "failed" })
})

test("desktop bridge: a signed account main has not named yet is still signing in, and one main could not name is unavailable", () => {
  expect(desktopAccountState({ status: "signed", identity: { userId: "" } })).toEqual({ kind: "loading" })
  expect(desktopAccountState({ status: "signed", identity: { userId: "" }, identityLookup: "failed" })).toMatchObject({ kind: "unavailable" })
})

test("desktop bridge: a state main never sends is unavailable, never signed", () => {
  expect(desktopAccountState({ status: "signed", identity: {} })).toMatchObject({ kind: "unavailable" })
  expect(desktopAccountState({ status: "admin" })).toMatchObject({ kind: "unavailable" })
  expect(desktopAccountState(null)).toMatchObject({ kind: "unavailable" })
})

test("desktop bridge: a session main invalidated because the server rejected it is revoked, not unavailable", () => {
  expect(desktopAccountState({ status: "unavailable", reason: "revoked", detail: "the server rejected this session" })).toEqual({ kind: "revoked" })
  expect(desktopAccountState({ status: "unavailable", reason: "callback-failed", detail: "The browser never came back" })).toEqual({ kind: "unavailable", reason: "The browser never came back" })
})
