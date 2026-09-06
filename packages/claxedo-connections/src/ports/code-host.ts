import type { CodeHostRepository, ConnectionFields } from "../types.js"

/**
 * `code-host` — the repository host a workspace clones from.
 *
 * The one action-served capability: it names a method, so an integration that
 * declares this port and does not implement it fails to compile. This is the
 * case the whole port layer exists for. `capabilities: ["code-host"]` used to
 * be an authored string that nothing checked, so a declaration could claim the
 * capability with no `listRepositories` behind it, resolve for it, and fail
 * only at the call.
 */
export type CodeHostPort = {
  readonly capability: "code-host"
  listRepositories(fields: ConnectionFields, secret: string): Promise<CodeHostRepository[]>
}
