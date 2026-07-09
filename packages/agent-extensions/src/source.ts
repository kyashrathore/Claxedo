export type GitHubPackageSource = {
  type: "github"
  owner: string
  repo: string
  ref?: string
  package_path?: string
}

export type ProjectPackageSource = {
  type: "project"
  package_path: string
}

export type PackageInstallSource = GitHubPackageSource | ProjectPackageSource

export class AgentExtensionSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentExtensionSourceError"
  }
}

const ownerRepo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@(.+))?$/

export function safeRelativePath(input: string, label = "path") {
  const trimmed = input.trim()
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) throw new AgentExtensionSourceError(`${label} must be relative`)
  const value = trimmed.replace(/\/+$/g, "")
  if (!value) throw new AgentExtensionSourceError(`${label} must be a non-empty relative path`)
  if (input.includes("\\") || value.includes("\\")) throw new AgentExtensionSourceError(`${label} must not contain backslashes`)
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AgentExtensionSourceError(`${label} must stay inside the package root`)
  }
  return parts.join("/")
}

function safeRef(input: string) {
  const value = input.trim()
  if (!value) throw new AgentExtensionSourceError("GitHub ref must be non-empty")
  // Leading "-" would let the ref be parsed as a git option when passed as a
  // bare argument (e.g. to ls-remote); git refs cannot start with "-" anyway.
  if (value.includes("\\") || value.includes("..") || value.startsWith("/") || value.endsWith("/") || value.startsWith("-")) {
    throw new AgentExtensionSourceError("GitHub ref is unsafe")
  }
  return value
}

function source(input: {
  owner: string
  repo: string
  ref?: string
  packagePath?: string
}): PackageInstallSource {
  const repo = input.repo.endsWith(".git") ? input.repo.slice(0, -4) : input.repo
  if (!input.owner || !repo) throw new AgentExtensionSourceError("GitHub source must include owner and repo")
  return {
    type: "github",
    owner: input.owner,
    repo,
    ...(input.ref ? { ref: safeRef(input.ref) } : {}),
    ...(input.packagePath ? { package_path: safeRelativePath(input.packagePath, "package path") } : {}),
  }
}

export function parsePackageSource(input: string): PackageInstallSource {
  const value = input.trim()
  if (value.includes("\\") || value.includes("/../") || value.includes("/./")) {
    throw new AgentExtensionSourceError("package path must stay inside the package root")
  }
  const shorthand = ownerRepo.exec(value)
  if (shorthand) {
    return source({
      owner: shorthand[1]!,
      repo: shorthand[2]!,
      ...(shorthand[3] ? { ref: shorthand[3] } : {}),
    })
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AgentExtensionSourceError(`Unsupported Agent Extension source: ${input}`)
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new AgentExtensionSourceError("Only https://github.com sources are supported")
  }
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length < 2) throw new AgentExtensionSourceError("GitHub source must include owner and repo")
  if (parts.length === 2) return source({ owner: parts[0]!, repo: parts[1]! })
  if (parts[2] !== "tree" || parts.length < 4) {
    throw new AgentExtensionSourceError("Only GitHub repo roots and /tree/<ref>/<path> sources are supported")
  }
  return source({
    owner: parts[0]!,
    repo: parts[1]!,
    ref: decodeURIComponent(parts[3]!),
    ...(parts.length > 4 ? { packagePath: parts.slice(4).map(decodeURIComponent).join("/") } : {}),
  })
}

function sourceKey(input: PackageInstallSource) {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))))
}

export function sameSource(left: PackageInstallSource, right: PackageInstallSource) {
  return sourceKey(left) === sourceKey(right)
}
