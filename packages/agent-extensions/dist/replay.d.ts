export type RuntimeAgentExtensions = {
    version: 1;
    installs: Array<{
        desired: Record<string, unknown>;
        lock?: Record<string, unknown>;
        status?: string;
        components?: Array<Record<string, unknown>>;
    }>;
};
type ExecFile = (file: string, args: string[], options?: {
    cwd?: string;
}) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type ReplayOptions = {
    execFile?: ExecFile;
    tempRoot?: string;
    homeDir?: string;
    stateRoot?: string;
    packageRoots?: Record<string, string>;
    now?: number | (() => number);
};
export declare function applyRuntimeAgentExtensions(input: RuntimeAgentExtensions | undefined, projectDir?: string, options?: ReplayOptions): Promise<void>;
export {};
