import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Database as SQLiteDatabase } from "bun:sqlite";
import { Database as CoreDatabase } from "@opencode-ai/core/database/database";
import { Identifier } from "@opencode-ai/core/id/id";
import { Effect } from "effect";
import type { AgentAppProfile } from "./agent-driver-contract";

export type CorpusPart = {
  id: string;
  order: number;
  type: string;
  [key: string]: unknown;
};
export type CorpusMessage = {
  id: string;
  order: number;
  role: "system" | "user" | "assistant";
  parts: CorpusPart[];
};
export type CorpusTurn = {
  id: string;
  index: number;
  anchor?: string;
  messages: CorpusMessage[];
};
export type CorpusSession = {
  id: string;
  title: string;
  order: number;
  turns: CorpusTurn[];
  events: Array<Record<string, unknown>>;
  terminalStreams: Array<Record<string, unknown>>;
};
export type AgentAppCorpus = {
  schemaVersion: 1;
  kind: "agent-app-corpus";
  corpusId: string;
  source: "generated-public" | "opencode-local";
  seed: string;
  sessions: CorpusSession[];
  manifest: {
    counts: Record<string, number>;
    hashes: {
      corpusSha256: string;
      semanticSha256: string;
      terminalSha256: string;
    };
  };
};

export type MaterializedCorpusPart = {
  corpusPartId: string;
  corpusMessageId: string;
  partId: string;
  messageId: string;
  sessionId: string;
  payload: Record<string, unknown>;
};

export async function readCanonicalCorpusDigest(corpusPath: string) {
  const corpus = parseCorpus(JSON.parse(await readFile(corpusPath, "utf8")));
  const digest = corpusDigest(corpus);
  if (digest !== corpus.manifest.hashes.corpusSha256) {
    throw new Error("corpus manifest digest does not match the canonical v1 payload");
  }
  return digest;
}

