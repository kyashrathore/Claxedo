/**
 * Environment sanitization for PTY sessions.
 *
 * Allowlist-based: only explicitly allowed variables pass through.
 * Prefix-based passthrough for OPENCODE_* and CLAXEDO_*.
 * Explicit deny list for dangerous variables.
 */

const ALLOWED_VARS = new Set([
  // Shell core
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "PWD", "OLDPWD",
  "HOSTNAME", "SHLVL", "_",

  // Localization
  "LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY",
  "LC_NUMERIC", "LC_TIME", "TZ",

  // SSH
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",

  // Language managers
  "NVM_DIR", "NVM_BIN", "NVM_INC", "NVM_CD_FLAGS", "NVM_RC_VERSION",
  "PYENV_ROOT", "PYENV_SHELL",
  "GOPATH", "GOROOT", "GOBIN",
  "CARGO_HOME", "RUSTUP_HOME",
  "DENO_DIR", "DENO_INSTALL",
  "BUN_INSTALL", "PNPM_HOME", "VOLTA_HOME",
  "ASDF_DIR", "ASDF_DATA_DIR",
  "FNM_DIR", "FNM_MULTISHELL_PATH",
  "SDKMAN_DIR",

  // Proxies
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
  "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
  "FTP_PROXY", "ftp_proxy",

  // Homebrew
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY",

  // XDG
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",

  // Editor
  "EDITOR", "VISUAL", "PAGER",

  // SSL
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE",

  // Git
  "GIT_SSH_COMMAND", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",

  // Cloud tools
  "AWS_PROFILE", "AWS_DEFAULT_REGION", "AWS_CONFIG_FILE",
  "DOCKER_HOST", "KUBECONFIG", "CLOUDSDK_CONFIG",

  // SDKs
  "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "FLUTTER_ROOT", "DOTNET_ROOT",

  // Windows
  "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMROOT", "WINDIR",
  "TEMP", "TMP", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",

  // macOS
  "__CF_USER_TEXT_ENCODING", "Apple_PubSub_Socket_Render",

  // Terminal metadata.
  //
  // COLORTERM describes colour capability, which is ours to claim and true
  // either way, so it passes through.
  //
  // The host terminal's IDENTITY markers do NOT pass through. We announce a
  // deliberate identity (see identity.ts) and these would contradict it: a TUI
  // that finds `KITTY_PID` or `ITERM_SESSION_ID` set concludes it is running
  // inside kitty or iTerm and enables terminal-specific behaviour our xterm
  // does not implement. Inheriting them from whatever launched the desktop app
  // made that behaviour vary per user machine.
  //
  // TERM_PROGRAM / TERM_PROGRAM_VERSION are set explicitly downstream of the
  // allowlist, so they are omitted here rather than passed through and
  // overwritten.
  "COLORTERM",

  // Misc
  "MANPATH", "INFOPATH", "LESS", "LESSOPEN", "LESSCLOSE",
  "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION",
  "GPG_TTY", "GNUPGHOME",
  "CLICOLOR", "CLICOLOR_FORCE", "FORCE_COLOR", "NO_COLOR",
  "COLUMNS", "LINES", "PORT",
])

const DENY_LIST = new Set([
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_PATH",
  "CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN",
])

