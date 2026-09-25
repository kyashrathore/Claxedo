export function privateRepoHosts(env: Record<string, string | undefined>): string[] {
  return (env.CLAXEDO_PRIVATE_REPO_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean)
}
