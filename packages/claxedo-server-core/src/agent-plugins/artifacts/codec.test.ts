import { describe, expect, test } from "vitest"
import { agentPluginTree } from "./tree"
import { decodePluginTree, decodePluginTreeBase64, encodePluginTree, encodePluginTreeBase64 } from "./codec"

describe("Agent Plugin artifact codec", () => {
  test("round-trips the canonical tree without changing bytes or modes", () => {
    const tree = agentPluginTree([
      { path: "bin", kind: "directory" },
      { path: "bin/server", kind: "file", executableMode: 0o100, bytes: new Uint8Array([0, 1, 255]) },
      { path: "plugin.json", kind: "file", executableMode: 0, bytes: new TextEncoder().encode("{}") },
    ])
    expect(decodePluginTree(encodePluginTree(tree))).toEqual(tree)
    expect(decodePluginTreeBase64(encodePluginTreeBase64(tree))).toEqual(tree)
  })

  test("rejects truncated, trailing, and structurally invalid input", () => {
    const encoded = encodePluginTree(agentPluginTree([
      { path: "plugin.json", kind: "file", executableMode: 0, bytes: new TextEncoder().encode("{}") },
    ]))
    expect(() => decodePluginTree(encoded.subarray(0, -1))).toThrow("truncated")
    const trailing = new Uint8Array(encoded.byteLength + 1)
    trailing.set(encoded)
    expect(() => decodePluginTree(trailing)).toThrow("trailing bytes")
    const corrupt = encoded.slice()
    corrupt[0] = 0
    expect(() => decodePluginTree(corrupt)).toThrow("format marker")
  })
})
