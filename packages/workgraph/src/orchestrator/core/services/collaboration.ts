export type MessageType =
  | "ask"
  | "answer"
  | "propose"
  | "challenge"
  | "blocker";

export interface TypedMessage {
  id: string;
  runId: string;
  teamId: string;
  senderId: string;
  type: MessageType;
  content: string;
  replyTo?: string;
  createdAt: string;
}

export type HandoffStatus = "pending" | "accepted" | "rejected";

export interface Handoff {
  id: string;
  runId: string;
  fromTeamId: string;
  toTeamId: string;
  status: HandoffStatus;
  payload: string;
  createdAt: string;
  resolvedAt?: string;
}

export class CollaborationService {
  private messages: TypedMessage[] = [];
  private handoffs: Map<string, Handoff> = new Map();

  postMessage(msg: Omit<TypedMessage, "createdAt">): TypedMessage {
    const full: TypedMessage = { ...msg, createdAt: new Date().toISOString() };
    this.messages.push(full);
    return full;
  }

  getMessages(runId: string, teamId?: string): TypedMessage[] {
    return this.messages.filter(
      (m) => m.runId === runId && (!teamId || m.teamId === teamId)
    );
  }

  getMessagesByType(runId: string, type: MessageType): TypedMessage[] {
    return this.messages.filter(
      (m) => m.runId === runId && m.type === type
    );
  }

  requestHandoff(
    handoff: Omit<Handoff, "status" | "createdAt">
  ): Handoff {
    const full: Handoff = {
      ...handoff,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.handoffs.set(handoff.id, full);
    return full;
  }

  acceptHandoff(handoffId: string): Handoff | null {
    const h = this.handoffs.get(handoffId);
    if (!h || h.status !== "pending") return null;
    h.status = "accepted";
    h.resolvedAt = new Date().toISOString();
    return h;
  }

  rejectHandoff(handoffId: string): Handoff | null {
    const h = this.handoffs.get(handoffId);
    if (!h || h.status !== "pending") return null;
    h.status = "rejected";
    h.resolvedAt = new Date().toISOString();
    return h;
  }

  getHandoff(handoffId: string): Handoff | undefined {
    return this.handoffs.get(handoffId);
  }

  getHandoffs(runId: string): Handoff[] {
    return Array.from(this.handoffs.values()).filter(
      (h) => h.runId === runId
    );
  }
}
