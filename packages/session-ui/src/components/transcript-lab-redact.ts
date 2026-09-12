function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The home directory has to go first: `/Users/<user>/x` only collapses to `~/x` while the
 * username is still inside it, so a username-first pass would leave every path absolute.
 * The username also stands alone away from any path — the owner column of `ls -l` output,
 * and the dash-encoded project directory names under `~/.claude/projects` — which is what
 * the word boundaries catch.
 */
export function redactMachineIdentity<T>(value: T, home: string, user: string): T {
  const homePattern = new RegExp(escapeRegExp(home), "g")
  const userPattern = user ? new RegExp(`\\b${escapeRegExp(user)}\\b`, "g") : undefined

  const scrub = (text: string) => {
    const withoutHome = text.replaceAll(homePattern, "~")
    return userPattern ? withoutHome.replaceAll(userPattern, "user") : withoutHome
  }

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return scrub(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === "object") {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node)) result[key] = walk(item)
      return result
    }
    return node
  }

  return walk(value) as T
}
