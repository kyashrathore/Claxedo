import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/cache.ts
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// src/source.ts
var AgentExtensionSourceError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionSourceError";
  }
};
function safeRelativePath(input, label = "path") {
  const trimmed = input.trim();
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) throw new AgentExtensionSourceError(`${label} must be relative`);
  const value = trimmed.replace(/\/+$/g, "");
  if (!value) throw new AgentExtensionSourceError(`${label} must be a non-empty relative path`);
  if (input.includes("\\") || value.includes("\\")) throw new AgentExtensionSourceError(`${label} must not contain backslashes`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AgentExtensionSourceError(`${label} must stay inside the package root`);
  }
  return parts.join("/");
}

// src/cache.ts
var AgentExtensionCacheError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionCacheError";
  }
};
function agentExtensionCacheRoot(input) {
  return path.join(input.dataRoot, "agent-extensions", "cache");
}
function safeSha(input) {
  if (!/^[A-Fa-f0-9]{7,64}$/.test(input)) throw new AgentExtensionCacheError("resolved SHA must be a hex string");
  return input.toLowerCase();
}
function cachePackageRoot(input) {
  return path.join(
    agentExtensionCacheRoot({ dataRoot: input.dataRoot }),
    safeSha(input.resolvedSha),
    input.packagePath ? safeRelativePath(input.packagePath, "cache package path") : ""
  );
}
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function walkFiles(root, current = root) {
  const entries = (await fs.readdir(current, { withFileTypes: true })).filter((entry) => !(entry.isDirectory() && entry.name === ".git"));
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AgentExtensionCacheError(`Cache source symlinks are not supported: ${path.relative(root, full)}`);
    }
    if (entry.isDirectory()) return walkFiles(root, full);
    if (entry.isFile()) return [full];
    return [];
  }));
  return nested.flat();
}
async function digestDirectory(root) {
  const hash = crypto.createHash("sha256");
  const realRoot = await fs.realpath(root);
  const files = (await walkFiles(realRoot)).sort((a, b) => path.relative(realRoot, a).localeCompare(path.relative(realRoot, b)));
  for (const file of files) {
    const relative = path.relative(realRoot, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
async function copyPackageToCache(input) {
  const packagePath = input.packagePath ? safeRelativePath(input.packagePath, "package path") : void 0;
  const source = packagePath ? path.join(input.sourceRoot, packagePath) : input.sourceRoot;
  const realSourceRoot = await fs.realpath(input.sourceRoot);
  const realSource = await fs.realpath(source).catch(() => {
    throw new AgentExtensionSourceError("package path must point to an existing directory");
  });
  if (!contained(realSourceRoot, realSource)) throw new AgentExtensionSourceError("package path must stay inside the fetched root");
  if (!await fs.stat(realSource).then((stat) => stat.isDirectory()).catch(() => false)) {
    throw new AgentExtensionSourceError("package path must point to a directory");
  }
  await digestDirectory(realSource);
  const target = cachePackageRoot({
    resolvedSha: input.resolvedSha,
    ...packagePath ? { packagePath } : {},
    dataRoot: input.dataRoot
  });
  const staging = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 493 });
  await fs.cp(realSource, staging, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (source2) => !path.relative(realSource, source2).split(path.sep).includes(".git")
  });
  try {
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
  return {
    path: target,
    checksum: await digestDirectory(target)
  };
}
export {
  AgentExtensionCacheError,
  agentExtensionCacheRoot,
  cachePackageRoot,
  copyPackageToCache,
  digestDirectory
};
