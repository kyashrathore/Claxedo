import { createHash } from "node:crypto"
import type { DocumentVersion } from "./port"

type VersionEvidence = Readonly<{
  size: number
  mtimeMs: number
}>

type LocalVersion = Readonly<{
  v: 1
  sha256: string
  size: number
  mtimeMs: number
}>

export function contentHash(content: Uint8Array | string) {
  return createHash("sha256").update(content).digest("hex")
}

export function localDocumentVersion(content: Uint8Array, evidence: VersionEvidence): DocumentVersion {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      sha256: contentHash(content),
      size: evidence.size,
      mtimeMs: evidence.mtimeMs,
    } satisfies LocalVersion),
  ).toString("base64url") as DocumentVersion
}

export function documentVersionContentHash(version: DocumentVersion) {
  return parseLocalDocumentVersion(version)?.sha256
}

export function documentVersionsMatch(expected: DocumentVersion, current: DocumentVersion) {
  const expectedHash = documentVersionContentHash(expected)
  return !!expectedHash && expectedHash === documentVersionContentHash(current)
}

function parseLocalDocumentVersion(version: DocumentVersion): LocalVersion | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(version, "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object") return undefined
    if (!("v" in parsed) || parsed.v !== 1) return undefined
    if (!("sha256" in parsed) || typeof parsed.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.sha256)) return undefined
    if (!("size" in parsed) || typeof parsed.size !== "number" || !Number.isSafeInteger(parsed.size) || parsed.size < 0) return undefined
    if (!("mtimeMs" in parsed) || typeof parsed.mtimeMs !== "number" || !Number.isFinite(parsed.mtimeMs)) return undefined
    return { v: 1, sha256: parsed.sha256, size: parsed.size, mtimeMs: parsed.mtimeMs }
  } catch {
    return undefined
  }
}
