import { describe, it, expect, beforeEach } from "bun:test";
import { AcpEventTranslator } from "../src/orchestrator/acp/acp-event-translator";
import type { TranslatedEvent } from "../src/orchestrator/acp/acp-event-translator";
import type { SessionNotification } from "@agentclientprotocol/sdk";

function makeNotification(update: Record<string, unknown>): SessionNotification {
  return {
    sessionId: "sess_1",
    update: update as any,
  };
}

describe("AcpEventTranslator", () => {
  let events: TranslatedEvent[];
  let translator: AcpEventTranslator;

  beforeEach(() => {
    events = [];
    translator = new AcpEventTranslator("sess_1", "msg_1", (e) => events.push(e));
  });

  // -----------------------------------------------------------------------
  // Text accumulation
  // -----------------------------------------------------------------------

  describe("text chunks", () => {
    it("should emit message.part.updated for agent_message_chunk", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello" },
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message.part.updated");
      expect((events[0].properties.part as any).type).toBe("text");
      expect((events[0].properties.part as any).text).toBe("Hello");
      expect(events[0].properties.delta).toBe("Hello");
    });

    it("should accumulate text across multiple chunks", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        }),
      );
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "world" },
        }),
      );

      expect(events).toHaveLength(2);
      // Both events should share the same part ID
      expect((events[0].properties.part as any).id).toBe(
        (events[1].properties.part as any).id,
      );
      // Second event has full accumulated text
      expect((events[1].properties.part as any).text).toBe("Hello world");
      expect(events[1].properties.delta).toBe("world");
    });

    it("should handle agent_thought_chunk the same as agent_message_chunk", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking..." },
        }),
      );

      expect(events).toHaveLength(1);
      expect((events[0].properties.part as any).type).toBe("text");
      expect((events[0].properties.part as any).text).toBe("thinking...");
    });

    it("should ignore non-text content blocks", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "base64..." },
        }),
      );

      expect(events).toHaveLength(0);
    });

    it("should ignore empty text", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "" },
        }),
      );

      expect(events).toHaveLength(0);
    });

    it("should track output text for getOutput()", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "result text" },
        }),
      );

      expect(translator.getOutput()).toBe("result text");
    });
  });

  // -----------------------------------------------------------------------
  // Tool call lifecycle
  // -----------------------------------------------------------------------

  describe("tool calls", () => {
    it("should emit tool part with running status", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call",
          toolCallId: "tc_1",
          title: "read_file",
          rawInput: { path: "/foo" },
        }),
      );

      expect(events).toHaveLength(1);
      const part = events[0].properties.part as any;
      expect(part.type).toBe("tool");
      expect(part.callID).toBe("tc_1");
      expect(part.tool).toBe("read_file");
      expect(part.state.status).toBe("running");
      expect(part.state.input).toEqual({ path: "/foo" });
      expect(part.state.time.start).toBeGreaterThan(0);
    });

    it("should finalize text part before tool call", () => {
      // Emit text first
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Let me read" },
        }),
      );

      const textPartId = (events[0].properties.part as any).id;

      // Now a tool call
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call",
          toolCallId: "tc_1",
          title: "read_file",
        }),
      );

      // Tool part should have a different ID
      const toolPartId = (events[1].properties.part as any).id;
      expect(toolPartId).not.toBe(textPartId);
    });

    it("should start new text part after tool call", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "before" },
        }),
      );
      const firstTextPartId = (events[0].properties.part as any).id;

      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call",
          toolCallId: "tc_1",
          title: "read_file",
        }),
      );

      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "after" },
        }),
      );
      const secondTextPartId = (events[2].properties.part as any).id;

      // New text part should have a different ID
      expect(secondTextPartId).not.toBe(firstTextPartId);
      // And the text should be "after" (not "beforeafter")
      expect((events[2].properties.part as any).text).toBe("after");
    });
  });

  // -----------------------------------------------------------------------
  // Tool call update
  // -----------------------------------------------------------------------

  describe("tool call updates", () => {
    it("should emit tool update with completed status", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_1",
          status: "completed",
          content: [{ type: "text", text: "file contents here" }],
        }),
      );

      expect(events).toHaveLength(1);
      const part = events[0].properties.part as any;
      expect(part.id).toBe("part_tc_tc_1");
      expect(part.type).toBe("tool");
      expect(part.callID).toBe("tc_1");
      expect(part.state.status).toBe("completed");
      expect(part.state.output).toBe("file contents here");
      expect(part.state.time.end).toBeGreaterThan(0);
    });

    it("should handle failed status", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_2",
          status: "failed",
          content: [{ type: "text", text: "permission denied" }],
        }),
      );

      const part = events[0].properties.part as any;
      expect(part.state.status).toBe("failed");
      expect(part.state.output).toBe("permission denied");
    });

    it("should handle null content", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_3",
          status: "completed",
          content: null,
        }),
      );

      const part = events[0].properties.part as any;
      expect(part.state.output).toBe("");
    });

    it("should default status to completed", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_4",
        }),
      );

      const part = events[0].properties.part as any;
      expect(part.state.status).toBe("completed");
    });

    it("should collect tool outputs", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_1",
          status: "completed",
          content: [{ type: "text", text: "output A" }],
        }),
      );
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_2",
          status: "completed",
          content: [{ type: "text", text: "output B" }],
        }),
      );

      expect(translator.toolOutputs).toEqual(["output A", "output B"]);
    });
  });

  // -----------------------------------------------------------------------
  // Ignored updates
  // -----------------------------------------------------------------------

  describe("ignored updates", () => {
    it("should ignore plan updates", () => {
      translator.handleSessionUpdate(
        makeNotification({ sessionUpdate: "plan" }),
      );
      expect(events).toHaveLength(0);
    });

    it("should ignore usage_update", () => {
      translator.handleSessionUpdate(
        makeNotification({ sessionUpdate: "usage_update" }),
      );
      expect(events).toHaveLength(0);
    });

    it("should ignore unknown update types", () => {
      translator.handleSessionUpdate(
        makeNotification({ sessionUpdate: "something_new" }),
      );
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Part ID format
  // -----------------------------------------------------------------------

  describe("part IDs", () => {
    it("should use part_{messageId}_{counter} format for text parts", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      );

      expect((events[0].properties.part as any).id).toBe("part_msg_1_0");
    });

    it("should increment counter for tool parts", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      );
      // counter is now 1 (text part took 0)
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call",
          toolCallId: "tc_1",
          title: "tool",
        }),
      );

      expect((events[1].properties.part as any).id).toBe("part_msg_1_1");
    });

    it("should use part_tc_{callId} for tool call updates", () => {
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_abc",
          status: "completed",
        }),
      );

      expect((events[0].properties.part as any).id).toBe("part_tc_tc_abc");
    });
  });

  // -----------------------------------------------------------------------
  // Full sequence
  // -----------------------------------------------------------------------

  describe("full turn sequence", () => {
    it("should handle text → tool → tool_update → text", () => {
      // Text chunk
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Let me check " },
        }),
      );

      // Tool call
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call",
          toolCallId: "tc_1",
          title: "read_file",
          rawInput: { path: "/test" },
        }),
      );

      // Tool update
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "tool_call_update",
          toolCallId: "tc_1",
          status: "completed",
          content: [{ type: "text", text: "file content" }],
        }),
      );

      // More text
      translator.handleSessionUpdate(
        makeNotification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done." },
        }),
      );

      expect(events).toHaveLength(4);
      expect(events[0].type).toBe("message.part.updated"); // text
      expect(events[1].type).toBe("message.part.updated"); // tool
      expect(events[2].type).toBe("message.part.updated"); // tool update
      expect(events[3].type).toBe("message.part.updated"); // text

      expect(translator.getOutput()).toBe("Let me check Done.");
    });
  });
});
