import { EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS } from "../src/contracts"
import type { ExecutionCapabilitiesPort } from "../src/ports"

export const testExecutionCapabilities: ExecutionCapabilitiesPort = {
  read: async (context) => {
    const observedAt = Date.now()
    return {
    schemaVersion: 1,
    organizationId: context.organizationId,
    ownerUserId: context.ownerUserId,
    catalogRevision: "f".repeat(64),
    observedAt,
    expiresAt: observedAt + EXECUTION_CAPABILITY_CATALOG_MAX_AGE_MS,
    environments: [{
      kind: "local_worktree",
      repositoryRequired: true,
      remoteUrlInput: false,
      baseRevisionInput: true,
    }],
    harnesses: [{ id: "claxedo-v2" }],
    agents: [{ harnessId: "claxedo-v2", id: "build", label: "Build", mode: "primary" }],
    models: [
      { harnessId: "claxedo-v2", providerId: "openai", modelId: "gpt-5", label: "GPT-5", efforts: ["low", "medium", "high", "maximum"] },
      { harnessId: "claxedo-v2", providerId: "openai", modelId: "gpt-5.1", label: "GPT-5.1", efforts: ["low", "medium", "high", "maximum"] },
    ],
    tools: [
      { harnessId: "claxedo-v2", id: "read" },
      { harnessId: "claxedo-v2", id: "terminal" },
      { harnessId: "claxedo-v2", id: "edit" },
      { harnessId: "claxedo-v2", id: "bash" },
    ],
    repository: { baseRevisions: ["HEAD", "main"] },
    connections: [],
    }
  },
}
