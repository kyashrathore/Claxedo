/** Scripted native wire peer shared by package integration tests. */
export declare function installFakePiRpc(): Promise<{
  directory: string
  binary: string
  agentDir: string
  dispose(): Promise<void>
}>
