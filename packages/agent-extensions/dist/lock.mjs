import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/lock.ts
import fs from "fs/promises";
import path from "path";
function lockStatePath(root) {
  return path.join(root, "lock.json");
}
function sortedRecord(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function sortedPackage(input) {
  return {
    source: input.source,
    resolved_sha: input.resolved_sha,
    ...input.package_path ? { package_path: input.package_path } : {},
    manifest_digests: sortedRecord(input.manifest_digests),
    component_digests: sortedRecord(input.component_digests),
    targets: [...input.targets].sort()
  };
}
function sortedLock(input) {
  return {
    version: 1,
    packages: Object.fromEntries(
      Object.entries(input.packages).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, sortedPackage(value)])
    )
  };
}
function encodeLock(input) {
  return JSON.stringify(sortedLock(input), null, 2) + "\n";
}
async function readExtensionLock(file) {
  const data = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
  if (!data) return { version: 1, packages: {} };
  return sortedLock({
    version: 1,
    packages: data.packages ?? {}
  });
}
async function writeExtensionLock(file, lock) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 493 });
  await fs.writeFile(file, encodeLock(lock), { mode: 420 });
}
export {
  encodeLock,
  lockStatePath,
  readExtensionLock,
  sortedLock,
  writeExtensionLock
};
