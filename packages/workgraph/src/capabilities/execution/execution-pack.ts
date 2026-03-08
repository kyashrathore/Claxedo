import type {
  CapabilityPack,
  NodeHandler,
  NodeExecutionContext,
  NodeExecutionResult,
} from "../../orchestrator/core/capabilities";

const implementationHandler: NodeHandler = {
  kind: "team_task",
  async execute(
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    return {
      status: "completed",
      outputs: {
        implementation: `Implementation completed for node ${context.nodeId}`,
        artifacts: [],
      },
      evidence: [
        {
          type: "artifact",
          description: `Implementation artifacts for ${context.kind}`,
          nodeId: context.nodeId,
        },
      ],
    };
  },
};

const synthesisHandler: NodeHandler = {
  kind: "synthesis_task",
  async execute(
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    const inputKeys = Object.keys(context.inputs);
    const consolidated: Record<string, any> = {};
    const evidenceLinks: NodeExecutionResult["evidence"] = [];

    for (const key of inputKeys) {
      consolidated[key] = context.inputs[key];
      evidenceLinks.push({
        type: "artifact",
        description: `Synthesized from input "${key}"`,
        nodeId: context.nodeId,
      });
    }

    return {
      status: "completed",
      outputs: {
        synthesis: `Synthesized ${inputKeys.length} input(s) for node ${context.nodeId}`,
        consolidated,
      },
      evidence: evidenceLinks,
    };
  },
};

export const executionPack: CapabilityPack = {
  id: "execution",
  name: "Execution Capability",
  description: "Code implementation, review, and synthesis",
  roles: [
    {
      id: "implementer",
      name: "Implementer",
      description: "Writes and modifies code",
      skills: ["code_writing", "refactoring", "debugging"],
    },
    {
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews code for quality and correctness",
      skills: ["code_review", "testing", "quality_assurance"],
    },
  ],
  nodeHandlers: new Map([
    ["team_task", implementationHandler],
    ["synthesis_task", synthesisHandler],
  ]),
};
