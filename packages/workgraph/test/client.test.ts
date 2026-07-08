import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkGraph, type WorkGraphClient } from "../src/client";
import { custom, github } from "../src/connectors/index";
import type { GitHubProxyRequest, GitHubProxyResponse } from "../src/connectors/github/github";
import type { ConnectorInterface, ProviderPreview } from "../src/connectors/interface";

/**
 * README-contract tests (plan 2026-07-06-004 Phase 4): every call in the
 * quickstart works end-to-end against a fake provider and a fake runner.
 */

let client: WorkGraphClient | null = null;

afterEach(() => {
  client?.close();
  client = null;
});

function fakeProvider(issues: ProviderPreview[], log: { comments: string[]; updates: unknown[] }) {
  const connector: ConnectorInterface = {
    provider: "faketracker",
    queryIssues: async () => issues,
    hydrateIssue: async (params) => issues.find((i) => i.external_key === params.external_key)!,
    updateIssue: async (_params, updates) => { log.updates.push(updates); },
    addComment: async (_params, comment) => { log.comments.push(comment); },
  };
  return custom({
    provider: "faketracker",
    connector,
    query: { mode: "project_or_team", params: {} },
  });
}

function fakeRunner(spawned: string[]) {
  return {
    launch: async ({ item, attempt }: { item: { id: string }; attempt: { worktree: string } }) => {
      spawned.push(item.id);
      return { sessionId: `ses_${item.id}`, worktree: attempt.worktree };
    },
  };
}

function preview(key: string, title: string): ProviderPreview {
  return {
    id: key,
    title,
    description: `Body of ${title}`,
    status: "open",
    provider_url: `https://fake/${key}`,
    external_key: key,
    provider: "github",
    provider_meta: { external_key: key },
  };
}

