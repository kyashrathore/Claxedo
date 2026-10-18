import { writeFile } from "node:fs/promises"
import path from "node:path"
import { readTextIfExists } from "@claxedo/helpers/fs"
import { isFiniteNumber, isRecord, isString, isStringList } from "@claxedo/helpers/guards"
import { isCorpusManifest, type ReadinessTarget } from "./corpus"
import type { MaterializedCorpus } from "./materialize"

type CachedCorpus = Omit<MaterializedCorpus, "targets" | "workspaces" | "projects"> & {
  targets: Array<[string, ReadinessTarget]>
  workspaces: Array<[string, string]>
  projects: Array<[string, string]>
}

export type PreparedIdentity = { corpusDigestSha256: string; buildDigestSha256: string }

type PreparedCache = PreparedIdentity & { materialization: CachedCorpus }

const PREPARED_CACHE_FILE = "prepared.json"

function isReadinessTarget(value: unknown): value is ReadinessTarget {
  return isRecord(value)
    && isString(value.logicalSessionId)
    && isString(value.sessionId)
    && isString(value.workspaceId)
    && isString(value.title)
    && isStringList(value.latestTurnMessageIds)
}

function isEntryList<V>(value: unknown, isValue: (entry: unknown) => entry is V): value is Array<[string, V]> {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2 && isString(entry[0]) && isValue(entry[1]))
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString)
}

function isCachedCorpus(value: unknown): value is CachedCorpus {
  return isRecord(value)
    && isCorpusManifest(value.manifest)
    && isEntryList(value.targets, isReadinessTarget)
    && isEntryList(value.workspaces, isString)
    && isEntryList(value.projects, isString)
    && isStringRecord(value.sessionMapping)
    && isString(value.mappingDigestSha256)
    && isFiniteNumber(value.messageCount)
    && isFiniteNumber(value.transcriptBytes)
}

function isPreparedCache(value: unknown): value is PreparedCache {
  return isRecord(value) && isString(value.corpusDigestSha256) && isString(value.buildDigestSha256) && isCachedCorpus(value.materialization)
}

export async function readPreparedCache(stateRoot: string, identity: PreparedIdentity): Promise<MaterializedCorpus | undefined> {
  const text = await readTextIfExists(path.join(stateRoot, PREPARED_CACHE_FILE))
  if (text === undefined) return undefined
  const cache: unknown = JSON.parse(text)
  if (!isPreparedCache(cache)) throw new Error("Claxedo's prepared-state cache is malformed")
  if (cache.corpusDigestSha256 !== identity.corpusDigestSha256 || cache.buildDigestSha256 !== identity.buildDigestSha256) {
    throw new Error("Claxedo's prepared-state cache belongs to a different corpus or build")
  }
  const cached = cache.materialization
  return { ...cached, targets: new Map(cached.targets), workspaces: new Map(cached.workspaces), projects: new Map(cached.projects) }
}

export async function writePreparedCache(stateRoot: string, identity: PreparedIdentity, materialization: MaterializedCorpus) {
  const cache: PreparedCache = {
    ...identity,
    materialization: {
      ...materialization,
      targets: [...materialization.targets],
      workspaces: [...materialization.workspaces],
      projects: [...materialization.projects],
    },
  }
  await writeFile(path.join(stateRoot, PREPARED_CACHE_FILE), JSON.stringify(cache), { mode: 0o600 })
}
