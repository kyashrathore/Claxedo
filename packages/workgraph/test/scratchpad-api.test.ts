import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("Scratchpad API", () => {
  let db: InstanceType<typeof Database>;
  let app: Hono;
  let runId: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initializeDb(db);
    app = createApp(db);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "Scratchpad test" }),
    });
    const body = await res.json();
    runId = body.run_id;
  });

  describe("POST /runs/:run_id/scratchpad", () => {
    it("should create a scratchpad entry and return 201", async () => {
      const res = await app.request(`/runs/${runId}/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: "node_1",
          content: "Draft implementation notes",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();

      expect(body).toHaveProperty("id");
      expect(body.runId).toBe(runId);
      expect(body.nodeId).toBe("node_1");
      expect(body.content).toBe("Draft implementation notes");
      expect(body).toHaveProperty("createdAt");
      expect(body).toHaveProperty("expiresAt");
      expect(body.sizeBytes).toBeGreaterThan(0);
    });

    it("should return 400 when content is missing", async () => {
      const res = await app.request(`/runs/${runId}/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: "node_1" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /runs/:run_id/scratchpad", () => {
    it("should return all entries for a run", async () => {
      // Create two entries
      await app.request(`/runs/${runId}/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: "node_1", content: "First draft" }),
      });

      await app.request(`/runs/${runId}/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: "node_2", content: "Second draft" }),
      });

      const res = await app.request(`/runs/${runId}/scratchpad`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
    });

    it("should return empty array for run with no entries", async () => {
      const res = await app.request(`/runs/${runId}/scratchpad`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual([]);
    });
  });

  describe("POST /runs/:run_id/scratchpad/:entry_id/promote", () => {
    it("should promote an entry to artifact", async () => {
      // Create an entry
      const createRes = await app.request(`/runs/${runId}/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: "node_1",
          content: "Final implementation",
        }),
      });
      const entry = await createRes.json();

      // Promote it
      const promoteRes = await app.request(
        `/runs/${runId}/scratchpad/${entry.id}/promote`,
        { method: "POST" }
      );

      expect(promoteRes.status).toBe(200);
      const body = await promoteRes.json();

      expect(body.entry).toHaveProperty("id");
      expect(body.artifact).toHaveProperty("id");
      expect(body.artifact.content).toBe("Final implementation");
      expect(body.artifact.nodeId).toBe("node_1");
    });

    it("should return 404 for nonexistent entry", async () => {
      const res = await app.request(
        `/runs/${runId}/scratchpad/sp_nonexistent/promote`,
        { method: "POST" }
      );

      expect(res.status).toBe(404);
    });

    it("should remove entry from scratchpad after promote", async () => {
      // Create an entry
      const createRes = await app.request(`/runs/${runId}/scratchpad`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: "node_1",
          content: "To be promoted",
        }),
      });
      const entry = await createRes.json();

      // Promote it
      await app.request(`/runs/${runId}/scratchpad/${entry.id}/promote`, {
        method: "POST",
      });

      // Verify it's gone
      const listRes = await app.request(`/runs/${runId}/scratchpad`);
      const list = await listRes.json();
      expect(list.length).toBe(0);
    });
  });
});
