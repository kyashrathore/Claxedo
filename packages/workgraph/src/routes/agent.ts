import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { stream } from "hono/streaming";
import { ulid } from "ulid";

/** Default agent timeout: 5 minutes */
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export interface AgentRecord {
  id: string;
  run_id: string | null;
  node_id: string | null;
  prompt: string;
  cwd: string;
  status: "running" | "completed" | "failed";
  exit_code: number | null;
  output_chunks: string[];
  stderr_chunks: string[];
  created_at: string;
  finished_at: string | null;
  process: any;
  listeners: ((chunk: string, done: boolean) => void)[];
  /** Timer handle for agent timeout */
  timeout_handle: ReturnType<typeof setTimeout> | null;
}

const agents = new Map<string, AgentRecord>();

export function getActiveAgents(): AgentRecord[] {
  return Array.from(agents.values()).filter((a) => a.status === "running");
}

export function getAgentRecord(agentId: string): AgentRecord | undefined {
  return agents.get(agentId);
}

/**
 * Returns a promise that resolves when the agent finishes (completed or failed).
 * Resolves immediately if the agent is already done.
 */
export function waitForAgentCompletion(agentId: string): Promise<AgentRecord> {
  const record = agents.get(agentId);
  if (!record) return Promise.reject(new Error(`Agent ${agentId} not found`));
  if (record.status !== "running") return Promise.resolve(record);

  return new Promise<AgentRecord>((resolve) => {
    const listener = (_chunk: string, done: boolean) => {
      if (done) {
        resolve(record);
      }
    };
    record.listeners.push(listener);
  });
}

