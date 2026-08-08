import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  HOSTED_OPERATIONS,
  decodeHostedResult,
  hostedOperationNames,
  isSafeOperation,
} from "./hosted-operations"

/**
 * The app's half of the operation contract.
 *
 * Three ways this stops working, and none is caught by exercising a decode:
 * it drifts from the reviewed matrix, it grows a transport, or a decoder gets
 * loose enough to accept the thing it was written to reject. Each has a test.
 */

const source = readFileSync(path.join(import.meta.dir, "hosted-operations.ts"), "utf8")
const matrix = readFileSync(
  path.resolve(import.meta.dir, "../../../../../docs/tech-docs/desktop-hosted-operation-matrix.md"),
  "utf8",
)

function matrixNames() {
  return [...matrix.matchAll(/^\| `([a-zA-Z][\w.]*)` \|/gm)].map((match) => match[1]!)
}

describe("the registry", () => {
  test("names only operations the matrix declares", () => {
    const declared = new Set(matrixNames())

    expect(hostedOperationNames().filter((name) => !declared.has(name))).toEqual([])
  })

  test("agrees with Electron main's table", () => {
    // Two registries, one contract. Main owns method-and-path; this owns result
    // shape. A name in one and not the other means a channel that cannot be
    // called or an operation with no decoder.
    const mainTable = readFileSync(
      path.resolve(import.meta.dir, "../../../../claxedo-desktop/src/main/account/hosted-operations.ts"),
      "utf8",
    )
    // Matched on the key alone, not `": { method"` — one of main's entries is
    // written across several lines, and a same-line pattern silently dropped
    // it. Scoped to the table literal so unrelated string keys elsewhere in
    // the file cannot join the list.
    const table = mainTable.slice(mainTable.indexOf("HOSTED_OPERATIONS = {"), mainTable.indexOf("} as const satisfies"))
    const mainNames = [...table.matchAll(/^ {2}"([a-z][\w.]*)":/gm)].map((match) => match[1]!)

    expect(mainNames.length).toBeGreaterThan(10)
    expect(hostedOperationNames().toSorted()).toEqual(mainNames.toSorted())
  })

  test("carries no transport, under any spelling", () => {
    // The registry could describe a request if it were allowed to. It is not —
    // a registry that could express a URL is a place to add a fourteenth
    // operation that happens to take a path.
    for (const forbidden of ["fetch(", "http", "url", "method:", "headers", "Bearer", "authorization"]) {
      expect(source, `the registry must not mention ${forbidden}`).not.toContain(forbidden)
    }
  })
})

describe("decodeHostedResult", () => {
  test("names the operation when a shape is wrong", () => {
    // "expected a non-empty relayUrl" from an unnamed decoder sends someone
    // reading the wrong route.
    expect(() => decodeHostedResult("workspace.connection.mint", {})).toThrow(
      /workspace\.connection\.mint.*relayUrl/,
    )
  })

  test("rejects an unknown operation rather than passing the value through", () => {
    expect(() => decodeHostedResult("hostedFetch" as never, { anything: true })).toThrow(/no hosted operation/)
  })

  test("rejects a list where an object is required, and the reverse", () => {
    expect(() => decodeHostedResult("account.get", [])).toThrow(/expected an object/)
    expect(() => decodeHostedResult("workspace.list", {})).toThrow(/expected an array/)
  })

  test("rejects an empty string in a required field, not just a missing one", () => {
    // The failure that reaches a component: a present-but-blank relay URL
    // produces a WebSocket connection to nowhere rather than an error here.
    expect(() => decodeHostedResult("workspace.connection.mint", { relayUrl: "" })).toThrow(/relayUrl/)
    expect(() => decodeHostedResult("workspace.connection.mint", { relayUrl: 42 })).toThrow(/relayUrl/)
  })

  test("returns the decoded value on a good shape", () => {
    expect(decodeHostedResult("workspace.connection.mint", { relayUrl: "wss://relay.test", token: "x" })).toEqual({
      relayUrl: "wss://relay.test",
      token: "x",
    })
    expect(decodeHostedResult("workspace.list", [{ id: "ws_1" }])).toEqual([{ id: "ws_1" }])
  })

  test("rejects null, which is an object to typeof", () => {
    // The classic. `typeof null === "object"`, so a decoder written the obvious
    // way accepts it and the caller reads a field off nothing.
    expect(() => decodeHostedResult("account.get", null)).toThrow(/expected an object/)
  })
})

describe("isSafeOperation", () => {
  test("marks the operations that provision or destroy as unsafe", () => {
    // `safe` is the renderer's licence to retry on its own. Anything that
    // creates a VM, restores a checkpoint or mints a token is main's call,
    // because the idempotency key lives there.
    for (const unsafe of [
      "workspace.create",
      "workspace.checkpoints.restore",
      "account.cliExchange",
      "host.enrollCurrentMachine",
    ] as const) {
      expect(isSafeOperation(unsafe), unsafe).toBe(false)
    }
  })

  test("marks plain reads as safe", () => {
    for (const safe of ["account.get", "workspace.list", "workspace.checkpoints.list"] as const) {
      expect(isSafeOperation(safe), safe).toBe(true)
    }
  })

  test("every operation states one way or the other", () => {
    // A missing `safe` reads as unsafe through `?? false`, which is the right
    // default and the wrong way to arrive at it — silently.
    for (const name of hostedOperationNames()) {
      expect(typeof HOSTED_OPERATIONS[name].safe, name).toBe("boolean")
    }
  })
})
