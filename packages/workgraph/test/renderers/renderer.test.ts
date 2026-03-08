import { describe, it, expect } from "bun:test";
import { renderMarkdown, renderEnhancedMarkdown } from "../src/renderer";
import type { EnhancedReportData } from "../src/renderer";

describe("Markdown Renderer", () => {
  it("should synthesize a valid markdown report given node results", () => {
    const data = {
      title: "Agent Teams Execution Report",
      nodes: [
        { name: "Frontend Setup", result: "Created login button CSS." },
        { name: "Backend DB", result: "Migrated users table." }
      ]
    };

    const report = renderMarkdown(data);

    expect(report).toContain("# Agent Teams Execution Report");
    expect(report).toContain("## Frontend Setup");
    expect(report).toContain("Created login button CSS.");
    expect(report).toContain("## Backend DB");
    expect(report).toContain("Migrated users table.");
  });
});

describe("Enhanced Markdown Renderer", () => {
  it("should include basic report content from renderMarkdown", () => {
    const data: EnhancedReportData = {
      title: "Test Report",
      nodes: [{ name: "Node A", result: "Result A" }],
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).toContain("# Test Report");
    expect(report).toContain("## Node A");
    expect(report).toContain("Result A");
  });

  it("should render decisions with evidence", () => {
    const data: EnhancedReportData = {
      title: "Decision Report",
      nodes: [{ name: "Node A", result: "Done" }],
      decisions: [
        {
          id: "d1",
          proposal: "Use TypeScript",
          status: "accepted",
          evidence: [
            { type: "document", description: "Type safety analysis", url: "https://example.com/ts" },
            { type: "decision", description: "Team consensus" },
          ],
        },
      ],
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).toContain("## Decisions");
    expect(report).toContain("### Use TypeScript");
    expect(report).toContain("**Status:** accepted");
    expect(report).toContain("**Evidence:**");
    expect(report).toContain("Type safety analysis");
    expect(report).toContain("[source](https://example.com/ts)");
    expect(report).toContain("Team consensus");
  });

  it("should render decisions without evidence", () => {
    const data: EnhancedReportData = {
      title: "Report",
      nodes: [],
      decisions: [
        {
          id: "d1",
          proposal: "Quick fix",
          status: "applied",
          evidence: [],
        },
      ],
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).toContain("### Quick fix");
    expect(report).toContain("**Status:** applied");
    expect(report).not.toContain("**Evidence:**");
  });

  it("should render evidence trail", () => {
    const data: EnhancedReportData = {
      title: "Evidence Report",
      nodes: [],
      evidence: [
        { type: "source_code", description: "Auth module", url: "https://github.com/repo/auth.ts", nodeId: "n1" },
        { type: "external", description: "RFC 7519" },
      ],
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).toContain("## Evidence Trail");
    expect(report).toContain("**[source_code]** Auth module");
    expect(report).toContain("[link](https://github.com/repo/auth.ts)");
    expect(report).toContain("(node: n1)");
    expect(report).toContain("**[external]** RFC 7519");
  });

  it("should render metadata section", () => {
    const data: EnhancedReportData = {
      title: "Meta Report",
      nodes: [],
      metadata: {
        runId: "run-123",
        generatedAt: "2026-02-23T10:00:00Z",
        totalNodes: 10,
        completedNodes: 7,
      },
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).toContain("---");
    expect(report).toContain("*Generated: 2026-02-23T10:00:00Z*");
    expect(report).toContain("*Nodes: 7/10 completed*");
  });

  it("should render metadata with default generatedAt when not provided", () => {
    const data: EnhancedReportData = {
      title: "Report",
      nodes: [],
      metadata: {},
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).toContain("---");
    expect(report).toContain("*Generated:");
  });

  it("should skip optional sections when not provided", () => {
    const data: EnhancedReportData = {
      title: "Minimal",
      nodes: [{ name: "Only Node", result: "Just this" }],
    };
    const report = renderEnhancedMarkdown(data);
    expect(report).not.toContain("## Decisions");
    expect(report).not.toContain("## Evidence Trail");
    expect(report).not.toContain("---");
  });

  it("should be backward compatible with renderMarkdown", () => {
    const data = {
      title: "Simple Report",
      nodes: [
        { name: "Step 1", result: "Done." },
        { name: "Step 2", result: "Also done." },
      ],
    };
    const basic = renderMarkdown(data);
    const enhanced = renderEnhancedMarkdown(data);
    // Enhanced with no extra data should match basic output
    expect(enhanced).toBe(basic);
  });
});
