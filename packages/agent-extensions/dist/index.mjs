import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/facade.ts
import fs12 from "fs/promises";
import os3 from "os";
import path16 from "path";

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
var ownerRepo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@(.+))?$/;
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
function safeRef(input) {
  const value = input.trim();
  if (!value) throw new AgentExtensionSourceError("GitHub ref must be non-empty");
  if (value.includes("\\") || value.includes("..") || value.startsWith("/") || value.endsWith("/") || value.startsWith("-")) {
    throw new AgentExtensionSourceError("GitHub ref is unsafe");
  }
  return value;
}
function source(input) {
  const repo = input.repo.endsWith(".git") ? input.repo.slice(0, -4) : input.repo;
  if (!input.owner || !repo) throw new AgentExtensionSourceError("GitHub source must include owner and repo");
  return {
    type: "github",
    owner: input.owner,
    repo,
    ...input.ref ? { ref: safeRef(input.ref) } : {},
    ...input.packagePath ? { package_path: safeRelativePath(input.packagePath, "package path") } : {}
  };
}
function parsePackageSource(input) {
  const value = input.trim();
  if (value.includes("\\") || value.includes("/../") || value.includes("/./")) {
    throw new AgentExtensionSourceError("package path must stay inside the package root");
  }
  const shorthand = ownerRepo.exec(value);
  if (shorthand) {
    return source({
      owner: shorthand[1],
      repo: shorthand[2],
      ...shorthand[3] ? { ref: shorthand[3] } : {}
    });
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AgentExtensionSourceError(`Unsupported Agent Extension source: ${input}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new AgentExtensionSourceError("Only https://github.com sources are supported");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new AgentExtensionSourceError("GitHub source must include owner and repo");
  if (parts.length === 2) return source({ owner: parts[0], repo: parts[1] });
  if (parts[2] !== "tree" || parts.length < 4) {
    throw new AgentExtensionSourceError("Only GitHub repo roots and /tree/<ref>/<path> sources are supported");
  }
  return source({
    owner: parts[0],
    repo: parts[1],
    ref: decodeURIComponent(parts[3]),
    ...parts.length > 4 ? { packagePath: parts.slice(4).map(decodeURIComponent).join("/") } : {}
  });
}
function sourceKey(input) {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
}
function sameSource(left, right) {
  return sourceKey(left) === sourceKey(right);
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
  const relative2 = path.relative(root, target);
  return relative2 === "" || !!relative2 && !relative2.startsWith("..") && !path.isAbsolute(relative2);
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
    const relative2 = path.relative(realRoot, file).split(path.sep).join("/");
    hash.update(relative2);
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
async function copyPackageToCache(input) {
  const packagePath = input.packagePath ? safeRelativePath(input.packagePath, "package path") : void 0;
  const source3 = packagePath ? path.join(input.sourceRoot, packagePath) : input.sourceRoot;
  const realSourceRoot = await fs.realpath(input.sourceRoot);
  const realSource = await fs.realpath(source3).catch(() => {
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
    filter: (source4) => !path.relative(realSource, source4).split(path.sep).includes(".git")
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
import fs2 from "fs/promises";
import os from "os";
import path2 from "path";
import { execFile as nodeExecFile } from "child_process";
import { promisify } from "util";
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
function githubRepoUrl(source3) {
  return `https://github.com/${source3.owner}/${source3.repo}.git`;
}
function parseSha(output) {
  const match = output.split(/\r?\n/).map((line) => /^([a-f0-9]{40})\s+/.exec(line)?.[1]).find(Boolean);
  if (!match) throw new AgentExtensionFetchError("GitHub source did not resolve to a commit SHA");
  return match;
}
async function resolveGitHubSource(source3, execFile2 = execFileDefault) {
  if (source3.type !== "github") throw new AgentExtensionFetchError("Only GitHub package sources are supported");
  const url = githubRepoUrl(source3);
  const args = source3.ref ? ["ls-remote", url, source3.ref, `refs/heads/${source3.ref}`, `refs/tags/${source3.ref}`] : ["ls-remote", url, "HEAD"];
  return parseSha((await execFile2("git", args)).stdout);
}
async function fetchGitHubPackageToCache(input) {
  const execFile2 = input.execFile ?? execFileDefault;
  if (input.source.type !== "github") throw new AgentExtensionFetchError("Only GitHub package sources are supported");
  const resolvedSha2 = input.resolvedSha ?? await resolveGitHubSource(input.source, execFile2);
  const tempRoot = await fs2.mkdtemp(path2.join(input.tempRoot ?? os.tmpdir(), "claxedo-agent-extension-"));
  try {
    await execFile2("git", ["init", tempRoot]);
    await execFile2("git", ["remote", "add", "origin", githubRepoUrl(input.source)], { cwd: tempRoot });
    await execFile2("git", ["fetch", "--depth", "1", "origin", resolvedSha2], { cwd: tempRoot });
    await execFile2("git", ["checkout", "--detach", resolvedSha2], { cwd: tempRoot });
    return {
      ...await copyPackageToCache({
        sourceRoot: tempRoot,
        resolvedSha: resolvedSha2,
        ...input.source.package_path ? { packagePath: input.source.package_path } : {},
        dataRoot: input.dataRoot
      }),
      resolvedSha: resolvedSha2
    };
  } finally {
    await fs2.rm(tempRoot, { recursive: true, force: true });
  }
}

// src/install.ts
import path13 from "path";

// src/types.ts
var HARNESS_TARGETS = ["opencode", "claude", "codex", "cursor"];
var FIRST_PARTY_AGENT_EXTENSION_ID = "first-party-agent-extensions";
var FIRST_PARTY_AGENT_EXTENSIONS_DIR = "agent-extensions";
var FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME = "agent-extensions";
function isHarnessTarget(input) {
  return HARNESS_TARGETS.includes(input);
}
function allHarnessTargets() {
  return [...HARNESS_TARGETS];
}

// src/manifest.ts
import fs3 from "fs/promises";
import path3 from "path";
var AgentExtensionManifestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionManifestError";
  }
};
var marketplaceManifests = [
  { runner: "cursor", path: ".cursor-plugin/marketplace.json" },
  { runner: "codex", path: ".agents/plugins/marketplace.json" },
  { runner: "claude", path: ".claude-plugin/marketplace.json" }
];
var pluginManifests = [
  { runner: "claude", path: ".claude-plugin/plugin.json" },
  { runner: "codex", path: ".codex-plugin/plugin.json" },
  { runner: "cursor", path: ".cursor-plugin/plugin.json" }
];
var mcpConfigs = ["mcp.json", ".vscode/mcp.json"];
async function exists(file) {
  return fs3.stat(file).then((item) => item.isFile()).catch(() => false);
}
async function readJson(file) {
  try {
    return JSON.parse(await fs3.readFile(file, "utf8"));
  } catch (err) {
    throw new AgentExtensionManifestError(`${path3.basename(file)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function manifestName(manifest, file) {
  if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name.trim();
  throw new AgentExtensionManifestError(`${file} must include a non-empty name`);
}
function rawCatalogEntries(manifest) {
  if (Array.isArray(manifest.packages)) return manifest.packages;
  if (Array.isArray(manifest.plugins)) return manifest.plugins;
  if (Array.isArray(manifest.entries)) return manifest.entries;
  return [];
}
function catalogEntryPath(input) {
  try {
    return safeRelativePath(input, "catalog entry path");
  } catch (err) {
    if (err instanceof AgentExtensionSourceError) throw new AgentExtensionManifestError(err.message);
    throw err;
  }
}
async function catalogEntries(root, manifest) {
  return await Promise.all(rawCatalogEntries(manifest).map(async (item) => {
    if (!item || typeof item !== "object") throw new AgentExtensionManifestError("Catalog entries must be objects");
    const value = item;
    const rawPath = typeof value.path === "string" ? value.path : typeof value.package_path === "string" ? value.package_path : void 0;
    if (!rawPath) throw new AgentExtensionManifestError("Catalog entries must include a local path");
    if (/^(?:https?:|git\+|npm:|file:)/.test(rawPath)) throw new AgentExtensionManifestError("Catalog entries must stay in the same GitHub repo");
    const entryPath = catalogEntryPath(rawPath);
    if (!await fs3.stat(path3.join(root, entryPath)).then((stat) => stat.isDirectory()).catch(() => false)) {
      throw new AgentExtensionManifestError(`Catalog entry ${entryPath} must point to a non-empty local directory`);
    }
    if ((await fs3.readdir(path3.join(root, entryPath))).length === 0) {
      throw new AgentExtensionManifestError(`Catalog entry ${entryPath} must point to a non-empty local directory`);
    }
    return {
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : path3.basename(entryPath),
      path: entryPath
    };
  }));
}
async function discoverMarketplace(root) {
  return (await Promise.all(marketplaceManifests.map(async (item) => ({
    ...item,
    exists: await exists(path3.join(root, item.path))
  })))).filter((item) => item.exists);
}
async function discoverPlugins(root) {
  return (await Promise.all(pluginManifests.map(async (item) => ({
    ...item,
    exists: await exists(path3.join(root, item.path))
  })))).filter((item) => item.exists);
}
async function discoverAgentExtensionPackage(root) {
  const marketplaces = await discoverMarketplace(root);
  const plugins = await discoverPlugins(root);
  if (marketplaces.length > 0 && plugins.length > 0) {
    throw new AgentExtensionManifestError("Agent Extension root is ambiguous: marketplace and plugin manifests both exist");
  }
  if (marketplaces.length > 0) {
    const selected = marketplaces[0];
    const manifest = await readJson(path3.join(root, selected.path));
    return {
      type: "marketplace",
      runner: selected.runner,
      manifest_path: selected.path,
      manifest,
      entries: await catalogEntries(root, manifest)
    };
  }
  if (plugins.length > 0) {
    const manifests = await Promise.all(plugins.map(async (item) => ({
      runner: item.runner,
      path: item.path,
      manifest: await readJson(path3.join(root, item.path))
    })));
    const names = new Set(manifests.map((item) => manifestName(item.manifest, item.path)));
    if (names.size !== 1) throw new AgentExtensionManifestError("Plugin manifests in one package root must use the same name");
    return { type: "native-plugin", name: [...names][0], manifests };
  }
  if (await exists(path3.join(root, "SKILL.md"))) {
    return { type: "standalone-skill", name: path3.basename(root), skill_path: "SKILL.md" };
  }
  const mcp = (await Promise.all(mcpConfigs.map(async (item) => ({
    path: item,
    exists: await exists(path3.join(root, item))
  })))).find((item) => item.exists);
  if (mcp) {
    return {
      type: "standalone-mcp",
      name: path3.basename(root),
      config_path: mcp.path,
      config: await readJson(path3.join(root, mcp.path))
    };
  }
  throw new AgentExtensionManifestError("Unsupported Agent Extension package shape");
}

// src/materialize.ts
import fs9 from "fs/promises";
import path11 from "path";

// src/discovery.ts
import fs4 from "fs/promises";
import path4 from "path";
async function fileExists(file) {
  return fs4.stat(file).then((item) => item.isFile()).catch(() => false);
}
async function dirExists(dir) {
  return fs4.stat(dir).then((item) => item.isDirectory()).catch(() => false);
}
async function readDir(dir) {
  return fs4.readdir(dir, { withFileTypes: true }).catch(() => []);
}
function componentName(fileOrDir) {
  const base = path4.basename(fileOrDir);
  const ext = path4.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}
async function pluginName(file, fallback) {
  const manifest = JSON.parse(await fs4.readFile(file, "utf8"));
  return typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : fallback;
}
async function discoverSkills(root) {
  const skillsDir = path4.join(root, "skills");
  const conventional = (await Promise.all((await readDir(skillsDir)).filter((entry) => entry.isDirectory()).map(async (entry) => {
    const skillDir = path4.join(skillsDir, entry.name);
    if (!await fileExists(path4.join(skillDir, "SKILL.md"))) return [];
    return [{ type: "skill", name: entry.name, path: skillDir }];
  }))).flat();
  if (conventional.length > 0) return conventional;
  if (!await fileExists(path4.join(root, "SKILL.md"))) return [];
  return [{ type: "skill", name: path4.basename(root), path: root }];
}
async function discoverMcp(root) {
  const mcpDir = path4.join(root, "mcp");
  const conventional = (await readDir(mcpDir)).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => ({
    type: "mcp",
    name: componentName(entry.name),
    path: path4.join(mcpDir, entry.name)
  }));
  if (conventional.length > 0) return conventional;
  if (await fileExists(path4.join(root, "mcp.json"))) {
    return [{ type: "mcp", name: path4.basename(root), path: path4.join(root, "mcp.json") }];
  }
  if (await fileExists(path4.join(root, ".vscode", "mcp.json"))) {
    return [{ type: "mcp", name: path4.basename(root), path: path4.join(root, ".vscode", "mcp.json") }];
  }
  return [];
}
async function discoverCursorPlugins(root) {
  const pluginsDir = path4.join(root, "plugins", "cursor");
  const nested = (await Promise.all((await readDir(pluginsDir)).filter((entry) => entry.isDirectory()).map(async (entry) => {
    const pluginDir = path4.join(pluginsDir, entry.name);
    if (!await fileExists(path4.join(pluginDir, "plugin.json"))) return [];
    return [{ type: "plugin", runner: "cursor", name: entry.name, path: pluginDir }];
  }))).flat();
  if (nested.length > 0) return nested;
  const conventionalPlugin = path4.join(pluginsDir, "plugin.json");
  if (await fileExists(conventionalPlugin)) {
    return [{
      type: "plugin",
      runner: "cursor",
      name: await pluginName(conventionalPlugin, path4.basename(root)),
      path: pluginsDir
    }];
  }
  const legacyPlugin = path4.join(root, ".cursor-plugin", "plugin.json");
  if (await fileExists(legacyPlugin)) {
    return [{
      type: "plugin",
      runner: "cursor",
      name: await pluginName(legacyPlugin, path4.basename(root)),
      path: root
    }];
  }
  return [];
}
function hookRunner(name) {
  if (name === "claude" || name === "codex" || name === "cursor" || name === "opencode") return name;
  if (name === "droid" || name === "gemini" || name === "mastra") return name;
  return void 0;
}
async function discoverHooks(root) {
  const hooksDir = path4.join(root, "hooks");
  return (await readDir(hooksDir)).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
    const name = componentName(entry.name);
    const runner = hookRunner(name);
    if (!runner) return [];
    return [{ type: "hook", runner, name, path: path4.join(hooksDir, entry.name) }];
  });
}
async function discoverAgentExtensionComponents(root) {
  if (!await dirExists(root)) return [];
  return [
    ...await discoverSkills(root),
    ...await discoverMcp(root),
    ...await discoverCursorPlugins(root),
    ...await discoverHooks(root)
  ];
}

// src/materializers/cursor.ts
import path8 from "path";

// src/materialization.ts
import fs7 from "fs/promises";
import path7 from "path";

// src/fs-safe.ts
import crypto2 from "crypto";
import fs5 from "fs/promises";
import path5 from "path";
async function writeFileAtomic(file, data, mode = 420) {
  const tmp = path5.join(path5.dirname(file), `.${path5.basename(file)}.${crypto2.randomBytes(6).toString("hex")}.tmp`);
  await fs5.writeFile(tmp, data, { mode });
  try {
    await fs5.rename(tmp, file);
  } catch (err) {
    await fs5.rm(tmp, { force: true });
    throw err;
  }
}
async function readFileIfExists(file) {
  try {
    return await fs5.readFile(file, "utf8");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw err;
  }
}
var STATE_LOCK_STALE_MS = 10 * 60 * 1e3;
async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function withAgentExtensionStateLock(root, fn) {
  const lock = path5.join(root, ".replay-lock");
  await fs5.mkdir(root, { recursive: true, mode: 493 });
  while (true) {
    try {
      await fs5.mkdir(lock, { mode: 493 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const stat = await fs5.stat(lock).catch(() => void 0);
      if (stat && Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
        await fs5.rm(lock, { recursive: true, force: true });
        continue;
      }
      await wait(100);
    }
  }
  try {
    return await fn();
  } finally {
    await fs5.rm(lock, { recursive: true, force: true });
  }
}

// src/state.ts
import fs6 from "fs/promises";
import path6 from "path";
var AgentExtensionStateError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionStateError";
  }
};
function agentExtensionStateRoot(input) {
  if (input.scope === "project") {
    if (!input.projectDir) throw new AgentExtensionStateError("projectDir is required for project Agent Extension state");
    return path6.join(input.projectDir, ".agent-extensions");
  }
  if (input.scope === "workspace") {
    if (!input.workspaceId) throw new AgentExtensionStateError("workspaceId is required for workspace Agent Extension state");
    if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for workspace Agent Extension state");
    return path6.join(input.dataRoot, "agent-extensions", "workspaces", input.workspaceId);
  }
  if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for machine Agent Extension state");
  return path6.join(input.dataRoot, "agent-extensions");
}
function installedStatePath(input) {
  return path6.join(agentExtensionStateRoot(input), "installed.json");
}
function sortedInstall(input) {
  return {
    ...input,
    targets: [...input.targets].sort()
  };
}
function sortedState(input) {
  return {
    version: 1,
    installs: input.installs.map(sortedInstall).sort((a, b) => a.id.localeCompare(b.id))
  };
}
function encodeDesiredState(input) {
  return JSON.stringify(sortedState(input), null, 2) + "\n";
}
async function readDesiredExtensionState(file) {
  const raw = await readFileIfExists(file);
  if (raw === void 0) return { version: 1, installs: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new AgentExtensionStateError(
      `Agent Extension state file ${file} is not valid JSON; fix or remove it (treating it as empty would uninstall every recorded extension): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return sortedState({
    version: 1,
    installs: Array.isArray(data.installs) ? data.installs : []
  });
}
async function writeDesiredExtensionState(file, state) {
  await fs6.mkdir(path6.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, encodeDesiredState(state));
}
async function upsertDesiredExtensionInstall(file, install) {
  const current = await readDesiredExtensionState(file);
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: [...current.installs.filter((item) => item.id !== install.id), install]
  });
}
async function removeDesiredExtensionInstall(file, id) {
  const current = await readDesiredExtensionState(file);
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: current.installs.filter((item) => item.id !== id)
  });
}
async function setDesiredExtensionEnabled(file, id, enabled, updatedAt = Date.now()) {
  const current = await readDesiredExtensionState(file);
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: current.installs.map((item) => item.id === id ? {
      ...item,
      enabled,
      updated_at: updatedAt
    } : item)
  });
}

