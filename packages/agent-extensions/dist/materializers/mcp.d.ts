import type { MaterializedAgentExtensionScope, HarnessTarget } from "../types";
import { type MaterializedRuntimeRecord } from "../materialization";
export type StdioMcpServerConfig = {
    command: string;
    args?: string[];
    env?: Record<string, string>;
};
export type RemoteMcpServerConfig = {
    url: string;
    headers?: Record<string, string>;
};
export type StandaloneMcpServerConfig = StdioMcpServerConfig | RemoteMcpServerConfig;
export type StandaloneMcpConfig = {
    servers: Record<string, StandaloneMcpServerConfig>;
};
export declare function normalizeStandaloneMcpConfig(input: Record<string, unknown>): StandaloneMcpConfig;
export declare function mcpTargetPath(input: {
    runner: HarnessTarget;
    scope: MaterializedAgentExtensionScope;
    projectDir?: string;
    homeDir?: string;
}): string | undefined;
export declare function removeStandaloneMcpEntries(input: {
    file: string;
    names: string[];
}): Promise<void>;
export declare function materializeStandaloneMcp(input: {
    config: StandaloneMcpConfig;
    runner: HarnessTarget;
    scope: MaterializedAgentExtensionScope;
    ownerId: string;
    projectDir?: string;
    homeDir?: string;
    record?: MaterializedRuntimeRecord;
    replaceOwned?: boolean;
}): Promise<{
    path: string;
    reason?: string | undefined;
    runner: "opencode" | "claude" | "codex" | "cursor";
    component: string;
    type: "mcp";
    status: "applied" | "drifted" | "skipped";
}[] | {
    runner: "opencode" | "claude" | "codex" | "cursor";
    component: string;
    type: "mcp";
    status: "skipped";
    reason: string;
}[]>;
