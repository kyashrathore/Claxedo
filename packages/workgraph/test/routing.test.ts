import { describe, it, expect } from "bun:test";
import {
  resolveRoute,
  previewRoutes,
  routeWithFallback,
  type CapabilityDescription,
  type RouteConfig,
} from "../src/routing";

describe("Routing Scorer", () => {
  const capabilities: CapabilityDescription[] = [
    { id: "frontend", description: "Handles browser UI, React, SolidJS, HTML and CSS." },
    { id: "backend", description: "Handles API endpoints, databases, SQL, and server logic." },
    { id: "researcher", description: "Handles reading documentation, web searching, and summarizing." }
  ];

  it("should select frontend for a UI task", async () => {
    // In TDD we mock the LLM or scoring algorithm.
    // Here we assume a simple keyword heuristic for testing the interface.
    const result = await resolveRoute(
      "Fix the red button on the login screen using CSS",
      capabilities
    );
    expect(result.selected_id).toBe("frontend");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should select backend for an API database task", async () => {
    const result = await resolveRoute(
      "Create a new SQL table for user sessions and add a POST endpoint",
      capabilities
    );
    expect(result.selected_id).toBe("backend");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should fallback or have low confidence for ambiguous tasks", async () => {
    const result = await resolveRoute(
      "Do some stuff",
      capabilities
    );
    // Depending on policy, might fallback or return null/low confidence
    expect(result.confidence).toBeLessThan(0.3);
  });

  it("should select researcher for research/documentation tasks", async () => {
    const result = await resolveRoute(
      "Research the best practices and document the findings",
      capabilities
    );
    expect(result.selected_id).toBe("researcher");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should handle test/qa keywords", async () => {
    const capsWithQA: CapabilityDescription[] = [
      ...capabilities,
      { id: "qa", description: "Handles testing, QA, test coverage, and quality assurance." }
    ];
    const result = await resolveRoute(
      "Write unit tests for the user service and check test coverage",
      capsWithQA
    );
    expect(result.selected_id).toBe("qa");
    expect(result.confidence).toBeGreaterThan(0.5);
  });
});

describe("previewRoutes", () => {
  const capabilities: CapabilityDescription[] = [
    { id: "frontend", description: "Handles browser UI, React, SolidJS, HTML and CSS." },
    { id: "backend", description: "Handles API endpoints, databases, SQL, and server logic." },
    { id: "researcher", description: "Handles reading documentation, web searching, and summarizing." }
  ];

  it("should return all capabilities with scores", async () => {
    const results = await previewRoutes(
      "Fix the red button using CSS",
      capabilities
    );
    expect(results).toHaveLength(3);
    // Each entry should have id and confidence
    for (const r of results) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.confidence).toBe("number");
    }
  });

  it("should return results sorted by confidence descending", async () => {
    const results = await previewRoutes(
      "Fix the red button using CSS",
      capabilities
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).toBeGreaterThanOrEqual(results[i].confidence);
    }
  });

  it("should have frontend as top result for CSS task", async () => {
    const results = await previewRoutes(
      "Fix the red button using CSS",
      capabilities
    );
    expect(results[0].id).toBe("frontend");
    expect(results[0].confidence).toBeGreaterThan(0);
  });

  it("should return zero confidence for unmatched capabilities", async () => {
    const results = await previewRoutes(
      "Do some random stuff",
      capabilities
    );
    // All should be 0 for ambiguous goal
    for (const r of results) {
      expect(r.confidence).toBe(0);
    }
  });
});

describe("routeWithFallback", () => {
  const capabilities: CapabilityDescription[] = [
    { id: "frontend", description: "Handles browser UI, React, SolidJS, HTML and CSS." },
    { id: "backend", description: "Handles API endpoints, databases, SQL, and server logic." },
    { id: "researcher", description: "Handles reading documentation, web searching, and summarizing." }
  ];

  it("should return best route when above minConfidence", async () => {
    const result = await routeWithFallback(
      "Fix the red button using CSS",
      capabilities,
      { minConfidence: 0.55, fallbackTeamId: "general" }
    );
    expect(result.selected_id).toBe("frontend");
    expect(result.confidence).toBeGreaterThan(0.55);
  });

  it("should use fallback when confidence is below threshold", async () => {
    const result = await routeWithFallback(
      "Do some random stuff",
      capabilities,
      { minConfidence: 0.55, fallbackTeamId: "general" }
    );
    expect(result.selected_id).toBe("general");
    expect(result.confidence).toBe(0.55);
  });

  it("should return original low confidence when no fallback configured", async () => {
    const result = await routeWithFallback(
      "Do some random stuff",
      capabilities,
      { minConfidence: 0.55 }
    );
    expect(result.selected_id).toBeNull();
    expect(result.confidence).toBeLessThan(0.3);
  });

  it("should respect custom minConfidence threshold", async () => {
    // With a very high threshold, even good matches should fall through to fallback
    const result = await routeWithFallback(
      "Fix the red button using CSS",
      capabilities,
      { minConfidence: 0.99, fallbackTeamId: "general" }
    );
    expect(result.selected_id).toBe("general");
    expect(result.confidence).toBe(0.55);
  });

  it("should use default minConfidence of 0.55 when no config", async () => {
    // CSS task matches frontend with high confidence — no fallback needed
    const result = await routeWithFallback(
      "Fix the button using CSS",
      capabilities
    );
    expect(result.selected_id).toBe("frontend");
    expect(result.confidence).toBeGreaterThan(0.5);
  });
});