export function agentRouter() {
  const router = new Hono();

  // --- POST /agent/spawn ---
  router.post(
    "/agent/spawn",
    zValidator(
      "json",
      z.object({
        prompt: z.string().min(1),
        cwd: z.string().optional(),
        run_id: z.string().optional(),
        node_id: z.string().optional(),
      })
    ),
    async (c) => {
      const { prompt, cwd, run_id, node_id } = c.req.valid("json");

      const agentId = `agent_${ulid()}`;
      const workingDir = cwd || process.cwd();
      const cliBin = process.env.CLAUDE_CLI_PATH || "claude";

      // Build env: inherit process.env but remove CLAUDECODE to avoid nested-session errors
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const proc = Bun.spawn([cliBin, "-p", prompt, "--output-format", "stream-json", "--verbose"], {
        cwd: workingDir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      console.log(`[agent] Spawning ${agentId}: ${cliBin} -p "${prompt.slice(0, 80)}..." cwd=${workingDir}`);

      const record: AgentRecord = {
        id: agentId,
        run_id: run_id ?? null,
        node_id: node_id ?? null,
        prompt,
        cwd: workingDir,
        status: "running",
        exit_code: null,
        output_chunks: [],
        stderr_chunks: [],
        created_at: new Date().toISOString(),
        finished_at: null,
        process: proc,
        listeners: [],
        timeout_handle: null,
      };

      agents.set(agentId, record);

      // Set up agent timeout
      const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS || "", 10) || DEFAULT_AGENT_TIMEOUT_MS;
      record.timeout_handle = setTimeout(() => {
        if (record.status === "running") {
          console.error(`[agent] ${agentId} timed out after ${timeoutMs / 1000}s — killing process`);
          record.stderr_chunks.push(`\nAgent timed out after ${timeoutMs / 1000} seconds\n`);
          try {
            record.process.kill("SIGTERM");
          } catch (_) {
            // process may have already exited
          }
          // Give it 5s to exit gracefully, then SIGKILL
          setTimeout(() => {
            if (record.status === "running") {
              try {
                record.process.kill("SIGKILL");
              } catch (_) {}
            }
          }, 5000);
        }
      }, timeoutMs);

      // Background: read stdout and push to listeners
      (async () => {
        try {
          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            record.output_chunks.push(text);
            for (const listener of record.listeners) {
              listener(text, false);
            }
          }
        } catch (_) {
          // stream ended or errored
        }

        // Wait for process to exit
        const exitCode = await proc.exited;
        record.exit_code = exitCode;
        record.status = exitCode === 0 ? "completed" : "failed";
        record.finished_at = new Date().toISOString();

        // Clear timeout on completion
        if (record.timeout_handle) {
          clearTimeout(record.timeout_handle);
          record.timeout_handle = null;
        }

        if (exitCode === 0) {
          console.log(`[agent] ${agentId} completed successfully`);
        } else {
          console.error(`[agent] ${agentId} failed with exit code ${exitCode}`);
          console.error(`[agent] ${agentId} stdout (last 500 chars): ${record.output_chunks.join("").slice(-500)}`);
          console.error(`[agent] ${agentId} stderr: ${record.stderr_chunks.join("")}`);
        }

        // Notify listeners of completion
        for (const listener of record.listeners) {
          listener("", true);
        }
        record.listeners = [];
      })();

      // Background: read stderr
      (async () => {
        try {
          const reader = proc.stderr.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            record.stderr_chunks.push(text);
          }
        } catch (_) {
          // stream ended or errored
        }
      })();

      return c.json(
        {
          id: agentId,
          run_id: record.run_id,
          node_id: record.node_id,
          prompt,
          cwd: workingDir,
          status: "running",
          created_at: record.created_at,
        },
        201
      );
    }
  );

  // --- GET /agent/list ---
  router.get("/agent/list", async (c) => {
    const list = Array.from(agents.values()).map((a) => ({
      id: a.id,
      run_id: a.run_id,
      node_id: a.node_id,
      prompt: a.prompt.slice(0, 200),
      cwd: a.cwd,
      status: a.status,
      exit_code: a.exit_code,
      created_at: a.created_at,
      finished_at: a.finished_at,
    }));
    return c.json(list);
  });

  // --- GET /agent/:agent_id/status ---
  router.get("/agent/:agent_id/status", async (c) => {
    const agentId = c.req.param("agent_id");
    const record = agents.get(agentId);
    if (!record) {
      return c.json({ error: "Agent not found" }, 404);
    }
    return c.json({
      id: record.id,
      run_id: record.run_id,
      node_id: record.node_id,
      status: record.status,
      exit_code: record.exit_code,
      created_at: record.created_at,
      finished_at: record.finished_at,
      output_length: record.output_chunks.length,
      stderr: record.stderr_chunks.join(""),
    });
  });

  // --- GET /agent/:agent_id/stream ---
  router.get("/agent/:agent_id/stream", async (c) => {
    const agentId = c.req.param("agent_id");
    const record = agents.get(agentId);
    if (!record) {
      return c.json({ error: "Agent not found" }, 404);
    }

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    return stream(c, async (s) => {
      // Replay existing chunks
      for (const chunk of record.output_chunks) {
        await s.write(`data: ${JSON.stringify({ type: "output", text: chunk })}\n\n`);
      }

      // If already done, send final status and close
      if (record.status !== "running") {
        await s.write(
          `data: ${JSON.stringify({ type: "done", status: record.status, exit_code: record.exit_code })}\n\n`
        );
        return;
      }

      // Register a listener for new chunks
      let resolve: (() => void) | null = null;
      let finished = false;

      const listener = (chunk: string, done: boolean) => {
        if (done) {
          finished = true;
        }
        if (resolve) resolve();
      };

      record.listeners.push(listener);

      try {
        while (!finished) {
          // Wait for the next chunk or completion signal
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;

          // Write any new chunks since we last checked
          // The listener fires per chunk; chunks are appended to output_chunks
          // We write the latest chunk
          const latestChunk = record.output_chunks[record.output_chunks.length - 1];
          if (latestChunk && !finished) {
            await s.write(
              `data: ${JSON.stringify({ type: "output", text: latestChunk })}\n\n`
            );
          }

          if (finished) {
            await s.write(
              `data: ${JSON.stringify({ type: "done", status: record.status, exit_code: record.exit_code })}\n\n`
            );
          }
        }
      } finally {
        // Remove listener on disconnect
        const idx = record.listeners.indexOf(listener);
        if (idx !== -1) record.listeners.splice(idx, 1);
      }
    });
  });

  // --- POST /agent/:agent_id/kill ---
  router.post("/agent/:agent_id/kill", async (c) => {
    const agentId = c.req.param("agent_id");
    const record = agents.get(agentId);
    if (!record) {
      return c.json({ error: "Agent not found" }, 404);
    }
    if (record.status !== "running") {
      return c.json({ error: "Agent is not running", status: record.status }, 400);
    }

    // Clear timeout before killing
    if (record.timeout_handle) {
      clearTimeout(record.timeout_handle);
      record.timeout_handle = null;
    }

    try {
      record.process.kill("SIGTERM");
    } catch (_) {
      // process may have already exited
    }

    return c.json({ id: agentId, message: "SIGTERM sent" });
  });

  return router;
}
