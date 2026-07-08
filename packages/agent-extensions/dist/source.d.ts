export type GitHubPackageSource = {
    type: "github";
    owner: string;
    repo: string;
    ref?: string;
    package_path?: string;
};
export type ProjectPackageSource = {
    type: "project";
    package_path: string;
};
export type PackageInstallSource = GitHubPackageSource | ProjectPackageSource;
export declare class AgentExtensionSourceError extends Error {
    constructor(message: string);
}
export declare function safeRelativePath(input: string, label?: string): string;
export declare function parsePackageSource(input: string): PackageInstallSource;
export declare function sameSource(left: PackageInstallSource, right: PackageInstallSource): boolean;
