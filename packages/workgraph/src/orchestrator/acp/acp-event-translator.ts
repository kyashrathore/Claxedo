/**
 * ACP Event Translator — converts ACP sessionUpdate notifications into
 * OpenCode-compatible events (message.part.updated, etc.)
 *
 * Port of sandbox-agent's opencode-adapter translate_session_update()
 * (Rust, lines 3905-4123).
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranslatedEvent {
  type: "message.part.updated" | "message.updated" | "session.status";
  properties: Record<string, unknown>;
}

export type EventSink = (event: TranslatedEvent) => void;

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

export class AcpEventTranslator {
  /** Per-turn part counter (increments for each new part) */
  partCounter = 0;
  /** Accumulated text for the current text part */
  textAccum = "";
  /** ID of the current in-flight text part (null when no text part is open) */
  textPartId: string | null = null;
  /** Full accumulated output text (all text chunks across the turn) */
  outputText = "";
  /** Collected tool outputs for reference */
  toolOutputs: string[] = [];

  constructor(
    private sessionId: string,
    private messageId: string,
    private sink: EventSink,
  ) {}

  /**
   * The sessionUpdate handler — pass to AcpHttpClient or ClientSideConnection.
   */
  handleSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    const kind = update.sessionUpdate;

    switch (kind) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        this.handleTextChunk(update);
        break;
      case "tool_call":
        this.handleToolCall(update);
        break;
      case "tool_call_update":
        this.handleToolCallUpdate(update);
        break;
      default:
        // plan, usage_update, etc. — ignored
        break;
    }
  }

  /** Get accumulated output for TaskHandle.await() result */
  getOutput(): string {
    return this.outputText;
  }

  // -----------------------------------------------------------------------
  // Text / thought chunks
  // -----------------------------------------------------------------------

  private handleTextChunk(update: { content: any }): void {
    const content = update.content;
    if (!content || content.type !== "text" || !content.text) return;

    const chunk = content.text as string;
    this.textAccum += chunk;
    this.outputText += chunk;

    // Reuse the same part ID for all chunks in a text stream
    if (!this.textPartId) {
      this.textPartId = `part_${this.messageId}_${this.partCounter}`;
      this.partCounter++;
    }

    const part = {
      id: this.textPartId,
      sessionID: this.sessionId,
      messageID: this.messageId,
      type: "text",
      text: this.textAccum,
    };

    this.sink({
      type: "message.part.updated",
      properties: {
        sessionID: this.sessionId,
        messageID: this.messageId,
        part,
        delta: chunk,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Tool call initiation
  // -----------------------------------------------------------------------

  private handleToolCall(update: {
    toolCallId: string;
    title: string;
    rawInput?: unknown;
  }): void {
    // Finalize any accumulated text before switching to tool
    this.finalizeTextPart();

    const callId = update.toolCallId ?? "unknown";
    const toolTitle = update.title ?? "unknown";
    const partId = `part_${this.messageId}_${this.partCounter}`;
    this.partCounter++;

    const now = Date.now();
    const part = {
      id: partId,
      sessionID: this.sessionId,
      messageID: this.messageId,
      type: "tool",
      callID: callId,
      tool: toolTitle,
      state: {
        status: "running",
        input: update.rawInput ?? {},
        title: toolTitle,
        metadata: {},
        time: { start: now },
      },
    };

    this.sink({
      type: "message.part.updated",
      properties: {
        sessionID: this.sessionId,
        messageID: this.messageId,
        part,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Tool call status update
  // -----------------------------------------------------------------------

  private handleToolCallUpdate(update: {
    toolCallId: string;
    status?: string | null;
    content?: Array<{ type?: string; text?: string }> | null;
  }): void {
    const callId = update.toolCallId ?? "unknown";
    const status = update.status ?? "completed";

    // Extract text output from content blocks
    let output = "";
    if (update.content && Array.isArray(update.content)) {
      output =
        update.content
          .filter((c: any) => c.text)
          .map((c: any) => c.text as string)
          .join("\n") || "";
    }

    if (output) {
      this.toolOutputs.push(output);
    }

    const now = Date.now();
    const part = {
      id: `part_tc_${callId}`,
      sessionID: this.sessionId,
      messageID: this.messageId,
      type: "tool",
      callID: callId,
      state: {
        status,
        output,
        time: { end: now },
      },
    };

    this.sink({
      type: "message.part.updated",
      properties: {
        sessionID: this.sessionId,
        messageID: this.messageId,
        part,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Finalize the current text part — clears accumulator so next text starts
   * a new part. Called when transitioning from text to tool.
   */
  private finalizeTextPart(): void {
    if (this.textPartId) {
      this.textPartId = null;
      this.textAccum = "";
    }
  }
}