describe("createWorkGraph — README contract", () => {
  it("create() works with zero setup and records caller provenance", async () => {
    client = createWorkGraph({ actor: "user:yash" });
    const item = await client.create({ title: "Spike: swap the JSON parser", label: "chore" });
    expect(item.provider).toBe("claxedo");
    expect(item.labels).toContain("chore");

    const created = client.events(item.id).find((e) => e.type === "item_created");
    expect(created).toBeDefined();
    expect(JSON.parse(created!.payload).provenance.actor).toBe("user:yash");
  });

  it("one create for humans and agents — same event, different actor", async () => {
    client = createWorkGraph({ actor: "user:yash" });
    const human = await client.create({ title: "Human card" });
    const agentClient = client; // same client, agent identity flows via graph API
    const agentItem = agentClient.graph.create({ title: "Agent card", provider: "claxedo", provenance: { actor: "agent" } });

    const humanEvt = client.events(human.id).find((e) => e.type === "item_created")!;
    const agentEvt = client.events(agentItem.id).find((e) => e.type === "item_created")!;
    expect(humanEvt.type).toBe(agentEvt.type);
    expect(JSON.parse(humanEvt.payload).provenance.actor).toBe("user:yash");
    expect(JSON.parse(agentEvt.payload).provenance.actor).toBe("agent");
  });

  it("sync() mirrors the firehose idempotently", async () => {
    client = createWorkGraph();
    const log = { comments: [], updates: [] };
    await client.connect(fakeProvider([preview("T-1", "Bug one"), preview("T-2", "Bug two")], log));

    const first = await client.sync();
    expect(first).toEqual({ imported: 2, updated: 0 });
    const second = await client.sync();
    expect(second).toEqual({ imported: 0, updated: 2 });
    expect(client.items({ status: "new" })).toHaveLength(2);
  });

  it("mirrored vs staged: stage() is the deliberate gate", async () => {
    client = createWorkGraph();
    const log = { comments: [], updates: [] };
    await client.connect(fakeProvider([preview("T-1", "Bug one")], log));
    await client.sync();

    const [item] = client.items({ status: "new" });
    await client.stage(item.id, { context: "Repro in thread.", loadout: "fix-bug" });

    expect(client.items({ status: "new" })).toHaveLength(0);
    const [staged] = client.items({ status: "staged" });
    expect(staged.id).toBe(item.id);
    expect(staged.labels).toContain("loadout:fix-bug");
    expect(staged.context).toContain("Repro in thread.");
  });

  it("policy() auto-stages matching cards on sync", async () => {
    client = createWorkGraph();
    await client.policy({ when: { source: "faketracker" }, then: { stage: true, loadout: "fix-bug" } });
    const log = { comments: [], updates: [] };
    await client.connect(fakeProvider([preview("T-9", "P1 bug")], log));
    await client.sync();

    expect(client.items({ status: "staged" })).toHaveLength(1);
    expect(client.items({ status: "staged" })[0].labels).toContain("loadout:fix-bug");
  });

  it("executor + start run an attempt; completion flows back as a review interrupt", async () => {
    client = createWorkGraph();
    const item = await client.create({ title: "Fix the flaky test" });
    const spawned: string[] = [];
    client.executor(fakeRunner(spawned));

    const { runId, nodeId } = await client.start(item.id);
    expect(spawned).toEqual([item.id]);
    expect(client.items({ status: "running" })).toHaveLength(1);

    // The runner reports completion (same path the MCP update_status tool uses).
    const { onAttemptStatusUpdate } = await import("../src/sdk/attempts");
    const { openSqliteExecutionStore } = await import("../src/sdk/execution-store");
    void openSqliteExecutionStore; // store access is via the client here
    await onAttemptStatusUpdate(
      (client as any).store,
      runId,
      nodeId,
      "completed",
      async () => {
        throw new Error("no respawn expected");
      },
      undefined,
      { graph: client.graph },
    );

    expect(client.items({ status: "done" })).toHaveLength(1);
    const interrupts = await client.poll();
    expect(interrupts.some((i) => i.kind === "review" && i.itemId === item.id)).toBe(true);
  });

  it("failure interrupts surface failed attempts", async () => {
    client = createWorkGraph();
    const item = await client.create({ title: "Doomed work" });
    client.executor({
      launch: async () => { throw new Error("runner exploded"); },
    });
    await client.start(item.id);

    // Spawn failed twice (initial + none since revert) — node back to pending;
    // force a failed node to exercise the interrupt shape.
    (client as any).db.run("UPDATE nodes_current SET status = 'failed'");
    const interrupts = await client.poll();
    expect(interrupts.some((i) => i.kind === "failure")).toBe(true);
  });

  it("question and approval interrupts are answerable", async () => {
    client = createWorkGraph();
    const item = await client.create({ title: "Ambiguous work" });

    client.graph.writeScratchpad({
      subjectType: "run_node",
      subjectId: item.id,
      workItemId: item.id,
      kind: "executor",
      content: "Should I use approach A or B?",
      priority: "blocking",
    });
    const decision = client.graph.createDecision({
      kind: "clarification",
      intentKind: "update_item",
      subjectType: "work_item",
      subjectId: item.id,
      promptMd: "Approve the risky migration?",
      recommendedIntentPayload: {},
      alternatives: [],
      confidence: 0.5,
      evidenceMd: "See thread.",
      defaultAction: "reject",
      autoApplyAllowed: false,
    } as never);

    const interrupts = await client.poll();
    const question = interrupts.find((i) => i.kind === "question");
    const approval = interrupts.find((i) => i.kind === "approval");
    expect(question).toBeDefined();
    expect(approval).toBeDefined();

    await client.answer(question!.id, "Use approach B.");
    await client.answer(approval!.id, "Approved.");
    expect(client.graph.listOpenDecisions()).toHaveLength(0);
    expect(client.graph.getPendingReview().filter((p) => p.priority === "blocking" && p.needsReview)).toHaveLength(0);

    // Interrupts are emitted once, not re-fired on the next poll.
    expect((await client.poll()).map((i) => i.id)).not.toContain(question!.id);
    expect(decision.id).toBe(approval!.id);
  });

  it("sync-back announce comments on done; silent writes nothing", async () => {
    client = createWorkGraph();
    const announceLog = { comments: [] as string[], updates: [] as unknown[] };
    await client.connect(fakeProvider([preview("T-1", "Tracked bug")], announceLog), { syncBack: "announce" });
    await client.sync();
    const [item] = client.items({ status: "new" });

    client.graph.update(item.id, { status: "done" });
    await client.poll();
    expect(announceLog.comments).toHaveLength(1);
    expect(announceLog.comments[0]).toContain("done");
    expect(announceLog.updates).toHaveLength(0); // announce ≠ full: no status mutation

    // Receipt recorded on the card.
    const receipts = client.graph.getScratchpads(item.id).filter((p) => p.content.startsWith("synced_back:"));
    expect(receipts).toHaveLength(1);

    // Silent connection: nothing written back.
    const silentLog = { comments: [] as string[], updates: [] as unknown[] };
    client.close();
    client = createWorkGraph();
    await client.connect(fakeProvider([preview("T-2", "Quiet bug")], silentLog), { syncBack: "silent" });
    await client.sync();
    const [quiet] = client.items({ status: "new" });
    client.graph.update(quiet.id, { status: "done" });
    await client.poll();
    expect(silentLog.comments).toHaveLength(0);
  });

  it("github() factory wires the real adapter: sync-back announce posts the GitHub comment", async () => {
    const requests: GitHubProxyRequest[] = [];
    const executor = {
      proxy: async (request: GitHubProxyRequest): Promise<GitHubProxyResponse> => {
        requests.push(request);
        return { data: {} };
      },
    };
    client = createWorkGraph();
    await client.connect(github({ executor }), { syncBack: "announce" });

    const item = client.graph.create({
      title: "GH bug",
      provider: "github",
      providerMeta: { owner: "acme", repo: "app", issueNumber: 7 },
      providerUrl: "https://github.com/acme/app/issues/7",
    });
    client.graph.update(item.id, { status: "done" });
    await client.poll();

    const comment = requests.find(
      (request) => request.method === "POST" && request.endpoint === "/repos/acme/app/issues/7/comments",
    );
    expect(comment).toBeDefined();
    expect((comment!.body as { body: string }).body).toContain("done");
  });

  it("mirrors closed provider items as done (not new)", async () => {
    client = createWorkGraph();
    const log = { comments: [] as string[], updates: [] as unknown[] };
    const closed = { ...preview("T-C", "Closed upstream"), status: "closed" as const };
    await client.connect(fakeProvider([closed], log));
    await client.sync();

    expect(client.items({ status: "new" })).toHaveLength(0);
    expect(client.items({ status: "done" }).map((item) => item.title)).toEqual(["Closed upstream"]);
  });

  it("restart durability: interrupts and sync-back announces fire exactly once per db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wgclient-"));
    const dbPath = join(dir, "wg.db");
    try {
      const log = { comments: [] as string[], updates: [] as unknown[] };
      let c = createWorkGraph({ db: dbPath });
      client = c;
      await c.connect(fakeProvider([preview("T-1", "Tracked bug")], log), { syncBack: "announce" });
      await c.sync();
      const [item] = c.items({ status: "new" });
      c.graph.update(item.id, { status: "done" });

      const first = await c.poll();
      expect(first.some((i) => i.kind === "review" && i.itemId === item.id)).toBe(true);
      expect(log.comments).toHaveLength(1);
      c.close();

      // Same db file, fresh process: nothing re-fires.
      c = createWorkGraph({ db: dbPath });
      client = c;
      await c.connect(fakeProvider([preview("T-1", "Tracked bug")], log), { syncBack: "announce" });
      const second = await c.poll();
      expect(second.filter((i) => i.kind === "review")).toHaveLength(0);
      expect(log.comments).toHaveLength(1);
    } finally {
      client?.close();
      client = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
