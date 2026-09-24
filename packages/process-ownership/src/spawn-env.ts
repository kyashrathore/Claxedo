export const LOCAL_DOCUMENT_BROKER_TOKEN_ENV = "CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN"

/**
 * Harness children get a broad environment — tool configs, SDK variables, and
 * provider wiring differ per harness, so allowlisting every name would break
 * them. The exposure is narrower: in embedded mode the parent process env IS
 * the control plane's env, and every secret in it lives under two namespaces.
 * Those namespaces are deny-by-default with an explicit allowlist — the
 * failure mode of adding a new secret is that a child does not see it, not
 * that it escapes. `workspace-runtime/src/pty/env.ts` documents the same
 * model for PTY/managed children, and `spawn-env.secrets.test.ts` re-derives
 * the secret set from the repo so a new name fails there rather than leaking.
 */
const INTERNAL_PREFIXES = ["CLAXEDO_", "WORKSPACE_RUNTIME_"]

/**
 * Names agent children legitimately read: where the child talks to and as
 * what workspace/session, shell-integration wiring, codex hook pids, and the
 * deliberately agent-scoped grants — `WORKSPACE_RUNTIME_OWNER_GRANT` and the
 * tasks capability family are documented as agent-readable in
 * `claxedo-server-core/src/hosts/workspace-runtime/env.ts`.
 *
 * Deliberately absent: `CLAXEDO_CONTROL_PLANE_URL` /
 * `CLAXEDO_CONTROL_PLANE_JWKS_URL` (the first-party MCP lives on the runtime,
 * not the control plane — the child has no need to name it) and every
 * `WORKSPACE_RUNTIME_*` boot-identity var.
 */
const ALLOWED_INTERNAL_ENV = new Set([
  "CLAXEDO_SERVER_URL",
  "CLAXEDO_API_URL",
  "CLAXEDO_APP_URL",
  "CLAXEDO_WORKSPACE_RELAY_URL",
  "CLAXEDO_SERVER_HOST",
  "CLAXEDO_SERVER_PORT",
  "CLAXEDO_LOCAL_CONTROL_PLANE_URL",
  "CLAXEDO_WORKSPACE_ID",
  "CLAXEDO_WR_WORKSPACE_ID",
  "CLAXEDO_SESSION_ID",
  "CLAXEDO_TAB_ID",
  "CLAXEDO_TERMINAL_ID",
  "CLAXEDO_PORT",
  "CLAXEDO_REPOSITORY_URL",
  "CLAXEDO_AGENT",
  "CLAXEDO_ACP_MODEL",
  "CLAXEDO_ORIG_ZDOTDIR",
  "CLAXEDO_CODEX_NATIVE_HOOKS",
  "CLAXEDO_CODEX_START_WATCHER_PID",
  "CLAXEDO_DATA_DIR",
  "CLAXEDO_HOME",
  "CLAXEDO_HOME_DIR",
  "CLAXEDO_DIR",
  "WORKSPACE_RUNTIME_OWNER_GRANT",
  "WORKSPACE_RUNTIME_TASKS_CAPABILITY",
  "WORKSPACE_RUNTIME_TASKS_OPERATIONS",
  "WORKSPACE_RUNTIME_TASKS_PROJECT",
])

const SECRET_SHAPED = /_(TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS?|PEM)$/

export function harnessEnvAllowed(name: string) {
  const upper = name.toUpperCase()
  if (!INTERNAL_PREFIXES.some((p) => upper.startsWith(p))) return true
  return ALLOWED_INTERNAL_ENV.has(upper) && !SECRET_SHAPED.test(upper)
}

export function harnessSpawnEnv(input: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(input).filter(([name, value]) => {
    if (value === undefined) return false
    return harnessEnvAllowed(name)
  }))
}
