import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { stream } from "hono/streaming";
import { ulid } from "ulid";
import type { EventEnvelope } from "../orchestrator/events";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";
import {
  startOrchestration,
  getOrchestration,
  getAllOrchestrations,
  cancelOrchestration,
} from "../orchestrator/executor";
import { getAgentRecord, waitForAgentCompletion } from "./agent";

/**
 * ACP (Agent Communication Protocol) compatible REST endpoints.
 *
 * Implements a subset of the ACP spec (https://agentcommunicationprotocol.dev):
 *   GET  /acp/agents                           — list available agents
 *   GET  /acp/agents/:agent_id                  — get agent descriptor
 *   POST /acp/agents/:agent_id/runs             — create a run
 *   GET  /acp/agents/:agent_id/runs/:run_id     — get run status
 *   POST /acp/agents/:agent_id/runs/:run_id/cancel — cancel a run
 *   GET  /acp/agents/:agent_id/runs/:run_id/events — SSE event stream
 */

/** ACP message part */
interface AcpMessagePart {
  content_type: string;
  content: string;
  content_encoding?: string;
}

/** ACP message */
interface AcpMessage {
  role: "user" | "agent";
  parts: AcpMessagePart[];
}

/** Map our run status to ACP run status */
function toAcpStatus(status: string, phase?: string): string {
  if (phase === "planning" || phase === "building_graph") return "in-progress";
  if (phase === "planned") return "in-progress";
  if (phase === "executing") return "in-progress";
  if (phase === "cancelled") return "cancelled";
  switch (status) {
    case "active":
      return "in-progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "created";
  }
}

/** The orchestrator agent descriptor */
const ORCHESTRATOR_AGENT = {
  name: "orchestrator",
  description:
    "AI orchestrator that decomposes goals into task graphs and executes them using Claude agents",
  version: "1.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
};

/** The direct agent descriptor (single agent, no orchestration) */
const DIRECT_AGENT = {
  name: "direct",
  description:
    "Spawn a single Claude agent to execute a prompt directly without orchestration",
  version: "1.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
};

const AGENTS: Record<string, typeof ORCHESTRATOR_AGENT> = {
  orchestrator: ORCHESTRATOR_AGENT,
  direct: DIRECT_AGENT,
};

/**
 * Spawn a Claude agent via the internal agent module (for orchestration).
 */
async function spawnAgentViaRoute(
  prompt: string,
  runId: string,
  nodeId: string
): Promise<any> {
  const port = process.env.PORT || 4100;
  const res = await fetch(`http://localhost:${port}/agent/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      run_id: runId,
      node_id: nodeId || undefined,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to spawn agent: ${res.status} — ${body}`);
  }

  return res.json();
}

