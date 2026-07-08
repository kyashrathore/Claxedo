import type { PackageInstallSource } from "./source";
import type { HarnessTarget } from "./manifest";
export type AgentExtensionScope = "project" | "workspace" | "machine";
export type MaterializedAgentExtensionScope = Exclude<AgentExtensionScope, "workspace">;
export type DesiredExtensionInstall = {
    id: string;
    package_name: string;
    source: PackageInstallSource;
    scope: AgentExtensionScope;
    enabled: boolean;
    targets: HarnessTarget[];
    installed_at: number;
    updated_at: number;
};
export type DesiredExtensionState = {
    version: 1;
    installs: DesiredExtensionInstall[];
};
export declare class AgentExtensionStateError extends Error {
    constructor(message: string);
}
export declare function agentExtensionStateRoot(input: {
    scope: AgentExtensionScope;
    projectDir?: string;
    workspaceId?: string;
    dataRoot?: string;
}): string;
export declare function installedStatePath(input: {
    scope: AgentExtensionScope;
    projectDir?: string;
    workspaceId?: string;
    dataRoot?: string;
}): string;
export declare function encodeDesiredState(input: DesiredExtensionState): string;
export declare function readDesiredExtensionState(file: string): Promise<DesiredExtensionState>;
export declare function writeDesiredExtensionState(file: string, state: DesiredExtensionState): Promise<void>;
export declare function upsertDesiredExtensionInstall(file: string, install: DesiredExtensionInstall): Promise<void>;
export declare function removeDesiredExtensionInstall(file: string, id: string): Promise<void>;
export declare function setDesiredExtensionEnabled(file: string, id: string, enabled: boolean, updatedAt?: number): Promise<void>;