// src/materialization.ts
var AgentExtensionMaterializationError = class extends Error {
  constructor(message, code = "agent_extension_materialization_error", details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AgentExtensionMaterializationError";
  }
};
function materializedRecordPath(root) {
  return path7.join(root, "materialized.json");
}
async function readMaterializedRuntimeRecord(file) {
  const raw = await readFileIfExists(file);
  if (raw === void 0) return { version: 1, packages: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new AgentExtensionStateError(
      `Materialized Agent Extension record ${file} is not valid JSON; fix or remove it (it is the ownership record that guards deletions): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return {
    version: 1,
    packages: data.packages ?? {}
  };
}
async function writeMaterializedRuntimeRecord(file, record) {
  await fs7.mkdir(path7.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, JSON.stringify({
    version: 1,
    packages: Object.fromEntries(Object.entries(record.packages).sort(([a], [b]) => a.localeCompare(b)))
  }, null, 2) + "\n");
}
function componentOwnedBy(record, targetPath, ownerId) {
  return record?.packages[ownerId]?.components.some((item) => item.path === targetPath && item.status === "applied") ?? false;
}
async function sameRealPath(a, b) {
  const [left, right] = await Promise.all([
    fs7.realpath(a).catch(() => null),
    fs7.realpath(b).catch(() => null)
  ]);
  return !!left && left === right;
}
function agentExtensionCacheKey(input) {
  const parts = path7.resolve(input).split(path7.sep);
  const root = parts.findIndex(
    (part, index) => part === ".agent-extensions" && parts[index + 1] === "cache"
  );
  return root === -1 ? void 0 : parts.slice(root + 2).join("/");
}
async function isGeneratedCacheSymlinkToSamePackage(input) {
  if (!input.existing.isSymbolicLink()) return false;
  const [source3, target] = await Promise.all([
    fs7.realpath(input.sourceDir).catch(() => void 0),
    fs7.realpath(input.targetDir).catch(() => void 0)
  ]);
  if (!source3 || !target) return false;
  const sourceKey2 = agentExtensionCacheKey(source3);
  return !!sourceKey2 && sourceKey2 === agentExtensionCacheKey(target);
}
async function emptyDir(target) {
  await fs7.rm(target, { recursive: true, force: true });
  await fs7.mkdir(path7.dirname(target), { recursive: true, mode: 493 });
}
async function linkOrCopyOwnedDirectory(input) {
  if (path7.resolve(input.sourceDir) === path7.resolve(input.targetDir) || await sameRealPath(input.sourceDir, input.targetDir)) {
    if (componentOwnedBy(input.record, input.targetDir, input.ownerId)) {
      return { status: "applied", path: input.targetDir };
    }
    return { status: "skipped", reason: "source already at target path", path: input.targetDir };
  }
  const existing = await fs7.lstat(input.targetDir).catch(() => null);
  if (existing) {
    const owned = componentOwnedBy(input.record, input.targetDir, input.ownerId);
    const adoptable = owned ? false : await isGeneratedCacheSymlinkToSamePackage({
      sourceDir: input.sourceDir,
      targetDir: input.targetDir,
      existing
    });
    if (!owned && !adoptable) {
      throw new AgentExtensionMaterializationError(
        `Refusing to overwrite unmanaged Agent Extension artifact at ${input.targetDir}`,
        "agent_extension_target_path_conflict",
        {
          ownerId: input.ownerId,
          targetPath: input.targetDir
        }
      );
    }
    if (owned && !input.replaceOwned) {
      return { status: "drifted", reason: "owned artifact differs from cached source", path: input.targetDir };
    }
  }
  await emptyDir(input.targetDir);
  try {
    await (input.symlink ?? fs7.symlink)(input.sourceDir, input.targetDir, "dir");
    return { status: "applied", path: input.targetDir };
  } catch {
    await fs7.cp(input.sourceDir, input.targetDir, { recursive: true, force: true });
    return { status: "applied", path: input.targetDir, reason: "copied because symlink failed" };
  }
}

// src/materializers/cursor.ts
function cursorLocalPluginDir(input) {
  return path8.join(input.homeDir, ".cursor", "plugins", "local", input.pluginName);
}
async function materializeCursorLocalPlugin(input) {
  const result = await linkOrCopyOwnedDirectory({
    sourceDir: input.packageDir,
    targetDir: cursorLocalPluginDir(input),
    ownerId: input.ownerId,
    record: input.record,
    ...input.replaceOwned ? { replaceOwned: input.replaceOwned } : {},
    ...input.symlink ? { symlink: input.symlink } : {}
  });
  return {
    runner: "cursor",
    component: input.pluginName,
    type: "plugin",
    status: result.status,
    ...result.reason ? { reason: result.reason } : {},
    path: result.path
  };
}

// src/materializers/mcp.ts
import fs8 from "fs/promises";
import path9 from "path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
function asRecord(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}
function sortedObject(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function normalizeStandaloneMcpConfig(input) {
  const root = asRecord(input.mcpServers ?? input.servers);
  const servers = Object.fromEntries(Object.entries(root).map(([name, value]) => {
    const cfg = asRecord(value);
    if (typeof cfg.command === "string") {
      return [name, {
        command: cfg.command,
        ...Array.isArray(cfg.args) ? { args: cfg.args.filter((item) => typeof item === "string") } : {},
        ...Object.keys(asRecord(cfg.env)).length > 0 ? { env: asRecord(cfg.env) } : {}
      }];
    }
    if (typeof cfg.url === "string") {
      return [name, {
        url: cfg.url,
        ...Object.keys(asRecord(cfg.headers)).length > 0 ? { headers: asRecord(cfg.headers) } : {}
      }];
    }
    throw new AgentExtensionMaterializationError(`MCP server ${name} must include command or url`);
  }));
  if (Object.keys(servers).length === 0) throw new AgentExtensionMaterializationError("Standalone MCP config must declare at least one server");
  return { servers: sortedObject(servers) };
}
function mcpTargetPath(input) {
  if (input.runner === "cursor") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Cursor MCP materialization");
      return path9.join(input.projectDir, ".cursor", "mcp.json");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Cursor MCP materialization");
    return path9.join(input.homeDir, ".cursor", "mcp.json");
  }
  if (input.runner === "claude") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Claude MCP materialization");
      return path9.join(input.projectDir, ".mcp.json");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Claude MCP materialization");
    return path9.join(input.homeDir, ".claude.json");
  }
  if (input.runner === "codex") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Codex MCP materialization");
      return path9.join(input.projectDir, ".codex", "config.toml");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Codex MCP materialization");
    return path9.join(input.homeDir, ".codex", "config.toml");
  }
  if (input.runner === "opencode") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project OpenCode MCP materialization");
      return path9.join(input.projectDir, ".opencode", "opencode.jsonc");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine OpenCode MCP materialization");
    return path9.join(input.homeDir, ".config", "opencode", "opencode.jsonc");
  }
  return void 0;
}
function componentOwned(input) {
  return input.record?.packages[input.ownerId]?.components.some(
    (item) => item.path === input.path && item.component === input.component && item.status === "applied"
  ) ?? false;
}
function mcpComponents(input) {
  return input.names.map((name) => ({
    runner: input.runner,
    component: name,
    type: "mcp",
    status: input.drifted?.has(name) ? "drifted" : input.existing && !input.existing.has(name) ? "skipped" : "applied",
    ...input.drifted?.has(name) ? { reason: "owned MCP config differs from desired source" } : {},
    ...input.existing && !input.existing.has(name) ? { reason: "not applied because another owned MCP config drifted" } : {},
    path: input.target
  }));
}
function toRunnerMcpServers(runner, config) {
  return sortedObject(Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => {
    if ("url" in cfg) return [name, cfg];
    if (runner === "claude") return [name, {
      type: "stdio",
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {}
    }];
    return [name, {
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {}
    }];
  })));
}
function toOpenCodeMcpServers(config) {
  return sortedObject(Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => {
    if ("url" in cfg) return [name, {
      type: "remote",
      url: cfg.url,
      enabled: true,
      ...cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}
    }];
    return [name, {
      type: "local",
      command: [cfg.command, ...cfg.args ?? []],
      enabled: true,
      ...cfg.env && Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}
    }];
  })));
}
function tomlString(input) {
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function tomlKey(input) {
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : tomlString(input);
}
function tomlArray(input) {
  return `[${input.map(tomlString).join(", ")}]`;
}
function tomlInlineTable(input) {
  return `{ ${Object.entries(sortedObject(input)).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`;
}
function codexMcpSection(name, config) {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  if ("url" in config) {
    lines.push(`url = ${tomlString(config.url)}`);
    if (config.headers && Object.keys(config.headers).length > 0) lines.push(`headers = ${tomlInlineTable(config.headers)}`);
    return `${lines.join("\n")}
`;
  }
  lines.push(`command = ${tomlString(config.command)}`);
  if (config.args) lines.push(`args = ${tomlArray(config.args)}`);
  if (config.env && Object.keys(config.env).length > 0) lines.push(`env = ${tomlInlineTable(config.env)}`);
  return `${lines.join("\n")}
`;
}
function unquoteTomlKey(input) {
  return input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : input;
}
function codexMcpSections(raw) {
  const lines = raw.split(/(?<=\n)/);
  const sections = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*\[mcp_servers\.((?:"(?:\\.|[^"])+")|[A-Za-z0-9_-]+)\]\s*$/);
    const start = offset;
    offset += lines[i].length;
    if (!match) continue;
    let end = offset;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[.+\]\s*$/.test(lines[j])) break;
      end += lines[j].length;
    }
    sections.push({ name: unquoteTomlKey(match[1]), start, end, body: raw.slice(start, end) });
  }
  return sections;
}
async function readText(file) {
  return await readFileIfExists(file) ?? "";
}
async function readJson2(file) {
  const raw = await readFileIfExists(file);
  if (raw === void 0 || !raw.trim()) return {};
  return readJsonFromText(raw, file);
}
function readJsonFromText(raw, file) {
  const errors = [];
  const parsed = parseJsonc(raw, errors);
  if (errors.length > 0) {
    throw new AgentExtensionMaterializationError(
      `MCP target config ${file} contains invalid JSON; fix it before materializing (refusing to rewrite a file that cannot be parsed)`,
      "agent_extension_materialization_error",
      { targetPath: file }
    );
  }
  return asRecord(parsed);
}
async function writeJson(file, input) {
  await fs8.mkdir(path9.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, JSON.stringify(input, null, 2) + "\n");
}
var JSONC_FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } };
async function removeStandaloneMcpEntries(input) {
  if (input.file.endsWith(".toml")) {
    const raw = await readText(input.file);
    if (!raw) return;
    const names = new Set(input.names);
    const sections = codexMcpSections(raw).filter((section) => names.has(section.name));
    if (sections.length === 0) return;
    const next2 = [...sections].reverse().reduce((text2, section) => `${text2.slice(0, section.start)}${text2.slice(section.end)}`, raw);
    await writeFileAtomic(input.file, next2.replace(/\n{3,}/g, "\n\n"));
    return;
  }
  if (input.file.endsWith("opencode.jsonc") || input.file.endsWith("opencode.json")) {
    const raw = await readText(input.file);
    if (!raw.trim()) return;
    readJsonFromText(raw, input.file);
    let text2 = raw;
    for (const name of input.names) {
      text2 = applyEdits(text2, modify(text2, ["mcp", name], void 0, JSONC_FORMAT));
    }
    const withoutEntries = readJsonFromText(text2, input.file);
    if (Object.keys(asRecord(withoutEntries.mcp)).length === 0) {
      text2 = applyEdits(text2, modify(text2, ["mcp"], void 0, JSONC_FORMAT));
    }
    if (Object.keys(readJsonFromText(text2, input.file)).length === 0) {
      await fs8.rm(input.file, { force: true });
      return;
    }
    await writeFileAtomic(input.file, `${text2.trimEnd()}
`);
    return;
  }
  const root = await readJson2(input.file);
  const current = asRecord(root.mcpServers);
  for (const name of input.names) {
    delete current[name];
  }
  const next = { ...root };
  if (Object.keys(current).length > 0) next.mcpServers = sortedObject(current);
  else delete next.mcpServers;
  if (Object.keys(next).length === 0) {
    await fs8.rm(input.file, { force: true });
    return;
  }
  await writeJson(input.file, next);
}
async function materializeStandaloneMcp(input) {
  const target = mcpTargetPath(input);
  if (!target) {
    return Object.keys(input.config.servers).map((name) => ({
      runner: input.runner,
      component: name,
      type: "mcp",
      status: "skipped",
      reason: "native MCP config path not verified"
    }));
  }
  if (input.runner === "codex") {
    const raw = await readText(target);
    const sections = codexMcpSections(raw);
    const nextSections = input.config.servers;
    const drifted2 = /* @__PURE__ */ new Set();
    for (const [name, next] of Object.entries(nextSections)) {
      const current2 = sections.find((section) => section.name === name);
      if (!current2) continue;
      if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
        throw new AgentExtensionMaterializationError(
          `MCP server ${name} already exists in ${target}`,
          "agent_extension_mcp_server_conflict",
          {
            ownerId: input.ownerId,
            runner: input.runner,
            serverName: name,
            targetPath: target
          }
        );
      }
      if (!input.replaceOwned && current2.body.trim() !== codexMcpSection(name, next).trim()) {
        drifted2.add(name);
      }
    }
    if (drifted2.size > 0) {
      return mcpComponents({
        runner: input.runner,
        target,
        names: Object.keys(nextSections),
        drifted: drifted2,
        existing: new Set(sections.map((section) => section.name))
      });
    }
    const names = new Set(Object.keys(nextSections));
    const withoutOwned = sections.filter((section) => names.has(section.name)).reverse().reduce((text2, section) => `${text2.slice(0, section.start)}${text2.slice(section.end)}`, raw).replace(/\n{3,}/g, "\n\n");
    const prefix = withoutOwned.trim() ? `${withoutOwned.trimEnd()}

` : "";
    await fs8.mkdir(path9.dirname(target), { recursive: true, mode: 493 });
    await writeFileAtomic(target, `${prefix}${Object.entries(nextSections).map(([name, cfg]) => codexMcpSection(name, cfg)).join("\n")}`);
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextSections) });
  }
  if (input.runner === "opencode") {
    const raw = await readText(target);
    const root2 = raw.trim() ? readJsonFromText(raw, target) : {};
    const current2 = asRecord(root2.mcp);
    const nextServers2 = toOpenCodeMcpServers(input.config);
    const drifted2 = /* @__PURE__ */ new Set();
    for (const [name, next2] of Object.entries(nextServers2)) {
      if (current2[name] === void 0) continue;
      if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
        throw new AgentExtensionMaterializationError(
          `MCP server ${name} already exists in ${target}`,
          "agent_extension_mcp_server_conflict",
          {
            ownerId: input.ownerId,
            runner: input.runner,
            serverName: name,
            targetPath: target
          }
        );
      }
      if (!input.replaceOwned && JSON.stringify(current2[name]) !== JSON.stringify(next2)) {
        drifted2.add(name);
      }
    }
    if (drifted2.size > 0) {
      return mcpComponents({
        runner: input.runner,
        target,
        names: Object.keys(nextServers2),
        drifted: drifted2,
        existing: new Set(Object.keys(current2))
      });
    }
    const next = Object.entries(nextServers2).reduce((text2, [name, value]) => applyEdits(text2, modify(text2, ["mcp", name], value, {
      formattingOptions: { tabSize: 2, insertSpaces: true }
    })), raw.trim() ? raw : "{}");
    await fs8.mkdir(path9.dirname(target), { recursive: true, mode: 493 });
    await writeFileAtomic(target, `${next.trimEnd()}
`);
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextServers2) });
  }
  const root = await readJson2(target);
  const current = asRecord(root.mcpServers);
  const nextServers = toRunnerMcpServers(input.runner, input.config);
  const drifted = /* @__PURE__ */ new Set();
  for (const [name, next] of Object.entries(nextServers)) {
    if (current[name] === void 0) continue;
    if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
      throw new AgentExtensionMaterializationError(
        `MCP server ${name} already exists in ${target}`,
        "agent_extension_mcp_server_conflict",
        {
          ownerId: input.ownerId,
          runner: input.runner,
          serverName: name,
          targetPath: target
        }
      );
    }
    if (!input.replaceOwned && JSON.stringify(current[name]) !== JSON.stringify(next)) {
      drifted.add(name);
    }
  }
  if (drifted.size > 0) {
    return mcpComponents({
      runner: input.runner,
      target,
      names: Object.keys(nextServers),
      drifted,
      existing: new Set(Object.keys(current))
    });
  }
  await writeJson(target, {
    ...root,
    mcpServers: {
      ...current,
      ...nextServers
    }
  });
  return mcpComponents({ runner: input.runner, target, names: Object.keys(nextServers) });
}

// src/materializers/skills.ts
import path10 from "path";
function skillTargetDir(input) {
  if (input.scope === "project") {
    if (!input.projectDir) throw new Error("projectDir is required for project skill materialization");
    if (input.runner === "claude") return path10.join(input.projectDir, ".claude", "skills", input.name);
    if (input.runner === "codex") return path10.join(input.projectDir, ".agents", "skills", input.name);
    if (input.runner === "opencode") return path10.join(input.projectDir, ".opencode", "skills", input.name);
    return path10.join(input.projectDir, ".cursor", "skills", input.name);
  }
  if (!input.homeDir) throw new Error("homeDir is required for machine skill materialization");
  if (input.runner === "claude") return path10.join(input.homeDir, ".claude", "skills", input.name);
  if (input.runner === "codex") return path10.join(input.homeDir, ".codex", "skills", input.name);
  if (input.runner === "opencode") return path10.join(input.homeDir, ".config", "opencode", "skills", input.name);
  return path10.join(input.homeDir, ".cursor", "skills", input.name);
}
async function materializeStandaloneSkill(input) {
  const result = await linkOrCopyOwnedDirectory({
    sourceDir: input.skillDir,
    targetDir: skillTargetDir(input),
    ownerId: input.ownerId,
    record: input.record,
    ...input.replaceOwned ? { replaceOwned: input.replaceOwned } : {},
    ...input.symlink ? { symlink: input.symlink } : {}
  });
  return {
    runner: input.runner,
    component: input.name,
    type: "skill",
    status: result.status,
    ...result.reason ? { reason: result.reason } : {},
    path: result.path
  };
}

// src/integrity.ts
var HEX_SHA = /^[A-Fa-f0-9]{7,64}$/;
var AgentExtensionIntegrityError = class extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AgentExtensionIntegrityError";
  }
};
function text(input) {
  return typeof input === "string" && input.trim() ? input.trim() : void 0;
}
function lockedPackageDigest(lock) {
  return text(lock?.component_digests?.package) ?? text(lock?.manifest_digests?.package);
}
function isRemotePackageSource(source3) {
  return (source3?.type ?? "") !== "project";
}
function sourceIdentity(source3) {
  if (!source3) return void 0;
  if (source3.type === "project") return JSON.stringify(["project", source3.package_path ?? ""]);
  return JSON.stringify([
    source3.type ?? "",
    source3.owner ?? "",
    source3.repo ?? "",
    source3.ref ?? "",
    source3.package_path ?? ""
  ]);
}
function samePackageSourceIdentity(left, right) {
  const key = sourceIdentity(left);
  return !!key && key === sourceIdentity(right);
}
async function verifyPackageIntegrity(input) {
  const expected = lockedPackageDigest(input.lock);
  if (isRemotePackageSource(input.source)) {
    if (!input.lock) {
      throw new AgentExtensionIntegrityError(
        `Agent Extension ${input.id} has no lock entry; refusing to materialize an unverified package (reinstall it or run \`agent-extensions update ${input.id}\`)`,
        "agent_extension_unverifiable_package",
        { id: input.id, missing: "lock" }
      );
    }
    if (!text(input.lock.resolved_sha) || !HEX_SHA.test(input.lock.resolved_sha.trim())) {
      throw new AgentExtensionIntegrityError(
        `Agent Extension ${input.id} is missing resolved SHA in its lock; refusing to materialize an unpinned package`,
        "agent_extension_unverifiable_package",
        { id: input.id, missing: "resolved_sha" }
      );
    }
    if (!expected) {
      throw new AgentExtensionIntegrityError(
        `Agent Extension ${input.id} lock records no package digest; refusing to materialize an unverified package (reinstall it or run \`agent-extensions update ${input.id}\`)`,
        "agent_extension_unverifiable_package",
        { id: input.id, missing: "package_digest" }
      );
    }
  }
  if (input.lock?.source && !samePackageSourceIdentity(input.source, input.lock.source)) {
    throw new AgentExtensionIntegrityError(
      `Agent Extension ${input.id} requested source does not match its locked source; reinstall it to change the pinned source`,
      "agent_extension_source_mismatch",
      { id: input.id, requestedSource: input.source, lockedSource: input.lock.source }
    );
  }
  const actual = await (input.digest ?? digestDirectory)(input.packageRoot);
  if (expected && actual !== expected) {
    throw new AgentExtensionIntegrityError(
      `Agent Extension ${input.id} cache checksum mismatch; run \`agent-extensions update ${input.id}\` to refetch the package`,
      "agent_extension_digest_mismatch",
      { id: input.id, expected, actual }
    );
  }
  return actual;
}

// src/materialize.ts
function sorted(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function now(input) {
  return typeof input.now === "function" ? input.now() : input.now ?? Date.now();
}
function scope(input) {
  return input.desired.scope === "machine" ? "machine" : "project";
}
function targets(input) {
  return (input.desired.targets ?? []).filter(isHarnessTarget);
}
function packageName(input, packageRoot) {
  return input.desired.package_name ?? input.desired.id ?? path11.basename(packageRoot);
}
function packageNameWithoutRoot(input) {
  return input.desired.package_name ?? input.desired.id;
}
function status(components, fallback) {
  if (components.length === 0) return fallback === "failed" || fallback === "drifted" ? fallback : "partial";
  if (components.every((item) => item.status === "skipped")) return "partial";
  if (components.some((item) => item.status === "failed")) return "failed";
  if (components.some((item) => item.status === "drifted")) return "drifted";
  if (components.some((item) => item.status === "skipped")) return "partial";
  return "applied";
}
async function readJson3(file) {
  return JSON.parse(await fs9.readFile(file, "utf8"));
}
var CLAXEDO_MCP_MANAGED_ENV = /* @__PURE__ */ new Set([
  "CLAXEDO_SERVER_URL",
  "OPENCODE_API_URL",
  "OPENCODE_API_DIR",
  "CLAXEDO_WORKSPACE_ID"
]);
var CLAXEDO_MCP_AUTH_ENV = /* @__PURE__ */ new Set([
  "CLAXEDO_LOCAL_TOKEN",
  "CLAXEDO_JIT_TOKEN",
  "CLAXEDO_BROKER_TOKEN",
  "CLAXEDO_MCP_BROKER_TOKEN",
  "CLAXEDO_AUTH_TOKEN",
  "CLAXEDO_API_TOKEN"
]);
function textEnv(name) {
  const value = process.env[name]?.trim();
  return value || void 0;
}
function claxedoMcpServerUrl() {
  return textEnv("CLAXEDO_SERVER_URL") ?? "http://127.0.0.1:3001";
}
function claxedoMcpWorkspaceId() {
  return textEnv("CLAXEDO_WORKSPACE_ID") ?? textEnv("CLAXEDO_WR_WORKSPACE_ID");
}
function isFirstPartyClaxedoMcpInstall(input) {
  const source3 = input.desired.source;
  if (!input.lock?.source || !samePackageSourceIdentity(source3, input.lock.source)) return false;
  return input.desired.id === "claxedo-mcp" && source3.type === "github" && source3.owner === "kyashrathore" && source3.repo?.toLowerCase() === "claxedo" && source3.ref === "dev" && source3.package_path === "packages/claxedo-mcp";
}
function managedClaxedoMcpEnv(input) {
  return {
    ...Object.fromEntries(Object.entries(input.env ?? {}).filter(
      ([key, value]) => typeof value === "string" && !CLAXEDO_MCP_MANAGED_ENV.has(key) && !CLAXEDO_MCP_AUTH_ENV.has(key)
    )),
    CLAXEDO_SERVER_URL: claxedoMcpServerUrl(),
    ...input.targetScope === "project" ? { OPENCODE_API_DIR: input.projectDir } : {},
    ...claxedoMcpWorkspaceId() ? { CLAXEDO_WORKSPACE_ID: claxedoMcpWorkspaceId() } : {}
  };
}
function managedClaxedoMcpConfig(input) {
  return {
    servers: sorted(Object.fromEntries(Object.entries(input.config.servers).map(([name, config]) => {
      if (name !== "claxedo" || !("command" in config)) return [name, config];
      return [name, {
        ...config,
        env: managedClaxedoMcpEnv({
          env: config.env,
          projectDir: input.projectDir,
          targetScope: input.targetScope
        })
      }];
    })))
  };
}
async function removeTreeOrLink(target) {
  const stat = await fs9.lstat(target).catch(() => void 0);
  if (!stat) return;
  await fs9.rm(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}
async function removeMaterializedComponent(component) {
  if (component.status !== "applied" || !component.path) return;
  if (component.type !== "mcp") {
    await removeTreeOrLink(component.path);
    return;
  }
  await removeStandaloneMcpEntries({ file: component.path, names: [component.component] });
}
async function uninstallOwnedComponents(input) {
  await Promise.all((input.record.packages[input.ownerId]?.components ?? []).map((item) => removeMaterializedComponent(item)));
}
async function removeStaleMaterializedComponents(previous, next) {
  const nextComponents = new Set(Object.values(next.packages).flatMap(
    (pkg) => pkg.components.flatMap(
      (component) => component.path ? [`${component.type}
${component.path}
${component.component}`] : []
    )
  ));
  await Promise.all(Object.values(previous.packages).flatMap(
    (pkg) => pkg.components.flatMap(
      (component) => component.status === "applied" && component.path && !nextComponents.has(`${component.type}
${component.path}
${component.component}`) ? [removeMaterializedComponent(component)] : []
    )
  ));
}
async function materializeDiscoveredComponent(input) {
  if (input.component.type === "skill") {
    return [await materializeStandaloneSkill({
      skillDir: input.component.path,
      name: path11.resolve(input.component.path) === path11.resolve(input.packageRoot) ? input.packageName : input.component.name,
      runner: input.runner,
      scope: input.targetScope,
      ownerId: input.ownerId,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      record: input.previous,
      replaceOwned: input.replaceOwned
    })];
  }
  if (input.component.type === "plugin") {
    if (input.runner === input.component.runner) {
      return [await materializeCursorLocalPlugin({
        packageDir: input.component.path,
        pluginName: input.component.name,
        ownerId: input.ownerId,
        homeDir: input.install.desired.scope === "workspace" ? input.projectDir : input.homeDir,
        record: input.previous,
        replaceOwned: input.replaceOwned
      })];
    }
    return [{
      runner: input.runner,
      component: input.component.name,
      type: "plugin",
      status: "skipped",
      reason: "native plugin install path not verified"
    }];
  }
  if (input.component.type === "mcp") {
    const mcpConfig = normalizeStandaloneMcpConfig(await readJson3(input.component.path));
    return await materializeStandaloneMcp({
      config: isFirstPartyClaxedoMcpInstall(input.install) ? managedClaxedoMcpConfig({ config: mcpConfig, projectDir: input.projectDir, targetScope: input.targetScope }) : mcpConfig,
      runner: input.runner,
      scope: input.targetScope,
      ownerId: input.ownerId,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      record: input.previous,
      replaceOwned: input.replaceOwned
    });
  }
  return [{
    runner: input.runner,
    component: input.component.name,
    type: "hook",
    status: "skipped",
    reason: "agent hook package materialization is not implemented yet"
  }];
}
function componentKey(component) {
  return `${component.runner}
${component.type}
${component.component}`;
}
function withPreviousApplied(components, previous) {
  const seen = new Set(components.map(componentKey));
  return [
    ...components,
    ...(previous?.components ?? []).filter((component) => component.status === "applied" && !seen.has(componentKey(component)))
  ];
}
async function materializePackage(input) {
  const name = packageName(input.install, input.packageRoot);
  const ownerId = input.install.desired.id;
  const targetScope = scope(input.install);
  const components = [];
  const failures = [];
  const discovered = await discoverAgentExtensionComponents(input.packageRoot);
  for (const runner of targets(input.install)) {
    if (discovered.length > 0) {
      for (const component of discovered) {
        try {
          components.push(...await materializeDiscoveredComponent({
            component,
            install: input.install,
            runner,
            packageRoot: input.packageRoot,
            packageName: name,
            targetScope,
            ownerId,
            projectDir: input.projectDir,
            homeDir: input.homeDir,
            previous: input.previous,
            replaceOwned: input.replaceOwned
          }));
        } catch (err) {
          failures.push(err);
          components.push({
            runner,
            component: component.name,
            type: component.type,
            status: "failed",
            reason: err instanceof Error ? err.message : String(err)
          });
        }
      }
      continue;
    }
    components.push({
      runner,
      component: name,
      type: "plugin",
      status: "skipped",
      reason: "unsupported package shape"
    });
  }
  const recorded = failures.length > 0 ? withPreviousApplied(components, input.previous.packages[ownerId]) : components;
  return {
    package: {
      package_name: name,
      source: input.install.desired.source,
      resolved_sha: input.install.lock?.resolved_sha ?? "",
      enabled: true,
      targets: targets(input.install),
      components: recorded,
      materialized_at: input.materializedAt,
      status: status(recorded, input.install.status)
    },
    failures
  };
}
async function verifyMaterializationIntegrity(input) {
  await Promise.all(input.installs.map(async (install) => {
    if (install.desired.enabled === false) return;
    const packageRoot = input.packageRoots[install.desired.id];
    if (!packageRoot) return;
    await verifyPackageIntegrity({
      id: install.desired.id,
      source: install.desired.source,
      ...install.lock ? { lock: install.lock } : {},
      packageRoot
    });
  }));
}
async function materializeAgentExtensionSnapshot(input) {
  await verifyMaterializationIntegrity(input);
  const materializedFile = path11.join(input.stateRoot, "materialized.json");
  const previous = await readMaterializedRuntimeRecord(materializedFile);
  const materializedAt = now(input);
  const failures = [];
  const packageEntries = (await Promise.all(input.installs.map(async (install) => {
    const existing = previous.packages[install.desired.id];
    if (install.desired.enabled === false) {
      return [[install.desired.id, {
        package_name: packageNameWithoutRoot(install),
        source: install.desired.source,
        resolved_sha: install.lock?.resolved_sha ?? existing?.resolved_sha ?? "",
        enabled: false,
        targets: targets(install),
        components: [],
        materialized_at: materializedAt,
        status: "disabled"
      }]];
    }
    const packageRoot = input.packageRoots[install.desired.id];
    if (!packageRoot && existing && existing.resolved_sha === install.lock?.resolved_sha && JSON.stringify(existing.targets) === JSON.stringify(targets(install)) && existing.status !== "failed" && existing.status !== "drifted") {
      return [[install.desired.id, existing]];
    }
    if (!packageRoot) return [];
    const result = await materializePackage({
      install,
      packageRoot,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      previous,
      materializedAt,
      replaceOwned: input.replaceOwned ?? !!existing
    });
    failures.push(...result.failures);
    return [[install.desired.id, result.package]];
  }))).flat();
  const packages = sorted(Object.fromEntries(packageEntries));
  const next = {
    version: 1,
    packages
  };
  await removeStaleMaterializedComponents(previous, next);
  await writeMaterializedRuntimeRecord(materializedFile, next);
  if (failures.length > 0) throw failures[0];
  return readMaterializedRuntimeRecord(materializedFile);
}

// src/lock.ts
import fs10 from "fs/promises";
import path12 from "path";
function lockStatePath(root) {
  return path12.join(root, "lock.json");
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
  await fs10.mkdir(path12.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, encodeLock(lock));
}

// src/storage.ts
function agentExtensionFiles(input) {
  const root = agentExtensionStateRoot({
    scope: input.scope,
    ...input.projectDir ? { projectDir: input.projectDir } : {},
    ...input.workspaceId ? { workspaceId: input.workspaceId } : {},
    ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
  });
  return {
    root,
    installed: installedStatePath({
      scope: input.scope,
      ...input.projectDir ? { projectDir: input.projectDir } : {},
      ...input.workspaceId ? { workspaceId: input.workspaceId } : {},
      ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
    }),
    lock: lockStatePath(root),
    materialized: materializedRecordPath(root)
  };
}
function materializedAgentExtensionFiles(input) {
  return agentExtensionFiles(input);
}
function workspaceAgentExtensionFiles(input) {
  return agentExtensionFiles({
    scope: "workspace",
    workspaceId: input.workspaceId,
    ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
  });
}

// src/install.ts
var AgentExtensionConflictError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AgentExtensionConflictError";
  }
};
function allAgentExtensionTargets() {
  return allHarnessTargets();
}
async function installCachedAgentExtension(input) {
  const cache = await copyPackageToCache({
    ...input,
    dataRoot: dataRootFor(input)
  });
  return installFetchedAgentExtension({
    ...input,
    packageRoot: cache.path,
    checksum: cache.checksum
  });
}
function marketplacePackageName(input) {
  if (typeof input.manifest.name === "string" && input.manifest.name.trim()) return input.manifest.name.trim();
  if (input.source.type === "github" && input.source.repo) return input.source.repo;
  return path13.basename(input.packageRoot);
}
async function installFetchedAgentExtension(input) {
  const packageRoot = input.packageRoot;
  const packageType = await discoverAgentExtensionPackage(packageRoot);
  const packageName2 = packageType.type === "marketplace" ? marketplacePackageName({ manifest: packageType.manifest, source: input.source, packageRoot }) : packageType.name;
  const id = input.id ?? packageName2;
  const targets2 = input.targets ?? allAgentExtensionTargets();
  const files = filesFor(input);
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, lock] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readExtensionLock(files.lock)
    ]);
    const existing = desired.installs.find((item) => item.id === id);
    if (existing && !sameSource(existing.source, input.source) && !input.replaceOwned) {
      throw new AgentExtensionConflictError(
        "agent_extension_source_conflict",
        `Agent Extension ${id} is already installed from a different source`,
        {
          id,
          existingSource: existing.source,
          requestedSource: input.source
        }
      );
    }
    const checksum = input.checksum ?? await digestDirectory(packageRoot);
    const timestamp = input.now ?? Date.now();
    const state = upsertInstallState({
      state: desired,
      id,
      packageName: packageName2,
      source: input.source,
      scope: input.scope,
      targets: targets2,
      enabled: existing?.enabled ?? true,
      installedAt: input.installedAt ?? existing?.installed_at ?? timestamp,
      updatedAt: timestamp
    });
    const nextLock = {
      version: 1,
      packages: {
        ...lock.packages,
        [id]: {
          source: input.source,
          resolved_sha: input.resolvedSha,
          ...input.packagePath ? { package_path: input.packagePath } : {},
          manifest_digests: { package: checksum },
          component_digests: { package: checksum },
          targets: targets2
        }
      }
    };
    await applyProjection({
      state,
      lock: nextLock,
      files,
      projectDir: projectDirFor(input),
      homeDir: input.homeDir,
      now: input.now,
      packageRoots: { [id]: packageRoot },
      ...input.replaceOwned !== void 0 ? { replaceOwned: input.replaceOwned } : {}
    });
    const materialized = await readMaterializedRuntimeRecord(files.materialized);
    const nextPackage = materialized.packages[id];
    if (!nextPackage) throw new Error(`Agent Extension ${id} was not materialized`);
    return {
      id,
      package: packageType,
      cache: {
        path: packageRoot,
        checksum
      },
      materialized: nextPackage
    };
  });
}
async function installGitHubAgentExtension(input) {
  const source3 = parsePackageSource(input.source);
  const cache = await fetchGitHubPackageToCache({
    source: source3,
    dataRoot: dataRootFor(input)
  });
  return installFetchedAgentExtension({
    ...input,
    source: source3,
    resolvedSha: cache.resolvedSha,
    ...source3.package_path ? { packagePath: source3.package_path } : {},
    packageRoot: cache.path,
    checksum: cache.checksum
  });
}
async function updateAgentExtension(input) {
  if (!input.homeDir) throw new Error("homeDir is required to update an Agent Extension");
  const files = filesFor(input);
  const desired = await readDesiredExtensionState(files.installed);
  const desiredInstall2 = desired.installs.find((item) => item.id === input.id);
  if (!desiredInstall2) return void 0;
  if (desiredInstall2.source.type === "project") {
    if (!input.projectDir) throw new Error("projectDir is required to update a project Agent Extension");
    const packageRoot = path13.join(input.projectDir, desiredInstall2.source.package_path);
    const checksum = await digestDirectory(packageRoot);
    const cache2 = await copyPackageToCache({
      sourceRoot: input.projectDir,
      packagePath: desiredInstall2.source.package_path,
      resolvedSha: checksum,
      dataRoot: dataRootFor(input)
    });
    return installFetchedAgentExtension({
      source: desiredInstall2.source,
      resolvedSha: checksum,
      packagePath: desiredInstall2.source.package_path,
      scope: input.scope,
      projectDir: input.projectDir,
      dataRoot: dataRootFor(input),
      homeDir: input.homeDir,
      targets: desiredInstall2.targets,
      id: input.id,
      now: input.now,
      installedAt: desiredInstall2.installed_at,
      replaceOwned: true,
      packageRoot: cache2.path,
      checksum: cache2.checksum
    });
  }
  const cache = await (input.fetchPackage ?? fetchGitHubPackageToCache)({
    source: desiredInstall2.source,
    dataRoot: dataRootFor(input)
  });
  return installFetchedAgentExtension({
    source: desiredInstall2.source,
    resolvedSha: cache.resolvedSha,
    ...desiredInstall2.source.package_path ? { packagePath: desiredInstall2.source.package_path } : {},
    scope: input.scope,
    ...input.projectDir ? { projectDir: input.projectDir } : {},
    dataRoot: dataRootFor(input),
    homeDir: input.homeDir,
    targets: desiredInstall2.targets,
    id: input.id,
    now: input.now,
    installedAt: desiredInstall2.installed_at,
    replaceOwned: true,
    packageRoot: cache.path,
    checksum: cache.checksum
  });
}
function projectDirFor(input) {
  return input.projectDir ?? input.homeDir ?? process.cwd();
}
function dataRootFor(input) {
  return input.dataRoot;
}
function filesFor(input) {
  return materializedAgentExtensionFiles({
    ...input,
    dataRoot: dataRootFor(input)
  });
}
function materializationInstalls(input) {
  return input.desired.installs.map((desired) => {
    const locked = input.lock.packages[desired.id];
    return {
      desired: {
        id: desired.id,
        package_name: desired.package_name,
        source: desired.source,
        scope: desired.scope,
        enabled: desired.enabled,
        targets: desired.targets
      },
      // Forward the whole lock entry, not just the SHA: the materializer
      // verifies the package tree against the pinned digest and source before
      // writing anything, and it can only do that with the full entry.
      ...locked ? { lock: locked } : {},
      status: input.materialized?.packages[desired.id]?.status
    };
  });
}
async function verifyPackageRoots(input) {
  await Promise.all(Object.entries(input.packageRoots ?? {}).map(async ([id, packageRoot]) => {
    const desired = input.state.installs.find((item) => item.id === id);
    if (desired?.enabled === false) return;
    await verifyPackageIntegrity({
      id,
      ...desired?.source ? { source: desired.source } : {},
      ...input.lock.packages[id] ? { lock: input.lock.packages[id] } : {},
      packageRoot
    });
  }));
}
async function applyProjection(input) {
  await verifyPackageRoots({ state: input.state, lock: input.lock, packageRoots: input.packageRoots });
  await Promise.all([
    writeDesiredExtensionState(input.files.installed, input.state),
    writeExtensionLock(input.files.lock, input.lock)
  ]);
  await materializeAgentExtensionSnapshot({
    installs: materializationInstalls({ desired: input.state, lock: input.lock }),
    packageRoots: input.packageRoots ?? {},
    projectDir: input.projectDir,
    stateRoot: input.files.root,
    homeDir: input.homeDir ?? input.projectDir,
    ...input.now !== void 0 ? { now: input.now } : {},
    ...input.replaceOwned !== void 0 ? { replaceOwned: input.replaceOwned } : {}
  });
}
function upsertInstallState(input) {
  return {
    version: 1,
    installs: [
      ...input.state.installs.filter((item) => item.id !== input.id),
      {
        id: input.id,
        package_name: input.packageName,
        source: input.source,
        scope: input.scope,
        enabled: input.enabled,
        targets: input.targets,
        installed_at: input.installedAt,
        updated_at: input.updatedAt
      }
    ]
  };
}
function setEnabled(input) {
  return {
    version: 1,
    installs: input.state.installs.map((item) => item.id === input.id ? { ...item, enabled: input.enabled, updated_at: input.updatedAt } : item)
  };
}
async function disableAgentExtension(input) {
  const files = filesFor(input);
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, lock, record] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readExtensionLock(files.lock),
      readMaterializedRuntimeRecord(files.materialized)
    ]);
    const item = record.packages[input.id];
    const desiredInstall2 = desired.installs.find((install) => install.id === input.id);
    if (!item && !desiredInstall2) return void 0;
    const state = setEnabled({
      state: desired,
      id: input.id,
      enabled: false,
      updatedAt: input.now ?? Date.now()
    });
    await applyProjection({
      state,
      lock,
      files,
      projectDir: projectDirFor(input),
      homeDir: input.homeDir,
      now: input.now
    });
    const materialized = (await readMaterializedRuntimeRecord(files.materialized)).packages[input.id];
    if (!materialized) throw new Error(`Agent Extension ${input.id} was not materialized`);
    return {
      id: input.id,
      materialized
    };
  });
}
async function enableAgentExtension(input) {
  if (!input.homeDir) throw new Error("homeDir is required to enable an Agent Extension");
  const files = filesFor(input);
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, lock] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readExtensionLock(files.lock)
    ]);
    const desiredInstall2 = desired.installs.find((item) => item.id === input.id);
    const locked = lock.packages[input.id];
    if (!desiredInstall2 || !locked) return void 0;
    const packageRoot = cachePackageRoot({
      resolvedSha: locked.resolved_sha,
      ...locked.package_path ? { packagePath: locked.package_path } : {},
      dataRoot: dataRootFor(input)
    });
    await applyProjection({
      state: setEnabled({
        state: desired,
        id: input.id,
        enabled: true,
        updatedAt: input.now ?? Date.now()
      }),
      lock,
      files,
      projectDir: projectDirFor(input),
      homeDir: input.homeDir,
      now: input.now,
      packageRoots: { [input.id]: packageRoot }
    });
    const materialized = (await readMaterializedRuntimeRecord(files.materialized)).packages[input.id];
    if (!materialized) throw new Error(`Agent Extension ${input.id} was not materialized`);
    return {
      id: input.id,
      materialized
    };
  });
}
async function uninstallAgentExtension(input) {
  const files = filesFor(input);
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, record, lock] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readMaterializedRuntimeRecord(files.materialized),
      readExtensionLock(files.lock)
    ]);
    const item = record.packages[input.id];
    const desiredInstall2 = desired.installs.find((install) => install.id === input.id);
    const lockedPackage2 = lock.packages[input.id];
    if (!item && !desiredInstall2 && !lockedPackage2) return void 0;
    const { [input.id]: _removedLock, ...locked } = lock.packages;
    await applyProjection({
      state: {
        version: 1,
        installs: desired.installs.filter((install) => install.id !== input.id)
      },
      lock: { version: 1, packages: locked },
      files,
      projectDir: projectDirFor(input),
      homeDir: input.homeDir,
      now: input.now
    });
    return item ?? {
      package_name: desiredInstall2?.package_name ?? input.id,
      source: desiredInstall2?.source ?? lockedPackage2.source,
      resolved_sha: lockedPackage2?.resolved_sha ?? "",
      enabled: false,
      targets: desiredInstall2?.targets ?? lockedPackage2?.targets ?? [],
      components: [],
      materialized_at: input.now ?? Date.now(),
      status: "disabled"
    };
  });
}

