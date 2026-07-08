import { type AgentExtensionScope, type MaterializedAgentExtensionScope } from "./state";
export type AgentExtensionFiles = ReturnType<typeof agentExtensionFiles>;
export declare function agentExtensionFiles(input: {
    scope: AgentExtensionScope;
    projectDir?: string;
    workspaceId?: string;
    dataRoot?: string;
}): {
    root: string;
    installed: string;
    lock: string;
    materialized: string;
};
export declare function materializedAgentExtensionFiles(input: {
    scope: MaterializedAgentExtensionScope;
    projectDir?: string;
    dataRoot?: string;
}): {
    root: string;
    installed: string;
    lock: string;
    materialized: string;
};
export declare function workspaceAgentExtensionFiles(input: {
    workspaceId: string;
    dataRoot?: string;
}): {
    root: string;
    installed: string;
    lock: string;
    materialized: string;
};
