import type { GitHubPackageSource, PackageInstallSource } from "./source";
export type ExecFile = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export declare class AgentExtensionFetchError extends Error {
    constructor(message: string);
}
export declare function githubRepoUrl(source: GitHubPackageSource): string;
export declare function resolveGitHubSource(source: PackageInstallSource, execFile?: ExecFile): Promise<string>;
export declare function fetchGitHubPackageToCache(input: {
    source: PackageInstallSource;
    resolvedSha?: string;
    dataRoot: string;
    execFile?: ExecFile;
    tempRoot?: string;
}): Promise<{
    resolvedSha: string;
    path: string;
    checksum: string;
}>;
