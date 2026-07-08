import type { HarnessTarget } from "./manifest";
import type { PackageInstallSource } from "./source";
export type ExtensionLock = {
    version: 1;
    packages: Record<string, LockedExtensionPackage>;
};
export type LockedExtensionPackage = {
    source: PackageInstallSource;
    resolved_sha: string;
    package_path?: string;
    manifest_digests: Record<string, string>;
    component_digests: Record<string, string>;
    targets: HarnessTarget[];
};
export declare function lockStatePath(root: string): string;
export declare function sortedLock(input: ExtensionLock): ExtensionLock;
export declare function encodeLock(input: ExtensionLock): string;
export declare function readExtensionLock(file: string): Promise<ExtensionLock>;
export declare function writeExtensionLock(file: string, lock: ExtensionLock): Promise<void>;
