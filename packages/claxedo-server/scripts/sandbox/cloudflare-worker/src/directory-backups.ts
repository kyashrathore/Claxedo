import { asWorkerRecord } from "./worker-json"

export type DirectoryBackup = { id: string; dir: string }

export interface BackupBucket {
  delete(key: string): Promise<void>
}

const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_DIRECTORIES = 4

/** Distinct absolute directories, none inside another, in the order the driver sent them. */
export function captureDirectories(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_DIRECTORIES) return undefined
  const directories = input.filter((dir): dir is string =>
    typeof dir === "string" && dir.startsWith("/") && dir.length > 1 && !dir.endsWith("/") && !dir.split("/").includes(".."))
  if (directories.length !== input.length) return undefined
  const nested = directories.some((dir, i) => directories.some((other, j) => i !== j && (dir === other || dir.startsWith(`${other}/`))))
  return nested ? undefined : directories
}

/** A checkpoint's provider reference is its backups' ids, one per captured directory, joined in capture order. */
export function backupIds(input: unknown): string[] | undefined {
  if (typeof input !== "string") return undefined
  const ids = input.split(",")
  return ids.every((id) => BACKUP_ID.test(id)) ? ids : undefined
}

export function directoryRestore(input: unknown): DirectoryBackup[] | undefined {
  const restore = asWorkerRecord(input)
  const directories = captureDirectories(restore?.directories)
  const ids = backupIds(restore?.backupId)
  if (!directories || !ids || ids.length !== directories.length) return undefined
  return directories.map((dir, index) => ({ id: ids[index], dir }))
}

/** The pending backup ids a lease did not commit: nothing will ever reference or delete them. */
export function uncommittedBackups(pending: readonly string[], committed: string | undefined) {
  const kept = new Set(backupIds(committed) ?? [])
  return pending.filter((id) => !kept.has(id))
}

/** @cloudflare/sandbox 0.12.9 stores a backup as `backups/<id>/data.sqsh` plus `meta.json` and never deletes either. */
export async function deleteBackups(bucket: BackupBucket, ids: readonly string[]) {
  await Promise.all(ids.flatMap((id) => [`backups/${id}/data.sqsh`, `backups/${id}/meta.json`].map((key) => bucket.delete(key))))
}
