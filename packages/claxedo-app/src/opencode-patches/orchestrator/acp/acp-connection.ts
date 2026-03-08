/**
 * ACP Connection Helpers — HTTP and stdio connection setup for ACP agents.
 *
 * Extracted from acp-backend.ts — contains only connection plumbing,
 * no ExecutionBackend class. Used by tool.ts's executeViaAcp().
 */

import { AcpHttpClient, PROTOCOL_VERSION } from "acp-http-client";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpEventTranslator } from "./acp-event-translator";
import type { HttpTransportConfig, StdioTransportConfig } from "./acp-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AcpHandle {
  /** AcpHttpClient (or wrapped ClientSideConnection for stdio) */
  client: AcpHttpClient;
  cleanup(): Promise<void>;
}

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

export function createHttpConnection(
  config: HttpTransportConfig,
  translator: AcpEventTranslator,
): AcpHandle {
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

export function createStdioConnection(
  config: StdioTransportConfig,
  translator: AcpEventTranslator,
): AcpHandle {
  if (typeof Bun === "undefined") {
    throw new Error("ACP stdio transport requires Bun runtime");
  }

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
        clientInfo: { name: "orchestrator-acp", version: "1" },
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
