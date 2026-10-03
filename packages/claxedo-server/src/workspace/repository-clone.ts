import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"

const GITHUB_REPOSITORY_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/

/**
 * The brokered credential a sandbox clones and fetches one GitHub repository
 * with. Its route policy is the repository's smart-HTTP path, so the token
 * cannot be spent on any other repository or GitHub API.
 */
export function githubCloneSecret(repositoryUrl: string, token: string): SandboxBrokeredSecret {
  const url = new URL(repositoryUrl)
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password
    || url.search || url.hash || !GITHUB_REPOSITORY_PATH.test(url.pathname)) {
    throw new Error("github_repository_url_required")
  }
  return {
    name: "CLAXEDO_GITHUB_CLONE_AUTH",
    value: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    hosts: ["github.com"],
    header: "Authorization",
    methods: ["GET", "POST"],
    pathPrefixes: [`${url.pathname}/`],
  }
}
