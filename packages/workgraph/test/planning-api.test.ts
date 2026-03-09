import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp, initializeDb } from "../src/app";
import type { Hono } from "hono";

describe("Planning API", () => {
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
      body: JSON.stringify({ goal: "Planning test" }),
    });
    const body = await res.json();
    runId = body.run_id;
  });

  describe("POST /runs/:run_id/plan", () => {
    it("should create a plan and return 201", async () => {
      const res = await app.request(`/runs/${runId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Build a UI with api and database" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();

      expect(body.runId).toBe(runId);
      expect(Array.isArray(body.questions)).toBe(true);
      expect(body.questions.length).toBeGreaterThan(0);
      expect(body.maxQuestions).toBe(7);
    });

    it("should return 400 when goal is missing", async () => {
      const res = await app.request(`/runs/${runId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("should generate questions based on goal keywords", async () => {
      const res = await app.request(`/runs/${runId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Build a frontend UI" }),
      });

      const body = await res.json();
      const scopes = body.questions.map((q: any) => q.scope);
      expect(scopes).toContain("frontend");
      expect(scopes).toContain("general"); // Always included
    });
  });

  describe("GET /runs/:run_id/plan", () => {
    it("should return 404 if no plan exists", async () => {
      const res = await app.request(`/runs/${runId}/plan`);
      expect(res.status).toBe(404);
    });

    it("should return the plan after creation", async () => {
      // Create a plan first
      await app.request(`/runs/${runId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Design an api" }),
      });

      const res = await app.request(`/runs/${runId}/plan`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.runId).toBe(runId);
      expect(body.questions.length).toBeGreaterThan(0);
    });
  });

  describe("POST /runs/:run_id/routes/preview", () => {
    it("should return scored capabilities", async () => {
      const res = await app.request(`/runs/${runId}/routes/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: "Build frontend components",
          capabilities: [
            { id: "team_frontend", description: "Frontend UI development" },
            { id: "team_backend", description: "Backend API development" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body[0]).toHaveProperty("id");
      expect(body[0]).toHaveProperty("confidence");
      // Scores should be sorted descending
      expect(body[0].confidence).toBeGreaterThanOrEqual(body[1].confidence);
    });

    it("should return 400 when body is invalid", async () => {
      const res = await app.request(`/runs/${runId}/routes/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "test" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /runs/:run_id/dispatch", () => {
    it("should dispatch questions from the plan", async () => {
      // Create a plan first
      await app.request(`/runs/${runId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Build a backend api with tests" }),
      });

      const res = await app.request(`/runs/${runId}/dispatch`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await res.json();

      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty("questionId");
      expect(body[0]).toHaveProperty("scope");
      expect(body[0].ready).toBe(true);
    });

    it("should return 404 if no plan exists", async () => {
      const res = await app.request(`/runs/${runId}/dispatch`, {
        method: "POST",
      });

      expect(res.status).toBe(404);
    });
  });
});
