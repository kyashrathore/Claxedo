import { describe, it, expect, beforeEach } from "bun:test";
import { PlanningService } from "../src/orchestrator/core/services/planning";

describe("PlanningService", () => {
  let planning: PlanningService;

  beforeEach(() => {
    planning = new PlanningService();
  });

  describe("decompose", () => {
    it("should generate frontend questions for UI-related goals", () => {
      const questions = planning.decompose("Build a UI dashboard");
      const scopes = questions.map((q) => q.scope);
      expect(scopes).toContain("frontend");
    });

    it("should generate backend questions for API-related goals", () => {
      const questions = planning.decompose("Create API endpoints for users");
      const scopes = questions.map((q) => q.scope);
      expect(scopes).toContain("backend");
    });

    it("should generate data questions for database-related goals", () => {
      const questions = planning.decompose("Design database schema");
      const scopes = questions.map((q) => q.scope);
      expect(scopes).toContain("data");
    });

    it("should generate testing questions for test-related goals", () => {
      const questions = planning.decompose("Write test coverage for auth");
      const scopes = questions.map((q) => q.scope);
      expect(scopes).toContain("testing");
    });

    it("should generate infra questions for deploy-related goals", () => {
      const questions = planning.decompose("Deploy to infrastructure");
      const scopes = questions.map((q) => q.scope);
      expect(scopes).toContain("infra");
    });

    it("should always include a general question", () => {
      const questions = planning.decompose("Do something random");
      const scopes = questions.map((q) => q.scope);
      expect(scopes).toContain("general");
    });

    it("should generate multiple questions for complex goals", () => {
      const questions = planning.decompose(
        "Build a frontend UI with backend API and database schema, write tests, and deploy to infrastructure"
      );
      expect(questions.length).toBeGreaterThan(3);
    });

    it("should respect max questions limit", () => {
      const limited = new PlanningService(3);
      const questions = limited.decompose(
        "Build a frontend UI with backend API and database schema, write tests, and deploy to infrastructure"
      );
      expect(questions.length).toBeLessThanOrEqual(3);
    });

    it("should not exceed 7 questions by default", () => {
      const questions = planning.decompose(
        "Build a frontend UI with backend API and database schema, write tests, and deploy to infrastructure"
      );
      expect(questions.length).toBeLessThanOrEqual(7);
    });

    it("should assign unique IDs to questions", () => {
      const questions = planning.decompose("Build a UI with api and test");
      const ids = questions.map((q) => q.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("plan", () => {
    it("should create a plan with runId and questions", () => {
      const plan = planning.plan("run_1", "Build an API server");
      expect(plan.runId).toBe("run_1");
      expect(plan.questions.length).toBeGreaterThan(0);
      expect(plan.maxQuestions).toBe(7);
    });

    it("should include the run ID in the plan", () => {
      const plan = planning.plan("run_abc", "Some goal");
      expect(plan.runId).toBe("run_abc");
    });
  });

  describe("dispatch", () => {
    it("should mark all questions as ready", () => {
      const plan = planning.plan("run_1", "Build a frontend UI");
      const dispatched = planning.dispatch(plan);

      expect(dispatched.length).toBe(plan.questions.length);
      for (const item of dispatched) {
        expect(item.ready).toBe(true);
      }
    });

    it("should include questionId and scope in each dispatch item", () => {
      const plan = planning.plan("run_1", "Design database schema");
      const dispatched = planning.dispatch(plan);

      for (const item of dispatched) {
        expect(item).toHaveProperty("questionId");
        expect(item).toHaveProperty("scope");
        expect(typeof item.questionId).toBe("string");
        expect(typeof item.scope).toBe("string");
      }
    });

    it("should match question IDs from the plan", () => {
      const plan = planning.plan("run_1", "Build API with tests");
      const dispatched = planning.dispatch(plan);

      const planIds = plan.questions.map((q) => q.id);
      const dispatchIds = dispatched.map((d) => d.questionId);
      expect(dispatchIds).toEqual(planIds);
    });
  });
});
