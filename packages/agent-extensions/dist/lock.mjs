import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/lock.ts
import fs2 from "fs/promises";
import path2 from "path";

// src/fs-safe.ts
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
async function writeFileAtomic(file, data, mode = 420) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, data, { mode });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
async function readFileIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw err;
  }
}

// src/state.ts
var AgentExtensionStateError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionStateError";
  }
};

// src/lock.ts
function lockStatePath(root) {
  return path2.join(root, "lock.json");
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
  const raw = await readFileIfExists(file);
  if (raw === void 0) return { version: 1, packages: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new AgentExtensionStateError(
      `Agent Extension lock file ${file} is not valid JSON; fix or remove it: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return sortedLock({
    version: 1,
    packages: data.packages ?? {}
  });
}
async function writeExtensionLock(file, lock) {
  await fs2.mkdir(path2.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, encodeLock(lock));
}
export {
  encodeLock,
  lockStatePath,
  readExtensionLock,
  sortedLock,
  writeExtensionLock
};
