export interface CapabilityPack {
  id: string;
  name: string;
  description: string;
  roles: RoleDefinition[];
  nodeHandlers: Map<string, NodeHandler>;
}

export interface RoleDefinition {
  id: string;
  name: string;
  description: string;
  skills: string[];
}

export interface NodeHandler {
  kind: string;
  execute(context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export interface NodeExecutionContext {
  nodeId: string;
  runId: string;
  teamId: string;
  kind: string;
  inputs: Record<string, any>;
  scratchpad: Record<string, any>;
}

export interface NodeExecutionResult {
  status: "completed" | "failed" | "needs_review";
  outputs: Record<string, any>;
  evidence: EvidenceLink[];
  scratchpadUpdates?: Record<string, any>;
}

export interface EvidenceLink {
  type: "source_code" | "document" | "decision" | "artifact" | "external";
  url?: string;
  description: string;
  nodeId?: string;
  artifactId?: string;
}

export class CapabilityRegistry {
  private packs: Map<string, CapabilityPack> = new Map();

  register(pack: CapabilityPack): void {
    this.packs.set(pack.id, pack);
  }

  unregister(packId: string): void {
    this.packs.delete(packId);
  }

  get(packId: string): CapabilityPack | undefined {
    return this.packs.get(packId);
  }

  getAll(): CapabilityPack[] {
    return Array.from(this.packs.values());
  }

  findHandlerForKind(kind: string): NodeHandler | undefined {
    for (const pack of this.packs.values()) {
      const handler = pack.nodeHandlers.get(kind);
      if (handler) return handler;
    }
    return undefined;
  }

  getAllRoles(): RoleDefinition[] {
    const roles: RoleDefinition[] = [];
    for (const pack of this.packs.values()) {
      roles.push(...pack.roles);
    }
    return roles;
  }
}
