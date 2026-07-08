import fs from "fs/promises"
import path from "path"
import type { HarnessTarget } from "./manifest"
import type { PackageInstallSource } from "./source"

export type ExtensionLock = {
  version: 1
  packages: Record<string, LockedExtensionPackage>
}

export type LockedExtensionPackage = {
  source: PackageInstallSource
  resolved_sha: string
  package_path?: string
  manifest_digests: Record<string, string>
  component_digests: Record<string, string>
  targets: HarnessTarget[]
}

export function lockStatePath(root: string) {
  return path.join(root, "lock.json")
}

function sortedRecord(input: Record<string, string>) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))
}

function sortedPackage(input: LockedExtensionPackage): LockedExtensionPackage {
  return {
    source: input.source,
    resolved_sha: input.resolved_sha,
    ...(input.package_path ? { package_path: input.package_path } : {}),
    manifest_digests: sortedRecord(input.manifest_digests),
    component_digests: sortedRecord(input.component_digests),
    targets: [...input.targets].sort(),
  }
}

export function sortedLock(input: ExtensionLock): ExtensionLock {
  return {
    version: 1,
    packages: Object.fromEntries(
      Object.entries(input.packages)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, sortedPackage(value)]),
    ),
  }
}

export function encodeLock(input: ExtensionLock) {
  return JSON.stringify(sortedLock(input), null, 2) + "\n"
}

export async function readExtensionLock(file: string): Promise<ExtensionLock> {
  const data = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as Partial<ExtensionLock>).catch(() => null)
  if (!data) return { version: 1, packages: {} }
  return sortedLock({
    version: 1,
    packages: data.packages ?? {},
  })
}

export async function writeExtensionLock(file: string, lock: ExtensionLock) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
  await fs.writeFile(file, encodeLock(lock), { mode: 0o644 })
}
