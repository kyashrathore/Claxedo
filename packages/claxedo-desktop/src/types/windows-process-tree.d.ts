declare module "@vscode/windows-process-tree" {
  export const ProcessDataFlag: import("../main/diagnostics/process-metrics-worker").WindowsAncestryAddon["ProcessDataFlag"]
  export const getAllProcesses: import("../main/diagnostics/process-metrics-worker").WindowsAncestryAddon["getAllProcesses"]
}
