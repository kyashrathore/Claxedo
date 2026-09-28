export declare const MCP_PROOF_TOOL: string
export declare function startMcpProofEndpoint(): {
  baseURL: string
  offered: string[]
  called: string[]
  firstPartyMcp: { server: (sessionId: string) => { name: string; url: string; headers: Record<string, string> } }
  stop: () => void
}