/**
 * `CLAXEDO_` is DENY-BY-DEFAULT: an explicit allowlist, not a prefix passthrough.
 *
 * Everything built here is handed to an agent-driven child — PTY sessions,
 * `/exec`, managed processes — and in embedded mode the workspace runtime shares
 * a process with the control plane, so `process.env` carries the control plane's
 * own secrets. Under a prefix passthrough that meant a prompt-injected agent
 * could read them with `env`: JWT signing keys
 * (`CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM`,
 * `CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM`), the Convex machine principal
 * (`CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN`), the credential-store bearer, and
 * more. `CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN` was deny-listed individually,
 * which fixed one instance of the class rather than the class.
 *
 * A prefix passthrough is the wrong shape for a namespace that holds secrets:
 * it is correct only until the next secret is added, and nothing tells you when
 * that happens. Deny-by-default inverts that — the failure mode of adding a new
 * `CLAXEDO_*` var is that a child does not see it, not that a secret escapes.
 *
 * Names here are derived from what child processes actually read (claxedo-mcp
 * and the claxedo CLI); `pty/env.secrets.test.ts` re-derives the secret set from
 * the repo and fails if any of it becomes reachable.
 *
 * Deliberately absent: `CLAXEDO_ACCESS_TOKEN` / `CLAXEDO_DEV_TOKEN`. The CLI
 * reads them, but only as an override with a stored-credential fallback
 * (`~/.claxedo`, still reachable because HOME passes through), and a user who
 * wants the override in their own terminal can export it from their shell rc.
 * The box's ambient token must not be ambient to the agent.
 */
const ALLOWED_CLAXEDO_VARS = new Set([
  // Where the child talks to, and as what workspace/session.
  "CLAXEDO_SERVER_URL",
  "CLAXEDO_API_URL",
  "CLAXEDO_APP_URL",
  "CLAXEDO_CONTROL_PLANE_URL",
  "CLAXEDO_WORKSPACE_RELAY_URL",
  "CLAXEDO_SERVER_HOST",
  "CLAXEDO_SERVER_PORT",
  "CLAXEDO_LOCAL_CONTROL_PLANE_URL",
  // Identity of the surface the child is running inside (claxedo-mcp) and the
  // terminal env the shell integration injects (agent-hooks/core/shell.ts).
  "CLAXEDO_WORKSPACE_ID",
  "CLAXEDO_WR_WORKSPACE_ID",
  "CLAXEDO_SESSION_ID",
  "CLAXEDO_TAB_ID",
  "CLAXEDO_TERMINAL_ID",
  "CLAXEDO_PORT",
  "CLAXEDO_REPOSITORY_URL",
  "CLAXEDO_DESKTOP_URL",
  "CLAXEDO_AGENT",
  "CLAXEDO_ACP_MODEL",
  // Shell integration: zsh rc redirection needs the original ZDOTDIR back.
  "CLAXEDO_ORIG_ZDOTDIR",
  // Harness hook wiring read by the codex driver inside the child.
  "CLAXEDO_CODEX_NATIVE_HOOKS",
  "CLAXEDO_CODEX_START_WATCHER_PID",
  // Tool-policy posture (claxedo-mcp). Not secrets; read-only mode is a
  // capability restriction the child must be able to observe.
  "CLAXEDO_MCP_MODE",
  "CLAXEDO_MCP_READ_ONLY",
  // Paths. Not secrets — the child already has filesystem access.
  "CLAXEDO_DATA_DIR",
  "CLAXEDO_HOME",
  "CLAXEDO_HOME_DIR",
  "CLAXEDO_DIR",
])

/**
 * `OPENCODE_` stays a prefix passthrough: it is ~80 engine feature flags that a
 * child engine legitimately needs, and deny-by-default there would break the
 * engine rather than protect anything. Its handful of real secrets are named
 * here, and the suffix backstop below catches the shape generally.
 */
const DENIED_OPENCODE_VARS = new Set([
  "OPENCODE_API_KEY",
  "OPENCODE_CONSOLE_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_AUTH_CONTENT",
])

/**
 * Backstop applied to our two namespaces, allowlisted names included, so a
 * secret-shaped var cannot reach a child even if someone adds it to
 * `ALLOWED_CLAXEDO_VARS` by mistake.
 *
 * The leading `_` is load-bearing: without it `KEY` matches any name merely
 * ENDING in those letters (MONKEY, TURNKEY, …) and denies ordinary config.
 */
const SECRET_SHAPED = /_(TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS?|PEM)$/