export function acpRouter(db: any) {
  const router = new Hono();

  // --- GET /acp/agents ---
  router.get("/acp/agents", async (c) => {
    return c.json(Object.values(AGENTS));
  });

  // --- GET /acp/agents/:agent_id ---
  router.get("/acp/agents/:agent_id", async (c) => {
    const agentId = c.req.param("agent_id");
    const agent = AGENTS[agentId];
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    return c.json(agent);
  });

  // --- POST /acp/agents/:agent_id/runs ---
  router.post(
    "/acp/agents/:agent_id/runs",
    zValidator(
      "json",
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["user", "agent"]),
            parts: z.array(
              z.object({
                content_type: z.string().default("text/plain"),
                content: z.string(),
                content_encoding: z.string().optional(),
              })
            ),
          })
        ),
        config: z.record(z.any()).optional(),
      })
    ),
    async (c) => {
      const agentType = c.req.param("agent_id");
      const { messages, config } = c.req.valid("json");

      if (!AGENTS[agentType]) {
        return c.json({ error: "Agent not found" }, 404);
      }

      // Extract goal from the last user message
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg || !lastUserMsg.parts.length) {
        return c.json({ error: "No user message provided" }, 400);
      }
      const goal = lastUserMsg.parts.map((p) => p.content).join("\n");

      const runId = `run_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      const seq = getNextSeq(db, runId);

      const event: EventEnvelope = {
        id: eventId,
        run_id: runId,
        stream_id: runId,
        stream_seq: seq,
        logical_ts: seq,
        schema_version: 1,
        type: "run_created",
        payload_json: JSON.stringify({ goal, status: "active" }),
        actor_type: "user",
        actor_id: "acp",
        op_id: `op_${eventId}`,
        prev_hash: "00000000",
        hash: generateHash(),
        created_at: new Date().toISOString(),
      };

      insertEvent(db, event);
      db.run(
        "INSERT INTO runs_current (run_id, goal, status) VALUES (?, ?, ?)",
        [runId, goal, "active"]
      );

      if (agentType === "orchestrator") {
        // Start full orchestration
        const state = startOrchestration(
          db,
          runId,
          goal,
          spawnAgentViaRoute,
          (id) => getAgentRecord(id)!,
          waitForAgentCompletion
        );
        state.catch((err) => {
          console.error(`[acp] orchestration error for ${runId}:`, err);
        });
      } else {
        // Direct agent: spawn a single Claude agent
        try {
          await spawnAgentViaRoute(goal, runId, "");
        } catch (err) {
          console.error(`[acp] direct agent spawn error for ${runId}:`, err);
        }
      }

      const createdAt = new Date().toISOString();

      return c.json(
        {
          id: runId,
          agent_id: agentType,
          status: "in-progress",
          created_at: createdAt,
          updated_at: createdAt,
          messages: [
            {
              role: "user",
              parts: lastUserMsg.parts,
            },
          ],
        },
        201
      );
    }
  );

  // --- GET /acp/agents/:agent_id/runs/:run_id ---
  router.get("/acp/agents/:agent_id/runs/:run_id", async (c) => {
    const agentType = c.req.param("agent_id");
    const runId = c.req.param("run_id");

    if (!AGENTS[agentType]) {
      return c.json({ error: "Agent not found" }, 404);
    }

    const run = db
      .query("SELECT * FROM runs_current WHERE run_id = ?")
      .get(runId) as any;

    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }

    const orch = getOrchestration(runId);
    const acpStatus = toAcpStatus(run.status, orch?.phase);

    // Gather messages for this run
    const dbMessages = db
      .query(
        "SELECT * FROM messages_current WHERE run_id = ? AND message_type != 'node_metadata' ORDER BY created_at ASC"
      )
      .all(runId) as any[];

    const acpMessages: AcpMessage[] = [
      {
        role: "user",
        parts: [{ content_type: "text/plain", content: run.goal }],
      },
    ];

    for (const msg of dbMessages) {
      acpMessages.push({
        role: msg.sender_id === "user" ? "user" : "agent",
        parts: [{ content_type: "text/plain", content: msg.content }],
      });
    }

    // If orchestration has a plan summary, include it
    if (orch?.plan?.summary) {
      acpMessages.push({
        role: "agent",
        parts: [
          {
            content_type: "text/plain",
            content: `Plan: ${orch.plan.summary}`,
          },
        ],
      });
    }

    // Include final result when run is completed (Gap 3)
    if (orch?.result) {
      acpMessages.push({
        role: "agent",
        parts: [
          {
            content_type: "text/plain",
            content: orch.result,
          },
        ],
      });
    }

    return c.json({
      id: runId,
      agent_id: agentType,
      status: acpStatus,
      created_at: orch?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: acpMessages,
      metadata: orch
        ? {
            phase: orch.phase,
            error: orch.error,
            planner_agent_id: orch.planner_agent_id,
            result: orch.result || null,
          }
        : undefined,
    });
  });

  // --- POST /acp/agents/:agent_id/runs/:run_id/cancel ---
  router.post("/acp/agents/:agent_id/runs/:run_id/cancel", async (c) => {
    const runId = c.req.param("run_id");
    const orch = getOrchestration(runId);

    if (!orch) {
      return c.json({ error: "Run not found or not orchestrated" }, 404);
    }

    if (
      orch.phase === "completed" ||
      orch.phase === "failed" ||
      orch.phase === "cancelled"
    ) {
      return c.json({ error: `Run already ${orch.phase}` }, 400);
    }

    cancelOrchestration(orch, db, (agentId) => {
      const agent = getAgentRecord(agentId);
      if (agent?.process) {
        try {
          agent.process.kill("SIGTERM");
        } catch {
          // already exited
        }
      }
    });

    return c.json({
      id: runId,
      status: "cancelled",
      message: "Run cancelled",
    });
  });

  // --- GET /acp/agents/:agent_id/runs/:run_id/events ---
  router.get("/acp/agents/:agent_id/runs/:run_id/events", async (c) => {
    const runId = c.req.param("run_id");

    const run = db
      .query("SELECT * FROM runs_current WHERE run_id = ?")
      .get(runId) as any;

    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      let lastSeq = 0;
      let done = false;

      // Poll for new events every 2 seconds
      while (!done) {
        const events = db
          .query(
            "SELECT * FROM events WHERE run_id = ? AND stream_seq > ? ORDER BY stream_seq ASC"
          )
          .all(runId, lastSeq) as EventEnvelope[];

        for (const evt of events) {
          const acpEvent = {
            id: evt.id,
            type: evt.type,
            timestamp: evt.created_at,
            data: JSON.parse(evt.payload_json),
          };
          await s.write(
            `data: ${JSON.stringify(acpEvent)}\n\n`
          );
          lastSeq = evt.stream_seq;
        }

        // Check if run is done
        const currentRun = db
          .query("SELECT status FROM runs_current WHERE run_id = ?")
          .get(runId) as any;

        if (
          currentRun &&
          (currentRun.status === "completed" || currentRun.status === "failed")
        ) {
          await s.write(
            `data: ${JSON.stringify({ type: "run_finished", status: currentRun.status })}\n\n`
          );
          done = true;
        } else {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    });
  });

  return router;
}
