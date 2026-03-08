import { describe, it, expect } from "bun:test";
import { checkQuality, defaultRubric, type QualityRubric } from "../src/quality-gate";
import type { EvidenceLink } from "../src/capabilities";

describe("Quality Gate", () => {
  it("should pass when all nodes have results and decisions have evidence", () => {
    const result = checkQuality(
      [
        { name: "Node A", result: "Done" },
        { name: "Node B", result: "Complete" },
      ],
      [
        {
          proposal: "Use TypeScript",
          evidence: [{ type: "decision", description: "Industry standard" }],
        },
      ]
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it("should fail when a node has empty result", () => {
    const result = checkQuality(
      [
        { name: "Node A", result: "Done" },
        { name: "Node B", result: "" },
      ],
      []
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('Node "Node B" has empty result');
  });

  it("should fail when a node has whitespace-only result", () => {
    const result = checkQuality(
      [{ name: "Node A", result: "   " }],
      []
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain('Node "Node A" has empty result');
  });

  it("should fail when a decision has no evidence", () => {
    const result = checkQuality(
      [{ name: "Node A", result: "Done" }],
      [{ proposal: "Use React", evidence: [] }]
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Decision "Use React" has insufficient evidence (0/1)'
    );
  });

  it("should enforce minEvidencePerDecision from custom rubric", () => {
    const rubric: QualityRubric = {
      requireEvidence: true,
      requireNodeResults: true,
      minEvidencePerDecision: 3,
      requireSourceLinks: false,
    };
    const result = checkQuality(
      [{ name: "Node A", result: "Done" }],
      [
        {
          proposal: "Use GraphQL",
          evidence: [
            { type: "document", description: "Spec doc" },
            { type: "decision", description: "Team vote" },
          ],
        },
      ],
      rubric
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Decision "Use GraphQL" has insufficient evidence (2/3)'
    );
  });

  it("should calculate correct score", () => {
    const result = checkQuality(
      [
        { name: "Node A", result: "Done" },
        { name: "Node B", result: "" },
        { name: "Node C", result: "OK" },
        { name: "Node D", result: "" },
      ],
      []
    );
    // 4 checks, 2 passed
    expect(result.score).toBe(0.5);
    expect(result.violations).toHaveLength(2);
  });

  it("should return score 1 when no checks apply", () => {
    const rubric: QualityRubric = {
      requireEvidence: false,
      requireNodeResults: false,
      minEvidencePerDecision: 0,
      requireSourceLinks: false,
    };
    const result = checkQuality([], [], rubric);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("should use default rubric values", () => {
    expect(defaultRubric.requireEvidence).toBe(true);
    expect(defaultRubric.requireNodeResults).toBe(true);
    expect(defaultRubric.minEvidencePerDecision).toBe(1);
    expect(defaultRubric.requireSourceLinks).toBe(false);
  });

  it("should check source links when requireSourceLinks is true", () => {
    const rubric: QualityRubric = {
      requireEvidence: true,
      requireNodeResults: false,
      minEvidencePerDecision: 1,
      requireSourceLinks: true,
    };
    const result = checkQuality(
      [],
      [
        {
          proposal: "External API",
          evidence: [
            { type: "external", description: "API docs" } as EvidenceLink,
          ],
        },
      ],
      rubric
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContain(
      'Evidence "API docs" missing URL for type external'
    );
  });

  it("should pass source link check when URL is provided", () => {
    const rubric: QualityRubric = {
      requireEvidence: true,
      requireNodeResults: false,
      minEvidencePerDecision: 1,
      requireSourceLinks: true,
    };
    const result = checkQuality(
      [],
      [
        {
          proposal: "External API",
          evidence: [
            {
              type: "external",
              description: "API docs",
              url: "https://example.com/docs",
            } as EvidenceLink,
          ],
        },
      ],
      rubric
    );
    expect(result.passed).toBe(true);
  });
});
