import { AgentPluginArtifactError } from "./types"
import {
  MAX_AGENT_PLUGIN_BYTES,
  MAX_AGENT_PLUGIN_FILES,
  agentPluginTree,
  type AgentPluginTree,
  type AgentPluginTreeEntry,
} from "./tree"

const MAGIC = new Uint8Array([0x43, 0x4c, 0x58, 0x50, 0x4c, 0x47, 0x31, 0x00]) // CLXPLG1\0
const MAX_PATH_BYTES = 4_096
export const MAX_ENCODED_AGENT_PLUGIN_BYTES = MAX_AGENT_PLUGIN_BYTES + (MAX_AGENT_PLUGIN_FILES * (MAX_PATH_BYTES + 10)) + 12
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const BASE64_CHUNK = 0x8000

function corrupt(message: string): never {
  throw new AgentPluginArtifactError("artifact-corrupt", message)
}

/** Stable, compact transport encoding for an already-canonical immutable plugin tree. */
export function encodePluginTree(tree: AgentPluginTree): Uint8Array {
  const records = tree.entries.map((entry) => {
    if (entry.kind === "invalid") corrupt(`Invalid entry ${entry.path} cannot be encoded`)
    const path = encoder.encode(entry.path)
    if (path.byteLength > MAX_PATH_BYTES) corrupt(`Plugin path is too long: ${entry.path}`)
    return { entry, path }
  })
  const length = 12 + records.reduce((total, record) => total
    + 1 + 4 + record.path.byteLength
    + (record.entry.kind === "file" ? 1 + 4 + record.entry.bytes.byteLength : 0), 0)
  if (length > MAX_ENCODED_AGENT_PLUGIN_BYTES) corrupt("Encoded plugin exceeds its transport bound")
  const output = new Uint8Array(length)
  const view = new DataView(output.buffer)
  output.set(MAGIC, 0)
  view.setUint32(8, records.length, false)
  let offset = 12
  for (const { entry, path } of records) {
    output[offset++] = entry.kind === "directory" ? 0 : 1
    view.setUint32(offset, path.byteLength, false)
    offset += 4
    output.set(path, offset)
    offset += path.byteLength
    if (entry.kind === "file") {
      output[offset++] = entry.executableMode
      view.setUint32(offset, entry.bytes.byteLength, false)
      offset += 4
      output.set(entry.bytes, offset)
      offset += entry.bytes.byteLength
    }
  }
  return output
}

/** Decode an untrusted hosted artifact and reapply all tree bounds and path invariants. */
export function decodePluginTree(input: Uint8Array): AgentPluginTree {
  if (input.byteLength < 12 || input.byteLength > MAX_ENCODED_AGENT_PLUGIN_BYTES) corrupt("Encoded plugin has an invalid size")
  if (!MAGIC.every((byte, index) => input[index] === byte)) corrupt("Encoded plugin has an invalid format marker")
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const count = view.getUint32(8, false)
  if (count > MAX_AGENT_PLUGIN_FILES) corrupt("Encoded plugin contains too many entries")
  let offset = 12
  let contentBytes = 0
  const entries: AgentPluginTreeEntry[] = []
  const take = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > input.byteLength) corrupt("Encoded plugin is truncated")
    const bytes = input.slice(offset, offset + length)
    offset += length
    return bytes
  }
  const uint32 = () => {
    if (offset + 4 > input.byteLength) corrupt("Encoded plugin is truncated")
    const value = view.getUint32(offset, false)
    offset += 4
    return value
  }
  for (let index = 0; index < count; index++) {
    if (offset >= input.byteLength) corrupt("Encoded plugin is truncated")
    const kind = input[offset++]
    const pathLength = uint32()
    if (pathLength === 0 || pathLength > MAX_PATH_BYTES) corrupt("Encoded plugin contains an invalid path length")
    let path: string
    try {
      path = decoder.decode(take(pathLength))
    } catch {
      corrupt("Encoded plugin contains a non-UTF-8 path")
    }
    if (kind === 0) {
      entries.push({ path: path!, kind: "directory" })
      continue
    }
    if (kind !== 1 || offset >= input.byteLength) corrupt("Encoded plugin contains an invalid entry kind")
    const executableMode = input[offset++]
    const byteLength = uint32()
    contentBytes += byteLength
    if (contentBytes > MAX_AGENT_PLUGIN_BYTES) corrupt("Encoded plugin content exceeds its bound")
    entries.push({ path: path!, kind: "file", executableMode, bytes: take(byteLength) })
  }
  if (offset !== input.byteLength) corrupt("Encoded plugin contains trailing bytes")
  try {
    return agentPluginTree(entries)
  } catch (cause) {
    if (cause instanceof AgentPluginArtifactError) corrupt(cause.message)
    throw cause
  }
}

/** JSON-safe transport used only across the authenticated control-plane/runtime boundary. */
export function encodePluginTreeBase64(tree: AgentPluginTree) {
  const bytes = encodePluginTree(tree)
  let binary = ""
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  }
  return btoa(binary)
}

/** Decode with a strict alphabet and the same byte bounds as the binary codec. */
export function decodePluginTreeBase64(input: string) {
  if (!input || input.length > Math.ceil(MAX_ENCODED_AGENT_PLUGIN_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    corrupt("Encoded plugin base64 is invalid")
  }
  let binary: string
  try {
    binary = atob(input)
  } catch {
    corrupt("Encoded plugin base64 is invalid")
  }
  const bytes = new Uint8Array(binary!.length)
  for (let index = 0; index < binary!.length; index++) bytes[index] = binary!.charCodeAt(index)
  return decodePluginTree(bytes)
}
