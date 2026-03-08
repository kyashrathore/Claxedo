import type {
  CapabilityPack,
  NodeHandler,
  NodeExecutionContext,
  NodeExecutionResult,
} from "../../orchestrator/core/capabilities";

const uxHandler: NodeHandler = {
  kind: "agent_task",
  async execute(
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    return {
      status: "completed",
      outputs: {
        design: `UX design completed for node ${context.nodeId}`,
        wireframes: [],
        guidelines: [],
      },
      evidence: [
        {
          type: "artifact",
          description: `UX design artifacts for ${context.kind}`,
          nodeId: context.nodeId,
        },
      ],
    };
  },
};

export const uxPack: CapabilityPack = {
  id: "ux",
  name: "UX Capability",
  description: "UI/UX design, wireframing, and prototyping",
  roles: [
    {
      id: "designer",
      name: "Designer",
      description: "Creates UI/UX designs and guidelines",
      skills: ["ui_design", "ux_research", "accessibility"],
    },
    {
      id: "prototyper",
      name: "Prototyper",
      description: "Builds wireframes and interactive prototypes",
      skills: ["wireframing", "prototyping", "user_testing"],
    },
  ],
  nodeHandlers: new Map([["agent_task", uxHandler]]),
};
