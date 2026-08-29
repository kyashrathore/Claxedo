import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { materializeClaxedoCorpus, readCanonicalCorpusDigest } from "../src/agent-corpus-materializer";

describe("Claxedo agent-app corpus materializer", () => {
  test("writes reasoning and rich content into the production OpenCode database schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-agent-corpus-"));
    try {
      const payload = {
        schemaVersion: 1 as const,
        kind: "agent-app-corpus" as const,
        corpusId: "fixture",
        source: "generated-public" as const,
        seed: "fixture-seed",
        sessions: [
          {
            id: "session-1",
            title: "Fixture",
            order: 0,
            events: [],
            terminalStreams: [],
            turns: [
              {
                id: "turn-1",
                index: 0,
                messages: [
                  {
                    id: "message-user",
                    order: 0,
                    role: "user" as const,
                    parts: [
                      { id: "prompt", order: 0, type: "text", text: "hello" },
                    ],
                  },
                  {
                    id: "message-assistant",
                    order: 1,
                    role: "assistant" as const,
                    parts: [
                      {
                        id: "reason",
                        order: 0,
                        type: "reasoning",
                        text: "think",
                      },
                      {
                        id: "answer",
                        order: 1,
                        type: "markdown",
                        markdown: "**done**",
                      },
                      {
                        id: "tool",
                        order: 2,
                        type: "tool",
                        callId: "call",
                        toolName: "read",
                        state: "completed",
                        inputJson: "{}",
                        outputText: "ok",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      const digest = createHash("sha256")
        .update(JSON.stringify(sortJson(payload)))
        .digest("hex");
      const corpus = {
        ...payload,
        manifest: {
          counts: {
            sessions: 1,
            turns: 1,
            messages: 2,
            parts: 4,
            textParts: 1,
            markdownParts: 1,
            codeParts: 0,
            tableParts: 0,
            diffParts: 0,
            toolParts: 1,
            reasoningParts: 1,
            attachments: 0,
            lifecycleEvents: 0,
            terminalStreams: 0,
            terminalBytes: 0,
            renderableBytes: 15,
          },
          hashes: {
            corpusSha256: digest,
            semanticSha256: "b".repeat(64),
            terminalSha256: "c".repeat(64),
          },
        },
      };
      const corpusPath = path.join(root, "corpus.json");
      await Bun.write(corpusPath, JSON.stringify(corpus));
      expect(await readCanonicalCorpusDigest(corpusPath)).toBe(digest);
      expect(createHash("sha256").update(await readFile(corpusPath)).digest("hex")).not.toBe(digest);
      const result = await materializeClaxedoCorpus({
        corpusPath,
        corpusDigestSha256: digest,
        dataDirectory: path.join(root, "data"),
        workspaceDirectory: path.join(root, "workspace"),
        profiles: ["resource-core-v1"],
      });
      expect(result.coverage).toEqual([
        expect.objectContaining({
          profile: "resource-core-v1",
          passed: false,
          unsupportedShapes: ["resource-sweep-session-count"],
        }),
      ]);
      expect(await Bun.file(result.dbPath).exists()).toBe(true);
      const database = new Database(result.dbPath, { readonly: true });
      const sessionId = result.materializedSessions.get("session-1")!;
      expect(sessionId).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(result.readinessTargets).toEqual([
        {
          sessionId,
          title: "1. Fixture",
          expectedMessageIds: [
            expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/),
          ],
          expectedContentSha256: expect.any(Object),
          expectedTextPartSha256: expect.any(Object),
          expectedPartIds: expect.any(Array),
        },
      ]);
      expect(
        (database.query("SELECT title FROM session WHERE id = ?").get(sessionId) as { title: string }).title,
      ).toBe("1. Fixture");
      const chronologicalMessageIds = database
        .query("SELECT id FROM message ORDER BY time_created ASC, id ASC")
        .all()
        .map((row) => (row as { id: string }).id);
      const lexicalMessageIds = database
        .query("SELECT id FROM message ORDER BY id ASC")
        .all()
        .map((row) => (row as { id: string }).id);
      expect(lexicalMessageIds).toEqual(chronologicalMessageIds);
      expect(
        database
          .query("SELECT workspace_id FROM session WHERE id = ?")
          .get(sessionId),
      ).toEqual({
        workspace_id: null,
      });
      database.close();
      expect(
        JSON.parse(
          await readFile(path.join(root, "data", "workspaces.json"), "utf8"),
        ),
      ).toMatchObject({
        version: 4,
        workspaces: [
          {
            id: result.workspaces.get("")!.projectId,
            project_id: result.workspaces.get("")!.projectId,
            workspace_name: "main",
            directory: await realpath(path.join(root, "workspace")),
            kind: "local",
          },
        ],
      });
      expect(result.materializedParts.get("reason")).toMatchObject({
        partId: expect.stringMatching(/^prt_/),
        messageId: expect.stringMatching(/^msg_/),
        sessionId,
        payload: { type: "reasoning", text: "think" },
      });
      expect(result.materializedParts.get("tool")?.payload).toMatchObject({
        type: "tool",
        callID: "call",
        tool: "read",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  return value;
}