export async function materializeClaxedoCorpus(input: {
  corpusPath: string;
  corpusDigestSha256: string;
  dataDirectory: string;
  workspaceDirectory: string;
  profiles: AgentAppProfile[];
}) {
  const corpus = parseCorpus(
    JSON.parse(await readFile(input.corpusPath, "utf8")),
  );
  const computedDigest = corpusDigest(corpus);
  if (
    computedDigest !== input.corpusDigestSha256 ||
    computedDigest !== corpus.manifest.hashes.corpusSha256
  ) {
    throw new Error("corpus digest does not match the canonical v1 payload");
  }
  await Promise.all([
    mkdir(path.join(input.dataDirectory, "opencode-engine"), {
      recursive: true,
      mode: 0o700,
    }),
    mkdir(input.workspaceDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const workspaceDirectory = await realpath(input.workspaceDirectory);
  const projectId = await initializeWorkspace(workspaceDirectory);
  await registerWorkspace({
    dataDirectory: input.dataDirectory,
    workspaceDirectory,
    projectId,
    projectName: `Benchmark ${corpus.corpusId}`,
  });
  const dbPath = path.join(
    input.dataDirectory,
    "opencode-engine",
    "opencode.db",
  );
  // @opencode-ai/core and this standalone harness can resolve separate Effect
  // type identities in a workspace install. They share the same runtime API;
  // keep the cast at this one package boundary while using the canonical
  // database layer to create and migrate the engine database.
  const initialize = Effect.provide(
    CoreDatabase.Service as unknown as Effect.Effect<unknown, never, never>,
    CoreDatabase.layerFromPath(dbPath) as never,
  );
  await Effect.runPromise(Effect.scoped(initialize));

  const database = new SQLiteDatabase(dbPath);
  database.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
  const expectedMessages = new Map<string, string>();
  const expectedParts = new Map<string, string>();
  const materializedSessions = new Map<string, string>();
  const materializedParts = new Map<string, MaterializedCorpusPart>();
  const readinessTargets: Array<{
    sessionId: string;
    title: string;
    expectedMessageIds: string[];
    expectedContentSha256: Record<string, string>;
    expectedTextPartSha256: Record<string, string>;
    expectedPartIds: string[];
  }> = [];
  try {
    const baseTime = Date.parse("2020-01-01T00:00:00.000Z");
    database
      .prepare(
        "INSERT INTO project (id, worktree, name, time_created, time_updated, time_initialized, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        projectId,
        workspaceDirectory,
        `Benchmark ${corpus.corpusId}`,
        baseTime,
        baseTime,
        baseTime,
        "[]",
      );
    for (const session of corpus.sessions.toSorted(
      (a, b) => a.order - b.order,
    )) {
      const sessionTime = baseTime + session.order * 1_000_000;
      const sessionId = canonicalOpenCodeId("ses", sessionTime);
      materializedSessions.set(session.id, sessionId);
      let latestTurnMessageIds: string[] = [];
      let latestTurnContentSha256: Record<string, string> = {};
      let latestTurnTextPartSha256: Record<string, string> = {};
      let latestTurnPartIds: string[] = [];
      database
        .prepare(
          "INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)",
        )
        .run(
          sessionId,
          projectId,
          session.id,
          workspaceDirectory,
          session.title,
          "agent-app-v1",
          sessionTime,
          sessionTime + 999_999,
        );
      for (const turn of session.turns.toSorted((a, b) => a.index - b.index)) {
        let parentId: string | undefined;
        const turnMessageIds: string[] = [];
        const turnPartIds: string[] = [];
        const turnTextPartSha256: Record<string, string> = {};
        const turnContentSha256: Record<string, string> = {};
        for (const message of turn.messages.toSorted(
          (a, b) => a.order - b.order,
        )) {
          if (message.role === "system") continue;
          const at = sessionTime + turn.index * 10_000 + message.order * 1_000;
          const messageId = canonicalOpenCodeId("msg", at);
          const data =
            message.role === "user"
              ? {
                  role: "user",
                  time: { created: at },
                  agent: "build",
                  model: { providerID: "benchmark", modelID: "deterministic" },
                  summary: { diffs: [] },
                }
              : {
                  role: "assistant",
                  time: { created: at, completed: at + 999 },
                  parentID: parentId ?? messageId,
                  agent: "build",
                  providerID: "benchmark",
                  modelID: "deterministic",
                  mode: "build",
                  path: { cwd: workspaceDirectory, root: workspaceDirectory },
                  cost: 0,
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  },
                  finish: "stop",
                };
          const encodedMessage = JSON.stringify(data);
          database
            .prepare(
              "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(messageId, sessionId, at, at + 999, encodedMessage);
          expectedMessages.set(messageId, encodedMessage);
          if (message.role === "user") parentId = messageId;
          for (const part of message.parts.toSorted(
            (a, b) => a.order - b.order,
          )) {
            const partId = canonicalOpenCodeId("prt", at + part.order);
            if (materializedParts.has(part.id))
              throw new Error(`duplicate corpus part id: ${part.id}`);
            const payload = toOpenCodePart(part, at);
            if (
              message.role === "assistant" &&
              turnMessageIds.length === 0 &&
              payload.type === "text" &&
              typeof payload.text === "string" &&
              payload.text.trim()
            ) {
              turnMessageIds.push(messageId);
              // A message-level content sha only when the payload is an
              // ORIGINAL plain-text corpus part — converted markdown/code/
              // table/diff parts render transformed, so their raw text can
              // never hash-match painted text. The anchor itself does not
              // need the sha: rows carry part identity for verification.
              if (part.type === "text") {
                turnContentSha256[messageId] = createHash("sha256")
                  .update(payload.text.trim())
                  .digest("hex");
              }
            }
            turnPartIds.push(partId);
            // Only ORIGINAL plain-text corpus parts get an exact-content sha:
            // markdown/code/table/diff corpus parts are converted into "text"
            // payloads whose markdown SOURCE the renderer transforms, so their
            // rendered innerText can never hash-match the raw payload. Those
            // verify by part identity + painted text, like tool parts.
            if (
              part.type === "text" &&
              payload.type === "text" &&
              typeof payload.text === "string"
            ) {
              turnTextPartSha256[partId] = createHash("sha256")
                .update(payload.text.trim())
                .digest("hex");
            }
            const encodedPart = JSON.stringify(payload);
            database
              .prepare(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                partId,
                messageId,
                sessionId,
                at + part.order,
                at + 999,
                encodedPart,
              );
            expectedParts.set(partId, encodedPart);
            materializedParts.set(part.id, {
              corpusPartId: part.id,
              corpusMessageId: message.id,
              partId,
              messageId,
              sessionId,
              payload,
            });
          }
        }
        latestTurnMessageIds = turnMessageIds;
        latestTurnContentSha256 = turnContentSha256;
        latestTurnTextPartSha256 = turnTextPartSha256;
        latestTurnPartIds = turnPartIds;
      }
      if (latestTurnMessageIds.length === 0) {
        throw new Error(
          `Benchmark session ${session.id} latest turn has no canonical assistant text`,
        );
      }
      readinessTargets.push({
        expectedTextPartSha256: latestTurnTextPartSha256,
        expectedPartIds: latestTurnPartIds,
        sessionId,
        title: session.title,
        expectedMessageIds: latestTurnMessageIds,
        expectedContentSha256: latestTurnContentSha256,
      });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const actualMessages = new Map(
    (
      database
        .prepare("SELECT id, data FROM message ORDER BY id")
        .all() as Array<{ id: string; data: string }>
    ).map((row) => [row.id, row.data]),
  );
  const actualParts = new Map(
    (
      database.prepare("SELECT id, data FROM part ORDER BY id").all() as Array<{
        id: string;
        data: string;
      }>
    ).map((row) => [row.id, row.data]),
  );
  database.close();
  await registerSessionInventory({
    dataDirectory: input.dataDirectory,
    workspaceDirectory,
    projectId,
    sessions: corpus.sessions,
    materializedSessions,
  });
  const readbackPassed =
    sameMap(expectedMessages, actualMessages) &&
    sameMap(expectedParts, actualParts);
  const coverage = input.profiles.map((profile) => {
    const unsupportedShapes = profileCoverageFailures(corpus, profile);
    return {
      profile,
      corpusDigestSha256: computedDigest,
      counts: corpus.manifest.counts,
      semanticSha256: corpus.manifest.hashes.semanticSha256,
      passed: readbackPassed && unsupportedShapes.length === 0,
      unsupportedShapes,
    };
  });
  return {
    corpus,
    dbPath,
    projectId,
    workspaceDirectory,
    coverage,
    sessionIds: corpus.sessions
      .toSorted((a, b) => a.order - b.order)
      .map((session) => materializedSessions.get(session.id)!),
    readinessTargets,
    materializedSessions,
    materializedParts,
  };
}

async function initializeWorkspace(workspaceDirectory: string) {
  await runGit(["init", "--initial-branch=main", workspaceDirectory]);
  await runGit(
    [
      "-C",
      workspaceDirectory,
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "Agent app benchmark corpus",
    ],
    {
      GIT_AUTHOR_NAME: "Agent App Benchmark",
      GIT_AUTHOR_EMAIL: "benchmark@localhost",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Agent App Benchmark",
      GIT_COMMITTER_EMAIL: "benchmark@localhost",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  );
  const rootCommit = (
    await runGit([
      "-C",
      workspaceDirectory,
      "rev-list",
      "--max-parents=0",
      "HEAD",
    ])
  ).trim();
  if (!/^[0-9a-f]{40}$/u.test(rootCommit))
    throw new Error("git did not produce a canonical root commit project ID");
  return rootCommit;
}

async function runGit(args: string[], env?: Record<string, string>) {
  const child = Bun.spawn({
    cmd: ["git", ...args],
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `benchmark git preparation failed: ${(stderr || stdout).trim()}`,
    );
  return stdout;
}

async function registerWorkspace(input: {
  dataDirectory: string;
  workspaceDirectory: string;
  projectId: string;
  projectName: string;
}) {
  const workspaceStoreModule =
    "../../../claxedo-server-core/src/workspace/store/index.ts";
  const { ensureWorkspace } = (await import(workspaceStoreModule)) as {
    ensureWorkspace(input: {
      workspaceId: string;
      project_id: string;
      project_name: string;
      workspace_name: string;
      directory: string;
    }): Promise<{ id: string } | undefined>;
  };
  const previous = process.env.CLAXEDO_DATA_DIR;
  process.env.CLAXEDO_DATA_DIR = input.dataDirectory;
  try {
    const workspace = await ensureWorkspace({
      workspaceId: input.projectId,
      project_id: input.projectId,
      project_name: input.projectName,
      workspace_name: "main",
      directory: input.workspaceDirectory,
    });
    if (!workspace)
      throw new Error(
        "production workspace store rejected the benchmark workspace",
      );
  } finally {
    if (previous === undefined) delete process.env.CLAXEDO_DATA_DIR;
    else process.env.CLAXEDO_DATA_DIR = previous;
  }
}

async function registerSessionInventory(input: {
  dataDirectory: string;
  workspaceDirectory: string;
  projectId: string;
  sessions: CorpusSession[];
  materializedSessions: Map<string, string>;
}) {
  const runtimeStoreModule = "../../../workspace-runtime/src/store.ts";
  const { RuntimeStore } = (await import(runtimeStoreModule)) as {
    RuntimeStore: new (root: string) => {
      bindSession(input: {
        sessionId: string;
        directory: string;
        title: string;
        agentSessionId: string;
        createdAt: number;
      }): void;
      updateSessionConfig(
        id: string,
        update: {
          harness: { id: "opencode"; access: "native" };
          variant: null;
          agent: null;
        },
        input: { directory: string },
      ): unknown;
      markSessionInventoryImported(directory: string): void;
      flush(): void;
      close(): void;
    };
  };
  const store = new RuntimeStore(
    path.join(input.dataDirectory, "agent-core", input.projectId),
  );
  const baseTime = Date.parse("2020-01-01T00:00:00.000Z");
  try {
    // Reverse order makes corpus item zero the most recently updated row and
    // therefore present in Claxedo's initial five-row sidebar page.
    for (const session of input.sessions.toSorted(
      (left, right) => right.order - left.order,
    )) {
      const sessionId = input.materializedSessions.get(session.id);
      if (!sessionId)
        throw new Error(
          `session inventory is missing materialized ID for ${session.id}`,
        );
      store.bindSession({
        sessionId,
        directory: input.workspaceDirectory,
        title: session.title,
        agentSessionId: sessionId,
        createdAt: baseTime + session.order * 1_000_000,
      });
      store.updateSessionConfig(
        sessionId,
        {
          harness: { id: "opencode", access: "native" },
          variant: null,
          agent: null,
        },
        { directory: input.workspaceDirectory },
      );
    }
    store.markSessionInventoryImported(input.workspaceDirectory);
    store.flush();
  } finally {
    store.close();
  }
}

function profileCoverageFailures(
  corpus: AgentAppCorpus,
  profile: AgentAppProfile,
) {
  const failures: string[] = [];
  if (profile === "workspace-core-v1") {
    if (corpus.sessions.length !== 20) failures.push("workspace-session-count");
    if (corpus.sessions.some((session) => session.turns.length === 0))
      failures.push("workspace-empty-session");
  }
  if (profile === "resource-core-v1" && corpus.sessions.length !== 20)
    failures.push("resource-sweep-session-count");
  if (profile === "conversation-rich-v1") {
    if (
      corpus.sessions.some((session) =>
        session.turns.some((turn) =>
          turn.messages.some((message) => message.role === "system"),
        ),
      )
    ) {
      failures.push("system-message");
    }
    if (!corpus.sessions.some((session) => session.turns.length >= 3))
      failures.push("history-anchor-count");
    if (
      !corpus.sessions.some((session) =>
        session.events.some((event) => event.type === "message-part-revision"),
      )
    ) {
      failures.push("controlled-stream-events");
    }
  }
  if (
    profile === "terminal-core-v1" &&
    !corpus.sessions.some((session) =>
      session.terminalStreams.some(
        (stream) =>
          Array.isArray(stream.chunks) &&
          stream.chunks.length > 0 &&
          Array.isArray(stream.inputSentinels) &&
          stream.inputSentinels.length > 0,
      ),
    )
  ) {
    failures.push("terminal-stream");
  }
  return failures;
}

function toOpenCodePart(part: CorpusPart, at: number): Record<string, unknown> {
  if (part.type === "text")
    return { type: "text", text: String(part.text ?? "") };
  if (part.type === "markdown")
    return { type: "text", text: String(part.markdown ?? "") };
  if (part.type === "code")
    return {
      type: "text",
      text: `\`\`\`${String(part.language)}\n${String(part.code)}\n\`\`\``,
    };
  if (part.type === "table") {
    const headers = part.headers as string[];
    const rows = part.rows as string[][];
    return {
      type: "text",
      text: [
        `| ${headers.join(" | ")} |`,
        `| ${headers.map(() => "---").join(" | ")} |`,
        ...rows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n"),
    };
  }
  if (part.type === "diff")
    return {
      type: "text",
      text: `### ${String(part.path)}\n\n\`\`\`diff\n${String(part.patch)}\n\`\`\``,
    };
  if (part.type === "reasoning")
    return {
      type: "reasoning",
      text: String(part.text ?? ""),
      time: { start: at, end: at + 999 },
    };
  if (part.type === "attachment") {
    return {
      type: "file",
      mime: String(part.mediaType),
      filename: String(part.name),
      url: TRANSPARENT_PNG,
    };
  }
  if (part.type === "tool") {
    const input = JSON.parse(String(part.inputJson || "{}")) as Record<
      string,
      unknown
    >;
    const status = String(part.state);
    const state =
      status === "completed"
        ? {
            status,
            input,
            output: String(part.outputText ?? ""),
            title: String(part.toolName),
            metadata: {},
            time: { start: at, end: at + 999 },
          }
        : status === "error"
          ? {
              status,
              input,
              error: String(part.outputText ?? "error"),
              time: { start: at, end: at + 999 },
            }
          : status === "running"
            ? { status, input, time: { start: at } }
            : { status: "pending", input, raw: String(part.inputJson ?? "{}") };
    return {
      type: "tool",
      callID: String(part.callId),
      tool: String(part.toolName),
      state,
    };
  }
  throw new Error(`unsupported corpus part: ${part.type}`);
}

function canonicalOpenCodeId(prefix: "ses" | "msg" | "prt", timestamp: number) {
  // Production OpenCode message and part IDs begin with a 48-bit, ascending
  // millisecond clock. Claxedo intentionally sorts those IDs lexically in its
  // conversation registry. A plain content hash breaks that contract and can
  // make the benchmark render arbitrary old turns as the latest history fold.
  // Use the production owner rather than maintaining a benchmark-only clone
  // of the time encoding. The random suffix is intentionally opaque; corpus
  // identity is carried by the materialization maps and digest, not by IDs.
  return Identifier.create(prefix, "ascending", timestamp);
}

function parseCorpus(value: unknown): AgentAppCorpus {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("corpus must be an object");
  const corpus = value as AgentAppCorpus;
  if (
    corpus.schemaVersion !== 1 ||
    corpus.kind !== "agent-app-corpus" ||
    !Array.isArray(corpus.sessions)
  ) {
    throw new Error("unsupported agent-app corpus");
  }
  return corpus;
}

function corpusDigest(corpus: AgentAppCorpus) {
  const { manifest: _, ...payload } = corpus;
  return createHash("sha256")
    .update(JSON.stringify(sortJson(payload)))
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function sameMap(expected: Map<string, string>, actual: Map<string, string>) {
  return (
    expected.size === actual.size &&
    [...expected].every(([key, value]) => actual.get(key) === value)
  );
}

const TRANSPARENT_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwP4WQAAAABJRU5ErkJggg==";
