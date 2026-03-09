/**
 * ACP Execution Backend — launches tasks via ACP agent loops (HTTP or stdio).
 *
 * HTTP transport: connects to an ACP server and selects the agent loop
 * (claude, codex, etc.) via the bootstrap query parameter.
 *
 * Stdio transport: spawns a local ACP agent process and communicates via
 * newline-delimited JSON over stdin/stdout.
 */

import { AcpHttpClient, PROTOCOL_VERSION } from "acp-http-client";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";

import type { ExecutionBackend, TaskHandle } from "../backends";
import type { TaskInfo } from "../types";
import { createChildSession, setNodeSession } from "../session-bridge";
import { AcpEventTranslator } from "./acp-event-translator";
import type {
  AcpRegistryConfig,
  HttpTransportConfig,
  StdioTransportConfig,
} from "./acp-registry";
import { resolveEntry } from "./acp-registry";

// ---------------------------------------------------------------------------
// Shared client handler builder
// ---------------------------------------------------------------------------

function makeClientHandlers(translator: AcpEventTranslator) {
  return {
    sessionUpdate: async (notification: SessionNotification) => {
      translator.handleSessionUpdate(notification);
    },
    requestPermission: async () => ({
      outcome: { outcome: "approved" as const },
    }),
  };
}

// ---------------------------------------------------------------------------
// HTTP connection — uses AcpHttpClient (handles defaults internally)
// ---------------------------------------------------------------------------

interface AgentHandle {
  /** AcpHttpClient for HTTP, or wrapped ClientSideConnection for stdio */
  client: AcpHttpClient;
  cleanup(): Promise<void>;
}

function createHttpConnection(
  config: HttpTransportConfig,
  translator: AcpEventTranslator,
): AgentHandle {
  const client = new AcpHttpClient({
    baseUrl: config.baseUrl,
    token: config.token,
    transport: {
      path: config.path,
      bootstrapQuery: { agent: config.agent },
    },
    client: makeClientHandlers(translator),
  });

  return {
    client,
    async cleanup() {
      await client.disconnect();
    },
  };
}

// ---------------------------------------------------------------------------
// Stdio connection — uses ClientSideConnection + ndJsonStream, wrapped in
// an AcpHttpClient-compatible interface via a thin adapter
// ---------------------------------------------------------------------------

function createStdioConnection(
  config: StdioTransportConfig,
  translator: AcpEventTranslator,
): AgentHandle {
  const args = config.args ?? [];
  const proc = Bun.spawn([config.command, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...config.env },
  });

  // Bun.spawn stdin is a FileSink, not a WritableStream.
  // Wrap it so ndJsonStream() can use .getWriter().
  const stdinSink = proc.stdin;
  const stdinStream = new WritableStream<Uint8Array>({
    write(chunk) {
      stdinSink.write(chunk);
    },
    close() {
      stdinSink.end();
    },
  });

  const stream = ndJsonStream(
    stdinStream,
    proc.stdout as ReadableStream<Uint8Array>,
  );

  const connection = new ClientSideConnection(
    () => makeClientHandlers(translator),
    stream,
  );

  // Wrap ClientSideConnection to match AcpHttpClient API surface.
  // ClientSideConnection methods need full protocol params; AcpHttpClient
  // fills in defaults. We replicate the defaults here.
  const wrapper: AcpHttpClient = {
    initialize: (request = {}) =>
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "acp-backend", version: "1" },
        ...request,
      }),
    newSession: (request) => connection.newSession(request),
    prompt: (request) => connection.prompt(request),
    cancel: (notification) => connection.cancel(notification),
    disconnect: async () => proc.kill(),
  } as unknown as AcpHttpClient;

  return {
    client: wrapper,
    async cleanup() {
      proc.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// AcpBackend
// ---------------------------------------------------------------------------

export class AcpBackend implements ExecutionBackend {
  constructor(private registry: AcpRegistryConfig) {}

  async launch(
    task: TaskInfo,
    runId: string,
    nodeId: string,
    parentSessionID?: string,
  ): Promise<TaskHandle> {
    const entry = resolveEntry(this.registry, task.kind);
    if (!entry) {
      throw new Error(
        `[acp-backend] No ACP entry configured for task kind "${task.kind}"`,
      );
    }

    const messageId = `msg_acp_${nodeId}`;
    const translator = new AcpEventTranslator(
      `acp_${nodeId}`,
      messageId,
      () => {}, // sink — future: post to OpenCode event bus
    );

    const { client, cleanup } =
      entry.transport.mode === "http"
        ? createHttpConnection(entry.transport, translator)
        : createStdioConnection(entry.transport, translator);

    // Bootstrap: initialize → newSession
    await client.initialize();
    const { sessionId } = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    // Optionally create an OpenCode child session for frontend tracking
    if (parentSessionID && process.env.OPENCODE_SERVER_URL) {
      const ocSessionId = await createChildSession(
        parentSessionID,
        task,
        nodeId,
        runId,
      );
      if (ocSessionId) {
        setNodeSession(runId, nodeId, ocSessionId);
      }
    }

    let cancelled = false;

    return {
      id: `acp_${nodeId}`,
      async await() {
        try {
          const response = await client.prompt({
            sessionId,
            prompt: [{ type: "text", text: task.prompt }],
          });

          if (cancelled) {
            return { output: "", status: "failed", error: "Cancelled" };
          }

          return {
            output: translator.getOutput(),
            status:
              response.stopReason === "error" ? "failed" : "completed",
          };
        } catch (err) {
          return {
            output: translator.getOutput(),
            status: "failed",
            error: (err as Error).message,
          };
        } finally {
          await cleanup();
        }
      },
      cancel() {
        cancelled = true;
        client.cancel({ sessionId }).catch(() => {});
        cleanup().catch(() => {});
      },
    };
  }
}