// src/replay.ts
import { execFile } from "child_process";
import crypto3 from "crypto";
import fs11 from "fs/promises";
import os2 from "os";
import path14 from "path";
function projectDirDefault() {
  return process.env.CLAXEDO_WR_DIRECTORY ?? process.cwd();
}
function execFileDefault2(file, args, options) {
  if (file !== "git") throw new Error(`Unsupported Agent Extension exec binary: ${file}`);
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options?.cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 3e4
    }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
function sorted2(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function rec(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}
function str(input) {
  return typeof input === "string" && input.trim() ? input.trim() : void 0;
}
function stringList(input) {
  return Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
}
function packageSource(input) {
  const value = rec(input);
  return {
    type: str(value.type) ?? "unknown",
    ...typeof value.owner === "string" ? { owner: value.owner } : {},
    ...typeof value.repo === "string" ? { repo: value.repo } : {},
    ...typeof value.ref === "string" ? { ref: value.ref } : {},
    ...typeof value.package_path === "string" ? { package_path: value.package_path } : {}
  };
}
function relative(input) {
  if (!input) return void 0;
  try {
    return safeRelativePath(input, "Agent Extension package path");
  } catch {
    throw new Error("Agent Extension package path must stay inside the source root");
  }
}
function source2(input) {
  const value = rec(input.desired.source);
  if (value.type === "project") {
    return {
      type: "project",
      packagePath: relative(str(value.package_path)) ?? FIRST_PARTY_AGENT_EXTENSIONS_DIR
    };
  }
  const owner = str(value.owner);
  const repo = str(value.repo);
  if (value.type !== "github" || !owner || !repo) throw new Error(`Unsupported Agent Extension source for ${String(input.desired.id ?? "unknown")}`);
  return {
    type: "github",
    owner,
    repo,
    packagePath: relative(str(value.package_path))
  };
}
function digestMap(input) {
  return Object.fromEntries(Object.entries(rec(input)).flatMap(([key, value]) => {
    const text2 = str(value);
    return text2 ? [[key, text2]] : [];
  }));
}
function integrityLock(input) {
  if (!input.lock) return void 0;
  const lock = rec(input.lock);
  return {
    ...str(lock.resolved_sha) ? { resolved_sha: str(lock.resolved_sha) } : {},
    ...str(rec(lock.source).type) ? { source: packageSource(lock.source) } : {},
    manifest_digests: digestMap(lock.manifest_digests),
    component_digests: digestMap(lock.component_digests)
  };
}
async function verifyPackageDigest(input) {
  const lock = integrityLock(input.install);
  await verifyPackageIntegrity({
    id: String(input.install.desired.id ?? "unknown"),
    source: packageSource(input.install.desired.source),
    ...lock ? { lock } : {},
    packageRoot: input.packageRoot
  });
}
function resolvedSha(input) {
  const sha = str(input.lock?.resolved_sha);
  if (!sha) throw new Error(`Agent Extension ${String(input.desired.id ?? "unknown")} is missing resolved SHA`);
  if (!/^[A-Fa-f0-9]{7,64}$/.test(sha)) {
    throw new Error(`Agent Extension ${String(input.desired.id ?? "unknown")} resolved SHA must be a hex commit id`);
  }
  return sha.toLowerCase();
}
async function fetchToCache(input) {
  const info = source2(input.install);
  if (info.type !== "github") throw new Error(`Unsupported Agent Extension source for ${String(input.install.desired.id ?? "unknown")}`);
  const sha = resolvedSha(input.install);
  const shaRoot = path14.join(input.cacheRoot, sha);
  const target = info.packagePath ? path14.join(shaRoot, info.packagePath) : shaRoot;
  if (await fs11.stat(target).then((stat) => stat.isDirectory()).catch(() => false)) return target;
  const root = await fs11.mkdtemp(path14.join(input.tempRoot, "claxedo-runtime-extension-"));
  try {
    await input.execFile("git", ["init", root]);
    await input.execFile("git", ["remote", "add", "origin", githubRepoUrl({
      type: "github",
      owner: info.owner,
      repo: info.repo
    })], { cwd: root });
    await input.execFile("git", ["fetch", "--depth", "1", "origin", sha], { cwd: root });
    await input.execFile("git", ["checkout", "--detach", sha], { cwd: root });
    const sourceRoot = info.packagePath ? path14.join(root, info.packagePath) : root;
    const staging = `${target}.${crypto3.randomBytes(6).toString("hex")}.tmp`;
    await fs11.mkdir(path14.dirname(target), { recursive: true, mode: 493 });
    await fs11.cp(sourceRoot, staging, {
      recursive: true,
      force: true,
      filter: (source3) => !path14.relative(sourceRoot, source3).split(path14.sep).includes(".git")
    });
    try {
      await fs11.rm(target, { recursive: true, force: true });
      await fs11.rename(staging, target);
    } catch (err) {
      await fs11.rm(staging, { recursive: true, force: true });
      throw err;
    }
    return target;
  } finally {
    await fs11.rm(root, { recursive: true, force: true });
  }
}
async function resolveProjectPackageRoot(input) {
  const info = source2(input.install);
  if (info.type !== "project") return void 0;
  const root = path14.join(input.projectDir, info.packagePath);
  if (!await fs11.stat(root).then((stat) => stat.isDirectory()).catch(() => false)) {
    throw new Error(`Project Agent Extension root does not exist: ${info.packagePath}`);
  }
  return root;
}
function canonicalInstall(input) {
  if (typeof input.desired.id !== "string") return;
  return {
    desired: {
      id: input.desired.id,
      ...typeof input.desired.package_name === "string" ? { package_name: input.desired.package_name } : {},
      source: packageSource(input.desired.source),
      ...typeof input.desired.scope === "string" ? { scope: input.desired.scope } : {},
      ...typeof input.desired.enabled === "boolean" ? { enabled: input.desired.enabled } : {},
      targets: stringList(input.desired.targets)
    },
    // The materializer re-verifies integrity as the last gate before disk, so
    // it needs the pinned digest and source — not just the SHA.
    ...integrityLock(input) ? { lock: integrityLock(input) } : {},
    ...typeof input.status === "string" ? { status: input.status } : {}
  };
}
async function packageRoots(input) {
  const entries = (await Promise.all(input.installs.map(async (install) => {
    if (typeof install.desired.id !== "string") return [];
    const provided = input.packageRoots?.[install.desired.id] ?? await resolveProjectPackageRoot({
      install,
      projectDir: input.projectDir
    });
    if (provided) {
      await verifyPackageDigest({ install, packageRoot: provided });
      return [[install.desired.id, provided]];
    }
    const fetchInput = {
      install,
      cacheRoot: input.cacheRoot,
      execFile: input.execFile,
      tempRoot: input.tempRoot
    };
    const packageRoot = await fetchToCache(fetchInput);
    try {
      await verifyPackageDigest({ install, packageRoot });
    } catch (err) {
      if (!(err instanceof AgentExtensionIntegrityError) || err.code !== "agent_extension_digest_mismatch") throw err;
      await fs11.rm(packageRoot, { recursive: true, force: true });
      const refetched = await fetchToCache(fetchInput);
      await verifyPackageDigest({ install, packageRoot: refetched });
      return [[install.desired.id, refetched]];
    }
    return [[install.desired.id, packageRoot]];
  }))).flat();
  return sorted2(Object.fromEntries(entries));
}
async function applyRuntimeAgentExtensionsNow(input, projectDir = projectDirDefault(), options = {}) {
  if (!input) return;
  const root = options.stateRoot ?? path14.join(projectDir, ".agent-extensions");
  await withAgentExtensionStateLock(root, async () => {
    const installs = input.installs;
    const enabledInstalls = installs.filter((item) => item.desired.enabled !== false);
    await writeFileAtomic(path14.join(root, "installed.json"), JSON.stringify({
      version: 1,
      installs: installs.map((item) => item.desired).sort(
        (a, b) => String(a.id ?? "").localeCompare(String(b.id ?? ""))
      )
    }, null, 2) + "\n");
    await writeFileAtomic(path14.join(root, "lock.json"), JSON.stringify({
      version: 1,
      packages: sorted2(Object.fromEntries(installs.flatMap(
        (item) => item.lock && typeof item.desired.id === "string" ? [[item.desired.id, item.lock]] : []
      )))
    }, null, 2) + "\n");
    await materializeAgentExtensionSnapshot({
      installs: installs.flatMap((item) => canonicalInstall(item) ?? []),
      packageRoots: await packageRoots({
        installs: enabledInstalls,
        projectDir,
        cacheRoot: path14.join(root, "cache"),
        execFile: options.execFile ?? execFileDefault2,
        tempRoot: options.tempRoot ?? os2.tmpdir(),
        ...options.packageRoots ? { packageRoots: options.packageRoots } : {}
      }),
      projectDir,
      stateRoot: root,
      homeDir: options.homeDir ?? os2.homedir(),
      ...options.now !== void 0 ? { now: options.now } : {}
    });
  });
}
var applyQueue = Promise.resolve();
async function applyRuntimeAgentExtensions(input, projectDir = projectDirDefault(), options = {}) {
  const next = applyQueue.then(() => applyRuntimeAgentExtensionsNow(input, projectDir, options));
  applyQueue = next.catch(() => {
  });
  return next;
}

// src/runtime-config.ts
import path15 from "path";
async function discoverFirstPartyAgentExtensions(projectDir) {
  if ((await discoverAgentExtensionComponents(path15.join(projectDir, FIRST_PARTY_AGENT_EXTENSIONS_DIR))).length === 0) {
    return void 0;
  }
  return {
    id: FIRST_PARTY_AGENT_EXTENSION_ID,
    package_name: FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
    source: {
      type: "project",
      package_path: FIRST_PARTY_AGENT_EXTENSIONS_DIR
    },
    scope: "project",
    enabled: true,
    targets: allHarnessTargets(),
    installed_at: 0,
    updated_at: 0
  };
}
function overrideFor(overrides, id, scope2) {
  return overrides.find((item) => item.id === id && item.scope === scope2);
}
function resolveEffectiveAgentExtensionPolicy(desired, overrides = []) {
  if (!desired.enabled) return { enabled: false, source: "desired", reason: "desired install is disabled" };
  const org = overrideFor(overrides, desired.id, "org");
  if (org?.enabled === false) {
    return {
      enabled: false,
      source: "org",
      ...org.reason ? { reason: org.reason } : {}
    };
  }
  const workspace = overrideFor(overrides, desired.id, "workspace");
  if (workspace) {
    return {
      enabled: workspace.enabled,
      source: "workspace",
      ...workspace.reason ? { reason: workspace.reason } : {}
    };
  }
  const user = overrideFor(overrides, desired.id, "user");
  if (user) {
    return {
      enabled: user.enabled,
      source: "user",
      ...user.reason ? { reason: user.reason } : {}
    };
  }
  if (org) {
    return {
      enabled: org.enabled,
      source: "org",
      ...org.reason ? { reason: org.reason } : {}
    };
  }
  return { enabled: true, source: "desired" };
}
async function getRuntimeAgentExtensionsSnapshot(input, options = {}) {
  const config = {
    projectDir: input.projectDir,
    scope: input.scope ?? "project",
    ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
  };
  const stateLocation = {
    scope: config.scope,
    projectDir: config.projectDir,
    ...config.dataRoot ? { dataRoot: config.dataRoot } : {}
  };
  const root = agentExtensionStateRoot(stateLocation);
  const [desired, lock, materialized] = await Promise.all([
    readDesiredExtensionState(installedStatePath(stateLocation)),
    readExtensionLock(lockStatePath(root)),
    readMaterializedRuntimeRecord(materializedRecordPath(root))
  ]);
  const desiredInstalls = desired.installs.filter(
    (item) => config.scope !== "project" || item.id !== FIRST_PARTY_AGENT_EXTENSION_ID || item.source.type !== "project"
  );
  const firstParty = config.scope !== "project" || desiredInstalls.some((item) => item.id === FIRST_PARTY_AGENT_EXTENSION_ID) ? void 0 : await discoverFirstPartyAgentExtensions(config.projectDir);
  const localIds = /* @__PURE__ */ new Set([
    ...desiredInstalls.map((item) => item.id),
    ...firstParty ? [firstParty.id] : []
  ]);
  const workspace = (options.workspaceInstalls ?? []).filter((item) => !localIds.has(item.desired.id));
  const installs = [
    ...desiredInstalls.map((item) => ({
      desired: item,
      lock: lock.packages[item.id],
      status: materialized.packages[item.id]?.status,
      components: materialized.packages[item.id]?.components ?? []
    })),
    ...firstParty ? [{
      desired: firstParty,
      status: materialized.packages[firstParty.id]?.status,
      components: materialized.packages[firstParty.id]?.components ?? []
    }] : [],
    ...workspace.map((item) => ({
      desired: item.desired,
      lock: item.lock,
      components: []
    }))
  ];
  return {
    version: 1,
    // Disabled installs stay in the snapshot with enabled=false. Replay treats
    // the snapshot as the whole world, so dropping them would erase their
    // desired/lock state and delete their artifacts as stale — disable would
    // become uninstall. Effective policy is folded into desired.enabled so the
    // replaying runtime never materializes a policy-blocked install.
    installs: installs.map((item) => ({
      ...item,
      effective: resolveEffectiveAgentExtensionPolicy(item.desired, options.policyOverrides)
    })).map((item) => ({
      desired: item.effective.enabled === item.desired.enabled ? item.desired : { ...item.desired, enabled: item.effective.enabled },
      ...item.lock ? { lock: item.lock } : {},
      ...item.status ? { status: item.status } : {},
      effective: item.effective,
      components: item.components.map((component) => ({
        runner: component.runner,
        component: component.component,
        type: component.type,
        status: component.status,
        ...component.reason ? { reason: component.reason } : {},
        ...component.checksum ? { checksum: component.checksum } : {}
      }))
    }))
  };
}

// src/facade.ts
function resolved(input = {}) {
  const homeDir = input.homeDir ?? os3.homedir();
  return {
    projectDir: path16.resolve(input.projectDir ?? process.cwd()),
    homeDir,
    dataRoot: path16.resolve(input.dataRoot ?? path16.join(homeDir, ".claxedo")),
    scope: input.scope ?? "project",
    ...input.now !== void 0 ? { now: input.now } : {}
  };
}
function withDefaults(input) {
  const defaults = resolved(input);
  return {
    id: input.id,
    scope: input.scope ?? defaults.scope,
    projectDir: defaults.projectDir,
    dataRoot: defaults.dataRoot,
    homeDir: defaults.homeDir,
    ...input.now !== void 0 ? { now: input.now } : defaults.now !== void 0 ? { now: defaults.now } : {}
  };
}
function installDefaults(input) {
  const defaults = resolved(input);
  return {
    scope: input.scope ?? defaults.scope,
    projectDir: defaults.projectDir,
    dataRoot: defaults.dataRoot,
    homeDir: defaults.homeDir,
    ...input.now !== void 0 ? { now: input.now } : defaults.now !== void 0 ? { now: defaults.now } : {}
  };
}
function projectSourceRoot(input) {
  return path16.resolve(input.projectDir, input.packagePath);
}
function targetList(input) {
  if (input === void 0) return void 0;
  if (!Array.isArray(input)) throw new Error("targets must be an array");
  const targets2 = input.filter(isHarnessTarget);
  if (targets2.length !== input.length) throw new Error("targets include unsupported harness names");
  return targets2;
}
async function cachedInstallFromProjectPath(input) {
  const defaults = installDefaults(input);
  const sourceRoot = defaults.projectDir;
  const packageRoot = projectSourceRoot({
    projectDir: defaults.projectDir,
    packagePath: input.packagePath
  });
  return installCachedAgentExtension({
    sourceRoot,
    source: {
      type: "project",
      package_path: input.packagePath
    },
    resolvedSha: await digestDirectory(packageRoot),
    packagePath: input.packagePath,
    ...defaults,
    ...input.targets ? { targets: input.targets } : {},
    ...input.id ? { id: input.id } : {}
  });
}
function stateFiles(input = {}) {
  const defaults = resolved(input);
  return agentExtensionFiles({
    scope: input.scope ?? defaults.scope,
    projectDir: defaults.projectDir,
    dataRoot: defaults.dataRoot
  });
}
async function list(input = {}) {
  const files = stateFiles(input);
  const [desired, materialized] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readMaterializedRuntimeRecord(files.materialized)
  ]);
  return { desired, materialized };
}
function lockCacheRoot(locked, dataRoot) {
  try {
    return cachePackageRoot({
      resolvedSha: locked.resolved_sha,
      ...locked.package_path ? { packagePath: locked.package_path } : {},
      dataRoot
    });
  } catch {
    return void 0;
  }
}
async function readOrReport(read, empty, file, issues) {
  try {
    return await read;
  } catch (err) {
    issues.push({
      code: "corrupt_state_file",
      message: err instanceof Error ? err.message : String(err),
      path: file
    });
    return empty;
  }
}
async function doctor(input = {}) {
  const defaults = resolved(input);
  const files = stateFiles(input);
  const corruption = [];
  const [desired, lock, materialized] = await Promise.all([
    readOrReport(readDesiredExtensionState(files.installed), { version: 1, installs: [] }, files.installed, corruption),
    readOrReport(readExtensionLock(files.lock), { version: 1, packages: {} }, files.lock, corruption),
    readOrReport(readMaterializedRuntimeRecord(files.materialized), { version: 1, packages: {} }, files.materialized, corruption)
  ]);
  const desiredIds = new Set(desired.installs.map((item) => item.id));
  const lockIds = new Set(Object.keys(lock.packages));
  const issues = [
    ...corruption,
    ...desired.installs.flatMap((item) => item.targets.every(isHarnessTarget) ? [] : [{
      code: "invalid_targets",
      message: `Agent Extension ${item.id} contains unsupported targets`,
      id: item.id
    }]),
    ...desired.installs.flatMap((item) => item.enabled && item.source.type === "github" && !lock.packages[item.id] ? [{
      code: "missing_lock",
      message: `Enabled GitHub Agent Extension ${item.id} has no lock record`,
      id: item.id
    }] : []),
    ...Object.entries(lock.packages).flatMap(([id, locked]) => {
      const cacheRoot = lockCacheRoot(locked, defaults.dataRoot);
      return desiredIds.has(id) ? [] : [{
        code: "orphaned_lock",
        message: `Lock record ${id} has no desired install`,
        id,
        ...cacheRoot ? { path: cacheRoot } : {}
      }];
    }),
    ...Object.keys(materialized.packages).flatMap((id) => desiredIds.has(id) || lockIds.has(id) ? [] : [{
      code: "orphaned_materialized_record",
      message: `Materialized record ${id} has no desired install or lock record`,
      id
    }])
  ];
  for (const [id, locked] of Object.entries(lock.packages)) {
    const cacheRoot = lockCacheRoot(locked, defaults.dataRoot);
    if (!cacheRoot) {
      issues.push({
        code: "invalid_lock_record",
        message: `Lock record ${id} has an invalid resolved SHA or package path`,
        id
      });
      continue;
    }
    if (!await fs12.stat(cacheRoot).then((stat) => stat.isDirectory()).catch(() => false)) {
      issues.push({
        code: "missing_cache",
        message: `Cache root for ${id} is missing`,
        id,
        path: cacheRoot
      });
    }
  }
  for (const [id, pkg] of Object.entries(materialized.packages)) {
    for (const component of pkg.components) {
      if (!component.path || component.status !== "applied") continue;
      const stat = await fs12.lstat(component.path).catch(() => void 0);
      if (!stat) {
        issues.push({
          code: "missing_materialized_path",
          message: `Materialized path for ${id}/${component.component} is missing`,
          id,
          path: component.path
        });
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs12.realpath(component.path).catch(() => void 0);
        if (!target) {
          issues.push({
            code: "stale_materialized_symlink",
            message: `Materialized symlink for ${id}/${component.component} is stale`,
            id,
            path: component.path
          });
        }
      }
    }
  }
  return {
    ok: issues.length === 0,
    issues
  };
}
function createAgentExtensions(options = {}) {
  const defaults = resolved(options);
  return {
    install(input) {
      return installGitHubAgentExtension({
        source: input.source,
        ...installDefaults({ ...defaults, ...input }),
        ...input.targets ? { targets: input.targets } : {},
        ...input.id ? { id: input.id } : {}
      });
    },
    installCached(input) {
      if (input.packagePath && !input.sourceRoot) {
        return cachedInstallFromProjectPath({
          ...defaults,
          ...input,
          packagePath: input.packagePath
        });
      }
      if (!input.sourceRoot) throw new Error("sourceRoot or packagePath is required");
      const sourceRoot = path16.resolve(input.sourceRoot);
      return digestDirectory(sourceRoot).then((checksum) => installCachedAgentExtension({
        sourceRoot,
        source: input.source ?? {
          type: "project",
          package_path: input.packagePath ?? path16.basename(sourceRoot)
        },
        resolvedSha: input.resolvedSha ?? checksum,
        ...installDefaults({ ...defaults, ...input }),
        ...input.targets ? { targets: input.targets } : {},
        ...input.id ? { id: input.id } : {},
        ...input.replaceOwned !== void 0 ? { replaceOwned: input.replaceOwned } : {}
      }));
    },
    list(input = {}) {
      return list({ ...defaults, ...input });
    },
    update(input) {
      return updateAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }));
    },
    enable(input) {
      return enableAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }));
    },
    disable(input) {
      return disableAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }));
    },
    uninstall(input) {
      return uninstallAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }));
    },
    snapshot(input = {}) {
      const settings = resolved({ ...defaults, ...input });
      return getRuntimeAgentExtensionsSnapshot({
        projectDir: settings.projectDir,
        scope: settings.scope,
        dataRoot: settings.dataRoot
      }, {
        ...input.workspaceInstalls ? { workspaceInstalls: input.workspaceInstalls } : {},
        ...input.policyOverrides ? { policyOverrides: input.policyOverrides } : {}
      });
    },
    async materialize(input = {}) {
      const settings = resolved({ ...defaults, ...input });
      return applyRuntimeAgentExtensions(await getRuntimeAgentExtensionsSnapshot({
        projectDir: settings.projectDir,
        scope: settings.scope,
        dataRoot: settings.dataRoot
      }), settings.projectDir, {
        homeDir: settings.homeDir,
        stateRoot: stateFiles(settings).root,
        ...input.now !== void 0 ? { now: input.now } : defaults.now !== void 0 ? { now: defaults.now } : {}
      });
    },
    doctor(input = {}) {
      return doctor({ ...defaults, ...input });
    }
  };
}
function parseHarnessTargets(input) {
  return targetList(input?.split(",").map((item) => item.trim()).filter(Boolean));
}

