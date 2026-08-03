export function authenticatedGitHubCloneSource(repositoryUrl: string, token: string) {
  if (!repositoryUrl.startsWith("https://github.com/")) throw new Error("github_repository_url_required")
  const url = new URL(repositoryUrl)
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.endsWith(".git")) {
    throw new Error("github_repository_url_required")
  }
  return {
    repoUrl: url.toString(),
    secret: {
      name: "CLAXEDO_GITHUB_CLONE_AUTH",
      value: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      hosts: ["github.com"],
      header: "Authorization",
    },
  }
}
