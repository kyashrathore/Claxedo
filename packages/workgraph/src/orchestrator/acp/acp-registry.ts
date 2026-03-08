/**
 * ACP Agent Registry — config loading and task-kind routing.
 *
 * Each entry maps task kinds to a specific ACP agent loop (claude, codex,
 * opencode, amp, etc.) running on an ACP server or as a stdio subprocess.
 *
 * Config is loaded from ACP_REGISTRY_CONFIG env var (inline JSON) or
 * ACP_REGISTRY_PATH (path to a JSON file).
 */

import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface StdioTransportConfig {
  mode: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpTransportConfig {
  mode: "http";
  /** ACP server base URL (e.g. "http://localhost:9090") */
  baseUrl: string;
  /** ACP agent loop to use — "claude", "codex", "opencode", "amp", etc. */
  agent: string;
  /** Auth token for the ACP server */
  token?: string;
  /** Custom path for the ACP RPC endpoint (default: /v1/rpc) */
  path?: string;
}

export type AcpTransportConfig = StdioTransportConfig | HttpTransportConfig;

export interface AcpAgentEntry {
  /** Unique ID for this registry entry */
  id: string;
  /** Human-readable name */
  name: string;
  /** Transport configuration (how to connect + which agent loop) */
  transport: AcpTransportConfig;
  /** Which orchestrator task kinds this entry handles */
  taskKinds: string[];
}

export interface AcpRegistryConfig {
  entries: AcpAgentEntry[];
  defaultEntryId?: string;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load the ACP registry from environment.
 * Returns null if no config is set.
 */
export function loadRegistry(): AcpRegistryConfig | null {
  const inline = process.env.ACP_REGISTRY_CONFIG;
  if (inline) {
    try {
      return JSON.parse(inline) as AcpRegistryConfig;
    } catch (err) {
      console.error("[acp-registry] Failed to parse ACP_REGISTRY_CONFIG:", err);
      return null;
    }
  }

  const filePath = process.env.ACP_REGISTRY_PATH;
  if (filePath) {
    try {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content) as AcpRegistryConfig;
    } catch (err) {
      console.error(`[acp-registry] Failed to read ${filePath}:`, err);
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Resolve the best registry entry for a given task kind.
 * Falls back to the default entry if no match is found.
 */
export function resolveEntry(
  registry: AcpRegistryConfig,
  taskKind: string,
): AcpAgentEntry | undefined {
  const match = registry.entries.find((e) => e.taskKinds.includes(taskKind));
  if (match) return match;

  if (registry.defaultEntryId) {
    return registry.entries.find((e) => e.id === registry.defaultEntryId);
  }

  return undefined;
}