// src/workspace.ts
function object(input) {
  return input && typeof input === "object" ? input : void 0;
}
function desiredInstall(input) {
  const row = object(input);
  if (!row) return;
  if (typeof row.id !== "string") return;
  if (typeof row.package_name !== "string") return;
  if (row.scope !== "workspace") return;
  if (typeof row.enabled !== "boolean") return;
  if (!object(row.source)) return;
  if (!Array.isArray(row.targets)) return;
  if (!row.targets.every(isHarnessTarget)) return;
  if (typeof row.installed_at !== "number") return;
  if (typeof row.updated_at !== "number") return;
  return row;
}
function lockedPackage(input) {
  const row = object(input);
  if (!row) return;
  if (typeof row.resolved_sha !== "string") return;
  if (!object(row.source)) return;
  if (!object(row.manifest_digests)) return;
  if (!object(row.component_digests)) return;
  if (!Array.isArray(row.targets)) return;
  if (!row.targets.every(isHarnessTarget)) return;
  return row;
}
function dataRootFor2(input) {
  return input.dataRoot;
}
function filesFor2(input) {
  return workspaceAgentExtensionFiles({
    ...input,
    dataRoot: dataRootFor2(input)
  });
}
function workspaceAgentExtensionRecords(input) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    const row = object(item);
    const desired = desiredInstall(row?.desired);
    if (!desired) return [];
    const lock = lockedPackage(row?.lock);
    return [{
      desired,
      ...lock ? { lock } : {}
    }];
  });
}
async function resolveGitHubWorkspaceAgentExtension(input) {
  const source3 = parsePackageSource(input.source);
  if (source3.type !== "github") throw new Error("Only GitHub workspace Agent Extension sources are supported");
  const cache = await fetchGitHubPackageToCache({
    source: source3,
    dataRoot: dataRootFor2(input)
  });
  const packageType = await discoverAgentExtensionPackage(cache.path);
  const packageName2 = packageType.type === "marketplace" ? input.id ?? source3.repo : packageType.name;
  const targets2 = input.targets ?? allAgentExtensionTargets();
  const checksum = await digestDirectory(cache.path);
  return {
    id: input.id ?? packageName2,
    package: packageType,
    cache,
    record: {
      desired: {
        id: input.id ?? packageName2,
        package_name: packageName2,
        source: source3,
        scope: "workspace",
        enabled: true,
        targets: targets2,
        installed_at: input.now ?? Date.now(),
        updated_at: input.now ?? Date.now()
      },
      lock: {
        source: source3,
        resolved_sha: cache.resolvedSha,
        ...source3.package_path ? { package_path: source3.package_path } : {},
        manifest_digests: { package: checksum },
        component_digests: { package: checksum },
        targets: targets2
      }
    }
  };
}
async function mirrorWorkspaceAgentExtensionRecord(input) {
  const files = filesFor2(input);
  const lock = await readExtensionLock(files.lock);
  await Promise.all([
    upsertDesiredExtensionInstall(files.installed, input.record.desired),
    writeExtensionLock(files.lock, {
      version: 1,
      packages: {
        ...lock.packages,
        [input.record.desired.id]: input.record.lock
      }
    })
  ]);
}
async function readMirroredWorkspaceAgentExtensions(input) {
  const files = filesFor2(input);
  const [desired, lock] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readExtensionLock(files.lock)
  ]);
  return desired.installs.map((item) => ({
    desired: item,
    ...lock.packages[item.id] ? { lock: lock.packages[item.id] } : {}
  }));
}
async function setMirroredWorkspaceAgentExtensionEnabled(input) {
  await setDesiredExtensionEnabled(filesFor2(input).installed, input.id, input.enabled, input.now ?? Date.now());
}
async function removeMirroredWorkspaceAgentExtension(input) {
  const files = filesFor2(input);
  const lock = await readExtensionLock(files.lock);
  const { [input.id]: _removed, ...packages } = lock.packages;
  await Promise.all([
    removeDesiredExtensionInstall(files.installed, input.id),
    writeExtensionLock(files.lock, { version: 1, packages })
  ]);
}

