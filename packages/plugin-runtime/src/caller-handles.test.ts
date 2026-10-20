import { describe, expect, test } from "bun:test"
import { PLUGIN_CALLER_HANDLE_TTL_MS, PluginCallerHandles } from "./caller-handles"

const alice = { userId: "usr_alice", orgId: "org_1" }
const bob = { userId: "usr_bob", orgId: "org_1" }

function clocked() {
  let now = 1_000
  return { handles: new PluginCallerHandles(() => now), advance: (ms: number) => void (now += ms) }
}

describe("caller handles", () => {
  test("a handle names its caller while its request is open, however long that takes", () => {
    const { handles, advance } = clocked()
    const minted = handles.mint(3, alice)
    expect(minted.handle).toMatch(/^[0-9a-f]{32}$/)
    advance(PLUGIN_CALLER_HANDLE_TTL_MS * 3)
    expect(handles.resolve(3, minted.handle)).toEqual(alice)
  })

  test("a handle expires ten minutes after its request answered", () => {
    const { handles, advance } = clocked()
    const minted = handles.mint(3, alice)
    minted.settle()
    advance(PLUGIN_CALLER_HANDLE_TTL_MS - 1)
    expect(handles.resolve(3, minted.handle)).toEqual(alice)
    advance(1)
    expect(handles.resolve(3, minted.handle)).toBeUndefined()
    advance(-PLUGIN_CALLER_HANDLE_TTL_MS)
    expect(handles.resolve(3, minted.handle)).toBeUndefined()
  })

  test("settling twice keeps the first expiry", () => {
    const { handles, advance } = clocked()
    const minted = handles.mint(3, alice)
    minted.settle()
    advance(PLUGIN_CALLER_HANDLE_TTL_MS - 1)
    minted.settle()
    advance(1)
    expect(handles.resolve(3, minted.handle)).toBeUndefined()
  })

  test("a handle resolves only under the epoch it was minted in", () => {
    const { handles } = clocked()
    const minted = handles.mint(3, alice)
    expect(handles.resolve(4, minted.handle)).toBeUndefined()
    expect(handles.resolve(2, minted.handle)).toBeUndefined()
    expect(handles.resolve(3, minted.handle)).toEqual(alice)
  })

  test("minting under a newer epoch forgets every handle of an older one", () => {
    const { handles } = clocked()
    const old = handles.mint(3, alice)
    const next = handles.mint(4, bob)
    expect(handles.resolve(3, old.handle)).toBeUndefined()
    expect(handles.resolve(4, next.handle)).toEqual(bob)
  })

  test("an unknown or guessed handle resolves nothing, and every handle is distinct", () => {
    const { handles } = clocked()
    const minted = new Set(Array.from({ length: 64 }, () => handles.mint(1, alice).handle))
    expect(minted.size).toBe(64)
    expect(handles.resolve(1, "0".repeat(32))).toBeUndefined()
    expect(handles.resolve(1, "")).toBeUndefined()
  })
})
