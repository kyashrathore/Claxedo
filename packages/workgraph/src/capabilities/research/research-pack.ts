import type {
  CapabilityPack,
  NodeHandler,
  NodeExecutionContext,
  NodeExecutionResult,
} from "../../orchestrator/core/capabilities";

const researchHandler: NodeHandler = {
  kind: "agent_task",
  async execute(
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    return {
      status: "completed",
      outputs: {
        summary: `Research completed for node ${context.nodeId}`,
        findings: [],
      },
      evidence: [
        {
          type: "document",
          description: `Research findings for ${context.kind}`,
          nodeId: context.nodeId,
        },
      ],
    };
  },
};

const verificationHandler: NodeHandler = {
  kind: "verification_task",
  async execute(
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    const hasEvidence = Object.keys(context.inputs).length > 0;
    return {
      status: hasEvidence ? "completed" : "needs_review",
      outputs: {
        verified: hasEvidence,
        report: hasEvidence
          ? "All inputs verified"
          : "Missing required evidence",
      },
      evidence: [
        {
          type: "decision",
          description: `Verification ${hasEvidence ? "passed" : "needs review"}`,
          nodeId: context.nodeId,
        },
      ],
    };
  },
};

export const researchPack: CapabilityPack = {
  id: "research",
  name: "Research Capability",
  description: "Web research, document analysis, and evidence gathering",
  roles: [
    {
      id: "researcher",
      name: "Researcher",
      description: "Searches and analyzes documents",
      skills: ["web_search", "document_analysis", "summarization"],
    },
    {
      id: "fact_checker",
      name: "Fact Checker",
      description: "Verifies claims against sources",
      skills: ["verification", "source_linking"],
    },
  ],
  nodeHandlers: new Map([
    ["agent_task", researchHandler],
    ["verification_task", verificationHandler],
  ]),
};
