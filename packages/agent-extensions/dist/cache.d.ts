export declare class AgentExtensionCacheError extends Error {
    constructor(message: string);
}
export declare function agentExtensionCacheRoot(input: {
    dataRoot: string;
}): string;
export declare function agentExtensionStateCacheRoot(input: {
    stateRoot: string;
}): string;
export declare function cachePackageRoot(input: {
    resolvedSha: string;
    packagePath?: string;
    dataRoot: string;
}): string;
export declare function digestDirectory(root: string): Promise<string>;
export declare function copyPackageToCache(input: {
    sourceRoot: string;
    resolvedSha: string;
    packagePath?: string;
    dataRoot: string;
}): Promise<{
    path: string;
    checksum: string;
}>;