// src/materializers/hooks.ts
import fs13 from "fs/promises";
import path17 from "path";
var NOTIFY_SCRIPT = "notify.sh";
var GEMINI_HOOK_SCRIPT = "gemini-hook.sh";
var CURSOR_HOOK_SCRIPT = "cursor-hook.sh";
var CLAUDE_NOTIFY_RELATIVE = `hooks/${NOTIFY_SCRIPT}`;
var CLAUDE_DYNAMIC_NOTIFY = `$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}`;
var MANAGED_HOOK_PATH_PATTERN = /\/\.claxedo(?:-[^/'"\s\\]+)?\//;
function asRecord2(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}
function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function readJson4(filePath) {
  const raw = await readFileIfExists(filePath);
  if (raw === void 0 || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Hook target config ${filePath} contains invalid JSON; fix it before materializing hooks (refusing to rewrite a file that cannot be parsed): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
async function writeIfChanged(filePath, content, mode, force) {
  if (!force) {
    const existing = await fs13.readFile(filePath, "utf-8").catch(() => void 0);
    if (existing === content) return false;
  }
  await fs13.mkdir(path17.dirname(filePath), { recursive: true, mode: 493 });
  await writeFileAtomic(filePath, content, mode);
  return true;
}
function isManagedHookCommand(command, scriptName) {
  if (!command) return false;
  const normalized = command.replaceAll("\\", "/");
  if (!normalized.includes(`/hooks/${scriptName}`)) return false;
  return MANAGED_HOOK_PATH_PATTERN.test(normalized);
}
function reconcileManagedEntries(input) {
  const existing = Array.isArray(input.current) ? input.current : [];
  return [
    ...existing.filter((entry) => !input.isManaged(entry)),
    ...input.desired
  ];
}
function targetPaths(homeDir) {
  return {
    claude: path17.join(homeDir, ".claude", "settings.json"),
    codex: path17.join(homeDir, ".codex", "hooks.json"),
    cursor: path17.join(homeDir, ".cursor", "hooks.json"),
    droid: path17.join(homeDir, ".factory", "settings.json"),
    gemini: path17.join(homeDir, ".gemini", "settings.json"),
    mastra: path17.join(homeDir, ".mastracode", "hooks.json")
  };
}
function getClaudeManagedHookCommand() {
  return `[ -n "$CLAXEDO_HOME_DIR" ] && [ -x "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" ] && "$CLAXEDO_HOME_DIR/${CLAUDE_NOTIFY_RELATIVE}" || true`;
}
function isManagedClaudeHookCommand(command, notifyScriptPath) {
  return command?.includes(notifyScriptPath) || command?.includes(CLAUDE_DYNAMIC_NOTIFY) || isManagedHookCommand(command, NOTIFY_SCRIPT);
}
function removeManagedHooksFromDefinition(definition, isManaged) {
  const hooks = definition.hooks;
  if (!Array.isArray(hooks)) return definition;
  const filtered = hooks.filter((hook) => !isManaged(asRecord2(hook).command));
  if (filtered.length === hooks.length) return definition;
  if (filtered.length === 0) return null;
  return { ...definition, hooks: filtered };
}
async function upsertNestedHookSettings(input) {
  const existing = asRecord2(await readJson4(input.file));
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
  const hooks = existing.hooks;
  for (const item of input.events) {
    const current = hooks[item.event];
    if (Array.isArray(current)) {
      hooks[item.event] = [
        ...current.flatMap((def) => {
          const cleaned = removeManagedHooksFromDefinition(asRecord2(def), input.isManaged);
          return cleaned ? [cleaned] : [];
        }),
        item.definition
      ];
      continue;
    }
    hooks[item.event] = [item.definition];
  }
  await writeIfChanged(input.file, JSON.stringify(existing, null, 2) + "\n", 420, input.force);
}
async function materializeClaude(input) {
  const command = getClaudeManagedHookCommand();
  await upsertNestedHookSettings({
    ...input,
    events: [
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command }] } },
      { event: "SubagentStop", definition: { hooks: [{ type: "command", command }] } },
      { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PostToolUseFailure", definition: { matcher: "*", hooks: [{ type: "command", command }] } },
      { event: "PermissionRequest", definition: { matcher: "*", hooks: [{ type: "command", command }] } }
    ],
    isManaged: (command2) => isManagedClaudeHookCommand(command2, input.notifyPath)
  });
}
async function materializeDroid(input) {
  await upsertNestedHookSettings({
    ...input,
    events: [
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "Notification", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "PostToolUse", definition: { matcher: "*", hooks: [{ type: "command", command: input.notifyPath }] } }
    ],
    isManaged: (command) => command?.includes(input.notifyPath) || isManagedHookCommand(command, NOTIFY_SCRIPT)
  });
}
function pruneCodexHooks(hooks, notifyPath) {
  for (const [name, current] of Object.entries(hooks)) {
    if (!Array.isArray(current)) continue;
    const entries = current.flatMap((def) => {
      const next = removeManagedHooksFromDefinition(
        asRecord2(def),
        (cmd) => cmd?.includes(notifyPath) || isManagedHookCommand(cmd, NOTIFY_SCRIPT)
      );
      return next ? [next] : [];
    });
    if (entries.length === 0) {
      delete hooks[name];
      continue;
    }
    hooks[name] = entries;
  }
}
async function materializeCodex(input) {
  const existing = asRecord2(await readJson4(input.file));
  if (!existing.hooks && !input.native) return;
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
  const hooks = existing.hooks;
  pruneCodexHooks(hooks, input.notifyPath);
  if (input.native) {
    const events = [
      { event: "SessionStart", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "UserPromptSubmit", definition: { hooks: [{ type: "command", command: input.notifyPath }] } },
      { event: "Stop", definition: { hooks: [{ type: "command", command: input.notifyPath }] } }
    ];
    for (const item of events) {
      const current = hooks[item.event];
      hooks[item.event] = Array.isArray(current) ? [...current, item.definition] : [item.definition];
    }
  }
  if (Object.keys(hooks).length === 0) delete existing.hooks;
  await writeIfChanged(input.file, JSON.stringify(existing, null, 2) + "\n", 420, input.force);
}
async function materializeGemini(input) {
  const root = asRecord2(await readJson4(input.file));
  if (!root.hooks || typeof root.hooks !== "object") root.hooks = {};
  const hooks = root.hooks;
  for (const event of ["BeforeAgent", "AfterAgent", "AfterTool"]) {
    hooks[event] = reconcileManagedEntries({
      current: hooks[event],
      desired: [{ hooks: [{ type: "command", command: input.hookPath }] }],
      isManaged: (entry) => {
        const nested = Array.isArray(asRecord2(entry).hooks) ? asRecord2(entry).hooks : [];
        return nested.some((hook) => {
          const command = asRecord2(hook).command;
          return command === input.hookPath || isManagedHookCommand(command, GEMINI_HOOK_SCRIPT);
        });
      },
      isEquivalent: (a, b) => JSON.stringify(asRecord2(a).hooks ?? []) === JSON.stringify(asRecord2(b).hooks ?? [])
    });
  }
  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 420, input.force);
}
async function materializeCursor(input) {
  const root = asRecord2(await readJson4(input.file));
  if (typeof root.version !== "number") root.version = 1;
  if (!root.hooks || typeof root.hooks !== "object") root.hooks = {};
  const hooks = root.hooks;
  const desired = {
    beforeSubmitPrompt: { command: `${input.hookPath} Start` },
    stop: { command: `${input.hookPath} Stop` },
    beforeShellExecution: { command: `${input.hookPath} PermissionRequest` },
    beforeMCPExecution: { command: `${input.hookPath} PermissionRequest` }
  };
  for (const [event, entry] of Object.entries(desired)) {
    hooks[event] = reconcileManagedEntries({
      current: hooks[event],
      desired: [entry],
      isManaged: (item) => {
        const command = asRecord2(item).command;
        return command?.includes(input.hookPath) || isManagedHookCommand(command, CURSOR_HOOK_SCRIPT);
      },
      isEquivalent: (a, b) => asRecord2(a).command === asRecord2(b).command
    });
  }
  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 420, input.force);
}
async function materializeMastra(input) {
  const root = asRecord2(await readJson4(input.file));
  const command = `bash ${shellQuote(input.notifyPath)}`;
  for (const event of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
    root[event] = reconcileManagedEntries({
      current: root[event],
      desired: [{ type: "command", command }],
      isManaged: (entry) => {
        const current = asRecord2(entry).command;
        return current?.includes(input.notifyPath) || isManagedHookCommand(current, NOTIFY_SCRIPT);
      },
      isEquivalent: (a, b) => asRecord2(a).command === asRecord2(b).command
    });
  }
  await writeIfChanged(input.file, JSON.stringify(root, null, 2) + "\n", 420, input.force);
}
async function applyHook(input) {
  try {
    await input.run();
    return { runner: input.runner, component: "hooks", type: "hook", status: "applied", path: input.file };
  } catch (error) {
    return {
      runner: input.runner,
      component: "hooks",
      type: "hook",
      status: "failed",
      path: input.file,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
async function materializeAgentHooks(input) {
  const files = targetPaths(input.homeDir);
  const force = input.force ?? false;
  const codexNativeHooks = input.codexNativeHooks ?? false;
  return Promise.all([
    applyHook({
      runner: "claude",
      file: files.claude,
      run: () => materializeClaude({ file: files.claude, notifyPath: input.notifyPath, force })
    }),
    applyHook({
      runner: "codex",
      file: files.codex,
      run: () => materializeCodex({ file: files.codex, notifyPath: input.notifyPath, force, native: codexNativeHooks })
    }),
    applyHook({
      runner: "droid",
      file: files.droid,
      run: () => materializeDroid({ file: files.droid, notifyPath: input.notifyPath, force })
    }),
    applyHook({
      runner: "gemini",
      file: files.gemini,
      run: () => materializeGemini({ file: files.gemini, hookPath: input.geminiHookPath, force })
    }),
    applyHook({
      runner: "cursor",
      file: files.cursor,
      run: () => materializeCursor({ file: files.cursor, hookPath: input.cursorHookPath, force })
    }),
    applyHook({
      runner: "mastra",
      file: files.mastra,
      run: () => materializeMastra({ file: files.mastra, notifyPath: input.notifyPath, force })
    })
  ]);
}

// src/materializers/opencode-agent.ts
import fs14 from "fs/promises";
import path18 from "path";
var OPENCODE_DOC_AGENT_FILE = "doc.md";
function generateOpenCodeDocAgentMarkdown() {
  return `---
mode: all
hidden: true
description: "Page assistant - helps with the current document."
color: "#6B7280"
---
You are a document assistant for a rich-text page editor.
The system prompt tells you the page's markdown mirror path - read it to understand the current content.

Use standard read/search tools to inspect the markdown mirror and nearby files for context, but do not write the mirror file directly.

Response rules:
- If the message is a normal chat request about the page, answer concisely and helpfully.
- If the message follows the inline editor protocol with \`action:"..."\`, \`context:"..."\`, and optional \`instruction:"..."\`, treat it as an inline rewrite request.
- For inline rewrite requests, do not call tools, do not explain your work, and return raw text only.
- For \`improve\`, \`fix\`, \`shorten\`, and \`lengthen\`, preserve the user's language and tone unless instructed otherwise.
- For \`summarize\`, return only the summary text.
- For \`continue\`, return only the continuation text.
- For \`custom\`, follow the instruction using any provided context and return only the resulting text.
- When the user wants the page itself changed outside the inline editor protocol, propose the exact markdown change instead of editing the mirror file directly.

**Page tasks**: answer questions, suggest edits, summarise, and help the user with their document. Keep answers concise and relevant to the page.
`;
}
async function materializeOpenCodeDocAgent(input) {
  const file = path18.join(input.agentDir, OPENCODE_DOC_AGENT_FILE);
  const content = generateOpenCodeDocAgentMarkdown();
  if (!input.force) {
    const existing = await fs14.readFile(file, "utf8").catch(() => void 0);
    if (existing === content) return { path: file, status: "unchanged" };
  }
  await fs14.mkdir(input.agentDir, { recursive: true, mode: 493 });
  await fs14.writeFile(file, content, { mode: 420 });
  return { path: file, status: "applied" };
}
export {
  AgentExtensionCacheError,
  AgentExtensionConflictError,
  AgentExtensionFetchError,
  AgentExtensionIntegrityError,
  AgentExtensionManifestError,
  AgentExtensionMaterializationError,
  AgentExtensionSourceError,
  AgentExtensionStateError,
  FIRST_PARTY_AGENT_EXTENSIONS_DIR,
  FIRST_PARTY_AGENT_EXTENSION_ID,
  FIRST_PARTY_AGENT_EXTENSION_PACKAGE_NAME,
  HARNESS_TARGETS,
  OPENCODE_DOC_AGENT_FILE,
  agentExtensionCacheRoot,
  agentExtensionFiles,
  agentExtensionStateRoot,
  allAgentExtensionTargets,
  allHarnessTargets,
  applyRuntimeAgentExtensions,
  cachePackageRoot,
  componentOwnedBy,
  copyPackageToCache,
  createAgentExtensions,
  cursorLocalPluginDir,
  digestDirectory,
  disableAgentExtension,
  discoverAgentExtensionComponents,
  discoverAgentExtensionPackage,
  enableAgentExtension,
  encodeDesiredState,
  encodeLock,
  fetchGitHubPackageToCache,
  generateOpenCodeDocAgentMarkdown,
  getClaudeManagedHookCommand,
  getRuntimeAgentExtensionsSnapshot,
  githubRepoUrl,
  installCachedAgentExtension,
  installFetchedAgentExtension,
  installGitHubAgentExtension,
  installedStatePath,
  isHarnessTarget,
  isRemotePackageSource,
  linkOrCopyOwnedDirectory,
  lockStatePath,
  lockedPackageDigest,
  materializeAgentExtensionSnapshot,
  materializeAgentHooks,
  materializeCursorLocalPlugin,
  materializeOpenCodeDocAgent,
  materializeStandaloneMcp,
  materializeStandaloneSkill,
  materializedAgentExtensionFiles,
  materializedRecordPath,
  mcpTargetPath,
  mirrorWorkspaceAgentExtensionRecord,
  normalizeStandaloneMcpConfig,
  parseHarnessTargets,
  parsePackageSource,
  readDesiredExtensionState,
  readExtensionLock,
  readMaterializedRuntimeRecord,
  readMirroredWorkspaceAgentExtensions,
  removeDesiredExtensionInstall,
  removeMirroredWorkspaceAgentExtension,
  removeStaleMaterializedComponents,
  removeStandaloneMcpEntries,
  resolveEffectiveAgentExtensionPolicy,
  resolveGitHubSource,
  resolveGitHubWorkspaceAgentExtension,
  safeRelativePath,
  samePackageSourceIdentity,
  sameSource,
  setDesiredExtensionEnabled,
  setMirroredWorkspaceAgentExtensionEnabled,
  skillTargetDir,
  sortedLock,
  uninstallAgentExtension,
  uninstallOwnedComponents,
  updateAgentExtension,
  upsertDesiredExtensionInstall,
  verifyPackageIntegrity,
  workspaceAgentExtensionFiles,
  workspaceAgentExtensionRecords,
  writeDesiredExtensionState,
  writeExtensionLock,
  writeMaterializedRuntimeRecord
};
