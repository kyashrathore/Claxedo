import type { PluginWorkbench } from "@claxedo/plugin-api"

export class WorkbenchGapError extends Error {
  constructor(member: string) {
    super(`The workbench does not provide ${member} yet`)
    this.name = "WorkbenchGapError"
  }
}

export function createWorkbenchBinding(): PluginWorkbench {
  return {
    tabs: () => [],
    activate: () => {
      throw new WorkbenchGapError("activate()")
    },
    close: () => {
      throw new WorkbenchGapError("close()")
    },
    move: () => {
      throw new WorkbenchGapError("move()")
    },
    open: () => {
      throw new WorkbenchGapError("open()")
    },
  }
}