export function isSecretShapedEnvName(name: string) {
  return SECRET_SHAPED.test(name.toUpperCase())
}

/**
 * Whether a prefixed var may be projected into an agent-driven child process.
 *
 * Scoped to `CLAXEDO_`/`OPENCODE_` on purpose. A host embedding the kit passes
 * its own `customPrefix` and owns that namespace's policy; silently filtering it
 * would change a documented kit contract to solve a problem that is ours, not
 * theirs.
 */
export function prefixedEnvAllowed(name: string) {
  const upper = name.toUpperCase()
  if (upper.startsWith("CLAXEDO_")) return ALLOWED_CLAXEDO_VARS.has(upper) && !isSecretShapedEnvName(upper)
  if (upper.startsWith("OPENCODE_")) return !DENIED_OPENCODE_VARS.has(upper) && !isSecretShapedEnvName(upper)
  return true
}

const DEFAULT_PREFIXES = ["OPENCODE_", "CLAXEDO_"]

/**
 * Where the env being filtered came from, which decides how `CLAXEDO_`/
 * `OPENCODE_` names are treated.
 *
 * - `"ambient"` (default): the host process's own `process.env`. This is the
 *   dangerous projection — in embedded mode it is the CONTROL PLANE's
 *   environment — so prefixed names are deny-by-default here.
 * - `"explicit"`: env the caller deliberately supplied for this child (a managed
 *   process's configured `env`, a PTY's `input.env`, an `/exec` body's `env`).
 *   Filtering these to the allowlist would break a documented feature and
 *   protect nothing: whoever wrote the value already has it, so passing it back
 *   teaches them nothing. Deny-listed and non-prefixed rules still apply.
 */
export type SafeEnvSource = "ambient" | "explicit"

export function buildSafeEnv(
  env: Record<string, string | undefined>,
  options?: { platform?: NodeJS.Platform; customPrefix?: string; source?: SafeEnvSource },
): Record<string, string> {
  const platform = options?.platform ?? process.platform
  const isWindows = platform === "win32"
  const source: SafeEnvSource = options?.source ?? "ambient"
  const prefixes = [...DEFAULT_PREFIXES]
  if (options?.customPrefix) {
    prefixes.push(options.customPrefix + "_")
  }

  // For Windows, build an uppercase set for case-insensitive matching
  let allowedUpper: Set<string> | undefined
  let denyUpper: Set<string> | undefined
  if (isWindows) {
    allowedUpper = new Set<string>()
    for (const v of ALLOWED_VARS) allowedUpper.add(v.toUpperCase())
    denyUpper = new Set<string>()
    for (const v of DENY_LIST) denyUpper.add(v.toUpperCase())
  }

  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue

    const checkKey = isWindows ? key.toUpperCase() : key

    // Deny list takes priority
    if (isWindows ? denyUpper!.has(checkKey) : DENY_LIST.has(key) || DENY_LIST.has(key.toUpperCase())) continue

    // Check allowlist
    if (isWindows ? allowedUpper!.has(checkKey) : ALLOWED_VARS.has(key)) {
      result[key] = value
      continue
    }

    // Check prefix matching. `prefixedEnvAllowed` is what makes `CLAXEDO_`
    // deny-by-default, and it applies only to the ambient projection — see
    // SafeEnvSource for why explicitly-supplied env is passed through.
    const prefixKey = isWindows ? checkKey : key
    if (prefixes.some((p) => prefixKey.startsWith(isWindows ? p.toUpperCase() : p))) {
      if (source === "ambient" && !prefixedEnvAllowed(key)) continue
      result[key] = value
    }
  }

  return result
}

export function getLocale(env: Record<string, string | undefined>): string {
  for (const key of ["LC_ALL", "LANG"]) {
    const val = env[key]
    if (val && /utf-?8/i.test(val)) return val
  }
  return "en_US.UTF-8"
}
