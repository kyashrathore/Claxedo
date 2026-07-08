import type { HarnessTarget } from "./types";
export type { HarnessTarget } from "./types";
export type NativePluginManifest = {
    runner: HarnessTarget;
    path: string;
    manifest: Record<string, unknown>;
};
export type AgentExtensionPackage = {
    type: "marketplace";
    runner: HarnessTarget;
    manifest_path: string;
    manifest: Record<string, unknown>;
    entries: CatalogPackageEntry[];
} | {
    type: "native-plugin";
    name: string;
    manifests: NativePluginManifest[];
} | {
    type: "standalone-skill";
    name: string;
    skill_path: "SKILL.md";
} | {
    type: "standalone-mcp";
    name: string;
    config_path: string;
    config: Record<string, unknown>;
};
export type CatalogPackageEntry = {
    name: string;
    path: string;
};
export declare class AgentExtensionManifestError extends Error {
    constructor(message: string);
}
export declare function discoverAgentExtensionPackage(root: string): Promise<AgentExtensionPackage>;
