import contract from "../targets/terminal-output-v1.json"

export type TerminalWorkloadContract = typeof contract

export function terminalWorkloadContract(): TerminalWorkloadContract {
  if (
    contract.schemaVersion !== 1 ||
    contract.id !== "terminal-output-v1" ||
    contract.hashAlgorithm !== "sha256-chunk-tree-v1" ||
    contract.activeDurationMs < 10_000 ||
    contract.offeredMiBS < 20 ||
    !/^[0-9a-f]{64}$/u.test(contract.expectedWireSha256) ||
    !/^[0-9a-f]{64}$/u.test(contract.expectedModelSha256)
  ) {
    throw new Error("terminal workload contract is invalid")
  }
  return contract
}
