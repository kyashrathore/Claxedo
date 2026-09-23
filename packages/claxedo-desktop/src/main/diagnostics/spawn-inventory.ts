export type SpawnClassification =
  | "registered-root"
  | "registered-descendant"
  | "in-process"
  | "remote-excluded"
  | "non-production"

export type SpawnCapability = "supported" | "unsupported" | "owner-dependent"

export type SpawnInventoryRow = {
  id: string
  family: string
  classification: SpawnClassification
  owner: string
  linkage: "app" | "workspace" | "session" | "harness" | "none"
  observation: "electron" | "host-tree" | "wsl" | "lifecycle-only" | "none"
  stop: SpawnCapability
  kill: SpawnCapability
  source?: {
    file: string
    callee: string
    calls: number
  }
}

const product = (
  row: Omit<SpawnInventoryRow, "classification"> & {
    classification?: Extract<SpawnClassification, "registered-root" | "registered-descendant" | "in-process">
  },
): SpawnInventoryRow => ({ ...row, classification: row.classification ?? "registered-descendant" })

/**
 * Checked ownership map for every process-creation seam in the four local
 * product packages. It deliberately contains labels and capabilities only:
 * commands, argv, environment, prompts, headers, and configuration never enter
 * the diagnostics contract.
 */
export const SPAWN_INVENTORY: readonly SpawnInventoryRow[] = [
  {
    id: "packaged-diagnostics-release-fixtures",
    family: "Packaged diagnostics release fixtures",
    classification: "non-production",
    owner: "diagnostics",
    linkage: "harness",
    observation: "host-tree",
    stop: "supported",
    kill: "supported",
    source: {
      file: "packages/claxedo-desktop/src/main/index.ts",
      callee: "spawn",
      calls: 2,
    },
  },
  product({
    id: "desktop-server",
    family: "Claxedo server",
    classification: "registered-root",
    owner: "desktop",
    linkage: "app",
    observation: "host-tree",
    stop: "supported",
    kill: "supported",
    source: {
      file: "packages/claxedo-desktop/src/main/index.ts",
      callee: "fork",
      calls: 1,
    },
  }),
  product({
    id: "desktop-app-launch",
    family: "User-requested application launcher",
    owner: "desktop",
    linkage: "app",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/claxedo-desktop/src/main/ipc.ts", callee: "execFile", calls: 1 },
  }),
  product({
    id: "desktop-rich-content-renderer",
    family: "One-shot native rich-content renderer",
    owner: "desktop",
    linkage: "session",
    observation: "host-tree",
    stop: "owner-dependent",
    kill: "owner-dependent",
    source: { file: "packages/claxedo-desktop/src/main/native-renderer.ts", callee: "spawn", calls: 1 },
  }),
  product({
    id: "machine-display-name",
    family: "macOS directory-service read for the operator's full name",
    owner: "desktop",
    linkage: "app",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/claxedo-helpers/src/machine-name.ts", callee: "execFileSync", calls: 1 },
  }),
  product({
    id: "private-file-permissions",
    family: "Windows owner-only create-verify-publish for a credential file, and the read of its protection",
    owner: "desktop",
    linkage: "app",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/claxedo-helpers/src/windows-private-file.ts", callee: "spawn", calls: 2 },
  }),
  product({
    id: "desktop-app-probes",
    family: "WSL and installed-application probes",
    owner: "desktop",
    linkage: "app",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/claxedo-desktop/src/main/apps.ts", callee: "execFileSync", calls: 3 },
  }),
  product({
    id: "diagnostics-workers",
    family: "Isolated POSIX and Windows metrics workers",
    classification: "registered-root",
    owner: "diagnostics",
    linkage: "app",
    observation: "electron",
    stop: "supported",
    kill: "supported",
    source: {
      file: "packages/claxedo-desktop/src/main/diagnostics/process-metrics-worker.ts",
      callee: "spawn",
      calls: 2,
    },
  }),
  product({
    id: "session-memory-scan-worker",
    family: "Triggered session memory scan worker",
    owner: "diagnostics",
    linkage: "app",
    observation: "host-tree",
    stop: "supported",
    kill: "supported",
    source: {
      file: "packages/claxedo-desktop/src/main/diagnostics/session-memory-worker.ts",
      callee: "spawn",
      calls: 1,
    },
  }),
  product({
    id: "macos-memory-impact-probe",
    family: "Bounded macOS physical-footprint probe",
    owner: "diagnostics",
    linkage: "app",
    observation: "host-tree",
    stop: "supported",
    kill: "supported",
    source: {
      file: "packages/claxedo-desktop/src/main/diagnostics/process-metrics-worker-runtime.ts",
      callee: "execFileAsync",
      calls: 1,
    },
  }),
  product({
    id: "diagnostics-wsl",
    family: "Bounded WSL metrics probe",
    classification: "registered-root",
    owner: "diagnostics",
    linkage: "app",
    observation: "wsl",
    stop: "supported",
    kill: "unsupported",
    source: { file: "packages/claxedo-desktop/src/main/diagnostics/wsl-source.ts", callee: "run", calls: 1 },
  }),
  product({
    id: "machine-login-harness-probe",
    family: "Harness machine-login probes",
    owner: "server",
    linkage: "app",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/claxedo-server-core/src/credentials/machine-login.ts", callee: "execFile", calls: 1 },
  }),
  product({
    id: "machine-login-codex-app-server",
    family: "One-shot codex app-server account read",
    owner: "server",
    linkage: "app",
    observation: "lifecycle-only",
    stop: "supported",
    kill: "supported",
    source: { file: "packages/claxedo-server-core/src/credentials/machine-login.ts", callee: "spawn", calls: 1 },
  }),
  product({
    id: "server-workspace-git",
    family: "Workspace Git metadata",
    owner: "server",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "owner-dependent",
    kill: "unsupported",
    source: { file: "packages/claxedo-server-core/src/workspace/store/index.ts", callee: "execFileAsync", calls: 1 },
  }),
  product({
    id: "server-workspace-route-git",
    family: "Workspace route Git operations",
    owner: "server",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "owner-dependent",
    kill: "unsupported",
    source: {
      file: "packages/claxedo-server/src/workspace/git.ts",
      callee: "execFileAsync",
      calls: 1,
    },
  }),
  product({
    id: "local-shell-command",
    family: "Local shell-command execution",
    owner: "server",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "owner-dependent",
    kill: "unsupported",
    source: {
      file: "packages/claxedo-local-server/src/shell/git.ts",
      callee: "execFileAsync",
      calls: 1,
    },
  }),
  product({
    id: "server-runtime-git-auth",
    family: "Workspace runtime Git credential configuration",
    owner: "server",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "owner-dependent",
    kill: "unsupported",
    source: {
      file: "packages/claxedo-server/src/hosts/workspace-runtime/git-auth.ts",
      callee: "run",
      calls: 2,
    },
  }),
  product({
    id: "runtime-git",
    family: "Workspace runtime Git",
    owner: "workspace",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "owner-dependent",
    kill: "unsupported",
    source: { file: "packages/workspace-runtime/src/git.ts", callee: "execFile", calls: 1 },
  }),
  product({
    id: "terminal-pty",
    family: "Terminal PTY",
    classification: "registered-root",
    owner: "terminal",
    linkage: "workspace",
    observation: "host-tree",
    stop: "supported",
    kill: "owner-dependent",
    source: { file: "packages/workspace-runtime/src/pty/index.ts", callee: "ptySpawn", calls: 1 },
  }),
  product({
    id: "managed-process-port-probe",
    family: "Managed-process port probe",
    owner: "managed-process",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: {
      file: "packages/workspace-runtime/src/managed-processes/port-picker.ts",
      callee: "execSync",
      calls: 1,
    },
  }),
  product({
    id: "managed-process-probes",
    family: "Managed-process identity probes",
    owner: "managed-process",
    linkage: "workspace",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/workspace-runtime/src/managed-processes/manager.ts", callee: "execSync", calls: 3 },
  }),
  product({
    id: "acp-cli",
    family: "ACP harness CLI",
    classification: "registered-root",
    owner: "harness",
    linkage: "harness",
    observation: "host-tree",
    stop: "supported",
    kill: "owner-dependent",
    source: { file: "packages/agent-sdk-runtime/src/harnesses/acp/transport.ts", callee: "spawn", calls: 1 },
  }),
  product({
    id: "codex-app-server",
    family: "Codex app-server CLI",
    classification: "registered-root",
    owner: "harness",
    linkage: "harness",
    observation: "host-tree",
    stop: "supported",
    kill: "owner-dependent",
  }),
  product({
    id: "opencode-embedded",
    family: "Embedded OpenCode SDK",
    classification: "in-process",
    owner: "opencode-runtime",
    linkage: "session",
    observation: "none",
    stop: "supported",
    kill: "unsupported",
  }),
  product({
    id: "claude-sdk-cli",
    family: "Claude SDK-owned CLI",
    classification: "registered-root",
    owner: "harness",
    linkage: "harness",
    observation: "host-tree",
    stop: "owner-dependent",
    kill: "unsupported",
    source: { file: "packages/agent-sdk-runtime/src/harnesses/claude/driver.ts", callee: "sdkQuery", calls: 3 },
  }),
  product({
    id: "cursor-sdk-cli",
    family: "Cursor SDK-owned CLI",
    classification: "registered-root",
    owner: "harness",
    linkage: "harness",
    observation: "host-tree",
    stop: "owner-dependent",
    kill: "unsupported",
    source: { file: "packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts", callee: "agentSpawn", calls: 4 },
  }),
  product({
    id: "pi-version-probe",
    family: "Pi executable version probe",
    owner: "harness",
    linkage: "harness",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    // The cached --version check has a 10s timeout, but exposes no process
    // observer or owner action. Its parent supplies descendant ownership.
    source: { file: "packages/agent-sdk-runtime/src/harnesses/pi/executable.ts", callee: "execFile", calls: 1 },
  }),
  product({
    id: "pi-rpc",
    family: "Pi native RPC",
    classification: "registered-root",
    owner: "harness",
    linkage: "session",
    observation: "host-tree",
    stop: "supported",
    kill: "owner-dependent",
  }),
  product({
    id: "pi-goal-evaluator",
    family: "Pi goal evaluator",
    classification: "registered-root",
    owner: "harness",
    linkage: "session",
    observation: "host-tree",
    stop: "supported",
    kill: "owner-dependent",
    source: { file: "packages/agent-sdk-runtime/src/harnesses/pi/driver.ts", callee: "execFile", calls: 1 },
  }),
  product({
    id: "harness-windows-tree-kill",
    family: "Windows harness tree-kill (taskkill)",
    owner: "harness",
    linkage: "harness",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: {
      file: "packages/agent-sdk-runtime/src/launch/retirement.ts",
      callee: "spawn",
      calls: 1,
    },
  }),
  product({
    id: "harness-launch-gate",
    family: "Harness launch gate",
    classification: "registered-root",
    owner: "harness",
    linkage: "session",
    observation: "host-tree",
    stop: "supported",
    kill: "supported",
    source: { file: "packages/agent-sdk-runtime/src/launch/launch-gate.ts", callee: "spawn", calls: 1 },
  }),
  product({
    id: "harness-launch-payload",
    family: "Harness payload inside its launch gate's group",
    owner: "harness",
    linkage: "session",
    observation: "host-tree",
    stop: "supported",
    kill: "supported",
    source: { file: "packages/agent-sdk-runtime/src/launch/launch-gate-child.ts", callee: "spawn", calls: 1 },
  }),
  product({
    id: "launch-creation-identity-probe",
    family: "Launch creation-identity probes (ps, sysctl, PowerShell)",
    owner: "harness",
    linkage: "harness",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/agent-sdk-runtime/src/launch/identity.ts", callee: "execFileAsync", calls: 4 },
  }),
  product({
    id: "launch-descendant-sweep-probe",
    family: "Launch descendant-sweep probes (ps)",
    owner: "harness",
    linkage: "harness",
    observation: "lifecycle-only",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/agent-sdk-runtime/src/launch/descendants.ts", callee: "execFileAsync", calls: 2 },
  }),
  {
    id: "pinned-pi-install",
    family: "Pi version pin installer",
    classification: "non-production",
    owner: "harness",
    linkage: "none",
    observation: "none",
    stop: "unsupported",
    kill: "unsupported",
    source: { file: "packages/agent-sdk-runtime/src/test-utils/pinned-pi.ts", callee: "spawnSync", calls: 1 },
  },
  {
    id: "first-party-mcp-fixture-git",
    family: "Live first-party MCP fixture repository setup",
    classification: "non-production",
    owner: "server",
    linkage: "none",
    observation: "none",
    stop: "unsupported",
    kill: "unsupported",
    source: {
      file: "packages/claxedo-local-server/src/app/test-support/first-party-mcp-live.ts",
      callee: "execFileSync",
      calls: 1,
    },
  },
  {
    id: "stdio-mcp",
    family: "Configured stdio MCP",
    classification: "registered-descendant",
    owner: "harness",
    linkage: "harness",
    observation: "host-tree",
    stop: "owner-dependent",
    kill: "owner-dependent",
  },
  {
    id: "remote-mcp",
    family: "Remote HTTP/SSE MCP",
    classification: "remote-excluded",
    owner: "remote",
    linkage: "harness",
    observation: "none",
    stop: "unsupported",
    kill: "unsupported",
  },
  {
    id: "remote-runtime",
    family: "Cloud and externally hosted runtime",
    classification: "remote-excluded",
    owner: "remote",
    linkage: "none",
    observation: "none",
    stop: "unsupported",
    kill: "unsupported",
  },
] as const

export function harnessInventory(
  definitions: readonly { key: string; id: string; access: "native" | "acp" }[],
) {
  return definitions.flatMap((definition) => {
    const process =
      definition.access === "acp"
        ? "acp-cli"
        : definition.id === "codex"
          ? "codex-app-server"
          : definition.id === "opencode"
            ? "opencode-embedded"
            : definition.id === "claude"
              ? "claude-sdk-cli"
              : definition.id === "cursor"
                ? "cursor-sdk-cli"
                : "pi-rpc"
    return [
      { key: definition.key, role: "harness", process },
      { key: definition.key, role: "probe", process },
      { key: definition.key, role: "stdio-mcp", process: "stdio-mcp" },
      { key: definition.key, role: "remote-mcp", process: "remote-mcp" },
    ] as const
  })
}
