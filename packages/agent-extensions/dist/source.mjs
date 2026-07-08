import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

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
  if (value.includes("\\") || value.includes("..") || value.startsWith("/") || value.endsWith("/")) {
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
export {
  AgentExtensionSourceError,
  parsePackageSource,
  safeRelativePath,
  sameSource
};
