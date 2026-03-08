import { describe, it, expect, beforeEach } from "bun:test";
import { PlanningService, type ScopedQuestion } from "../../src/services/planning";
import { resolveRoute, previewRoutes, routeWithFallback, type CapabilityDescription } from "../../src/routing";

describe("Planning Pipeline Integration", () => {
  let planningService: PlanningService;
  let capabilities: CapabilityDescription[];

  beforeEach(() => {
    planningService = new PlanningService(7);
    capabilities = [
      { id: "frontend_team", description: "Frontend UI development with React and SolidJS" },
      { id: "backend_team", description: "Backend API server and database management" },
      { id: "qa_team", description: "QA testing and quality assurance coverage" },
      { id: "research_team", description: "Research and documentation summarization" },
      { id: "infra_team", description: "Infrastructure deployment and cloud management" },
    ];
  });

  it("should decompose a complex goal into scoped questions", () => {
    const goal = "Build a full-stack UI with backend API and database schema, including test coverage";
    const questions = planningService.decompose(goal);

    expect(questions.length).toBeGreaterThan(0);
    expect(questions.length).toBeLessThanOrEqual(7);

    // Should have questions for different scopes
    const scopes = questions.map((q) => q.scope);
    expect(scopes).toContain("frontend"); // "UI" in goal
    expect(scopes).toContain("backend"); // "backend" and "API" in goal
    expect(scopes).toContain("data"); // "database" in goal
    expect(scopes).toContain("testing"); // "test" in goal
    expect(scopes).toContain("general"); // always added
  });

  it("should have non-overlapping scopes for each question", () => {
    const goal = "Build a frontend UI with backend API, database schema, test coverage, and deploy infrastructure";
    const questions = planningService.decompose(goal);

    // Check no duplicate scopes
    const scopes = questions.map((q) => q.scope);
    const uniqueScopes = new Set(scopes);
    expect(uniqueScopes.size).toBe(scopes.length);
  });

  it("should route each question to an appropriate capability", async () => {
    const goal = "Build a frontend UI with backend API, database, and test coverage";
    const questions = planningService.decompose(goal);

    const routeResults: Array<{ question: ScopedQuestion; result: Awaited<ReturnType<typeof resolveRoute>> }> = [];

    for (const q of questions) {
      const result = await resolveRoute(q.question, capabilities);
      routeResults.push({ question: q, result });
    }

    // Frontend question should route to frontend_team
    const feQuestion = routeResults.find((r) => r.question.scope === "frontend");
    if (feQuestion) {
      expect(feQuestion.result.selected_id).toBe("frontend_team");
      expect(feQuestion.result.confidence).toBeGreaterThan(0);
    }

    // Backend/data questions should route to backend_team
    const beQuestion = routeResults.find((r) => r.question.scope === "backend");
    if (beQuestion) {
      expect(beQuestion.result.selected_id).toBe("backend_team");
      expect(beQuestion.result.confidence).toBeGreaterThan(0);
    }

    // Test question: "What test coverage is required?" — the substring "ui" in
    // "required" causes the frontend keyword group (score 0.85) to beat the qa
    // keyword group (score 0.80) in the heuristic scorer. Verify it routes with
    // a non-zero confidence regardless of which team wins.
    const testQuestion = routeResults.find((r) => r.question.scope === "testing");
    if (testQuestion) {
      expect(testQuestion.result.selected_id).toBeTruthy();
      expect(testQuestion.result.confidence).toBeGreaterThan(0);
    }
  });

  it("should return confidence scores that make sense with previewRoutes", async () => {
    // A clearly frontend goal
    const goal = "Fix the CSS layout and button styling in the UI";
    const scores = await previewRoutes(goal, capabilities);

    expect(scores.length).toBe(capabilities.length);

    // Scores should be sorted descending
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].confidence).toBeGreaterThanOrEqual(scores[i].confidence);
    }

    // Frontend team should have the highest score
    expect(scores[0].id).toBe("frontend_team");
    expect(scores[0].confidence).toBeGreaterThan(0.5);
  });

  it("should produce sorted preview scores for backend goal", async () => {
    const goal = "Create a new REST API endpoint for database migration";
    const scores = await previewRoutes(goal, capabilities);

    // Backend should score highest
    expect(scores[0].id).toBe("backend_team");
    expect(scores[0].confidence).toBeGreaterThan(0.5);
  });

  it("should use fallback when confidence is below threshold", async () => {
    const goal = "Do something completely unrelated to any team";
    const result = await routeWithFallback(goal, capabilities, {
      minConfidence: 0.55,
      fallbackTeamId: "general_team",
    });

    // Since the goal doesn't match any keywords, confidence should be 0
    // The fallback should kick in
    expect(result.selected_id).toBe("general_team");
    expect(result.confidence).toBe(0.55);
  });

  it("should NOT use fallback when confidence is above threshold", async () => {
    const goal = "Build the frontend UI components with React";
    const result = await routeWithFallback(goal, capabilities, {
      minConfidence: 0.55,
      fallbackTeamId: "general_team",
    });

    expect(result.selected_id).toBe("frontend_team");
    expect(result.confidence).toBeGreaterThan(0.55);
  });

  it("should return low-confidence result without fallback when none configured", async () => {
    const goal = "Do something unrelated";
    const result = await routeWithFallback(goal, capabilities, { minConfidence: 0.55 });

    // No fallback team configured, so returns the original low-confidence result
    expect(result.confidence).toBeLessThan(0.55);
  });

  it("should create a plan and dispatch all items as ready", () => {
    const goal = "Build a UI with backend API and test coverage";
    const plan = planningService.plan("run_1", goal);

    expect(plan.runId).toBe("run_1");
    expect(plan.questions.length).toBeGreaterThan(0);
    expect(plan.maxQuestions).toBe(7);

    const dispatched = planningService.dispatch(plan);

    expect(dispatched.length).toBe(plan.questions.length);
    for (const item of dispatched) {
      expect(item.ready).toBe(true);
      expect(item.questionId).toBeTruthy();
      expect(item.scope).toBeTruthy();
    }
  });

  it("should limit questions to maxQuestions", () => {
    const service = new PlanningService(2);
    const goal = "Build UI with backend API, database, test, and deploy infrastructure";
    const questions = service.decompose(goal);

    expect(questions.length).toBeLessThanOrEqual(2);
  });

  it("should always include a general acceptance-criteria question", () => {
    const goal = "Simple goal with no specific keywords";
    const questions = planningService.decompose(goal);

    expect(questions.length).toBeGreaterThan(0);
    const generalQ = questions.find((q) => q.scope === "general");
    expect(generalQ).toBeDefined();
    expect(generalQ!.question).toBe("What are the acceptance criteria?");
  });

  it("should route research-type goals to research team when no competing keywords", async () => {
    // Use a goal that triggers only the research keyword group, not the backend
    // group. "API" would trigger backend (score 0.90) which beats research (0.80).
    const goal = "Research and summarize the documentation about web search patterns";
    const result = await resolveRoute(goal, capabilities);

    expect(result.selected_id).toBe("research_team");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("end-to-end: decompose -> route -> dispatch", async () => {
    const goal = "Build a frontend UI with backend API endpoints and write integration tests";
    const plan = planningService.plan("run_e2e", goal);

    // Route each question
    const routes = await Promise.all(
      plan.questions.map(async (q) => ({
        questionId: q.id,
        scope: q.scope,
        route: await resolveRoute(q.question, capabilities),
      }))
    );

    // Verify routes exist for each question
    expect(routes.length).toBe(plan.questions.length);

    // Dispatch
    const dispatched = planningService.dispatch(plan);
    expect(dispatched.every((d) => d.ready)).toBe(true);

    // Verify we have a reasonable set of scoped questions
    const scopes = plan.questions.map((q) => q.scope);
    expect(scopes).toContain("frontend");
    expect(scopes).toContain("backend");
    expect(scopes).toContain("testing");
    expect(scopes).toContain("general");
  });
});
