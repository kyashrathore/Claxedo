import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/fetch.ts
import fs2 from "fs/promises";
import os from "os";
import path2 from "path";
import { execFile as nodeExecFile } from "child_process";
import { promisify } from "util";

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

// src/fetch.ts
var execFileAsync = promisify(nodeExecFile);
var AgentExtensionFetchError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionFetchError";
  }
};
function execFileDefault(file, args, options) {
  return execFileAsync(file, args, options);
}
function githubRepoUrl(source) {
  return `https://github.com/${source.owner}/${source.repo}.git`;
}
function parseSha(output) {
  const match = output.split(/\r?\n/).map((line) => /^([a-f0-9]{40})\s+/.exec(line)?.[1]).find(Boolean);
  if (!match) throw new AgentExtensionFetchError("GitHub source did not resolve to a commit SHA");
  return match;
}
async function resolveGitHubSource(source, execFile = execFileDefault) {
  if (source.type !== "github") throw new AgentExtensionFetchError("Only GitHub package sources are supported");
  const url = githubRepoUrl(source);
  const args = source.ref ? ["ls-remote", url, source.ref, `refs/heads/${source.ref}`, `refs/tags/${source.ref}`] : ["ls-remote", url, "HEAD"];
  return parseSha((await execFile("git", args)).stdout);
}
async function fetchGitHubPackageToCache(input) {
  const execFile = input.execFile ?? execFileDefault;
  if (input.source.type !== "github") throw new AgentExtensionFetchError("Only GitHub package sources are supported");
  const resolvedSha = input.resolvedSha ?? await resolveGitHubSource(input.source, execFile);
  const tempRoot = await fs2.mkdtemp(path2.join(input.tempRoot ?? os.tmpdir(), "claxedo-agent-extension-"));
  try {
    await execFile("git", ["init", tempRoot]);
    await execFile("git", ["remote", "add", "origin", githubRepoUrl(input.source)], { cwd: tempRoot });
    await execFile("git", ["fetch", "--depth", "1", "origin", resolvedSha], { cwd: tempRoot });
    await execFile("git", ["checkout", "--detach", resolvedSha], { cwd: tempRoot });
    return {
      ...await copyPackageToCache({
        sourceRoot: tempRoot,
        resolvedSha,
        ...input.source.package_path ? { packagePath: input.source.package_path } : {},
        dataRoot: input.dataRoot
      }),
      resolvedSha
    };
  } finally {
    await fs2.rm(tempRoot, { recursive: true, force: true });
  }
}
export {
  AgentExtensionFetchError,
  fetchGitHubPackageToCache,
  githubRepoUrl,
  resolveGitHubSource
};
