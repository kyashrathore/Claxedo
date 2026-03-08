import { describe, it, expect } from "bun:test";
import { renderHtmlBrief } from "../src/html-renderer";
import type { EnhancedReportData } from "@opencode-ai/renderer-markdown";

describe("HTML Brief Renderer", () => {
  const completeData: EnhancedReportData = {
    title: "Test Report",
    nodes: [
      { name: "Research", result: "Found key insights." },
      { name: "Implementation", result: "Code written and tested." },
    ],
    decisions: [
      {
        id: "d1",
        proposal: "Use event sourcing",
        status: "accepted",
        evidence: [
          { type: "document", description: "Architecture review", url: "https://example.com/arch" },
        ],
      },
    ],
    evidence: [
      { type: "source_code", description: "Core module", url: "https://github.com/repo/core.ts" },
    ],
    metadata: {
      runId: "run-1",
      generatedAt: "2026-02-23T12:00:00Z",
      totalNodes: 2,
      completedNodes: 2,
    },
  };

  it("should produce valid HTML structure", () => {
    const result = renderHtmlBrief(completeData);
    expect(result.html).toContain('<div class="brief">');
    expect(result.html).toContain("<h1>");
    expect(result.html).toContain("Test Report");
    expect(result.html).toContain("</div>");
    expect(result.valid).toBe(true);
    expect(result.missingEvidence).toHaveLength(0);
  });

  it("should include styles by default", () => {
    const result = renderHtmlBrief(completeData);
    expect(result.html).toContain("<style>");
    expect(result.html).toContain(".brief");
  });

  it("should exclude styles when includeStyles is false", () => {
    const result = renderHtmlBrief(completeData, { includeStyles: false });
    expect(result.html).not.toContain("<style>");
  });

  it("should fail closed when evidence is incomplete (default)", () => {
    const incompleteData: EnhancedReportData = {
      title: "Incomplete Report",
      nodes: [
        { name: "Research", result: "Done" },
        { name: "Empty Node", result: "" },
      ],
      decisions: [
        { id: "d1", proposal: "Untested decision", status: "proposed", evidence: [] },
      ],
    };
    const result = renderHtmlBrief(incompleteData);
    expect(result.valid).toBe(false);
    expect(result.missingEvidence.length).toBeGreaterThan(0);
    expect(result.missingEvidence).toContain('Decision "Untested decision" has no evidence');
    expect(result.missingEvidence).toContain('Node "Empty Node" has empty result');
    expect(result.html).toContain("Evidence incomplete");
  });

  it("should fail closed with failOnIncompleteEvidence: true", () => {
    const data: EnhancedReportData = {
      title: "Report",
      nodes: [{ name: "Broken", result: "" }],
    };
    const result = renderHtmlBrief(data, { failOnIncompleteEvidence: true });
    expect(result.valid).toBe(false);
    expect(result.missingEvidence).toContain('Node "Broken" has empty result');
  });

  it("should pass when evidence is complete", () => {
    const result = renderHtmlBrief(completeData);
    expect(result.valid).toBe(true);
    expect(result.missingEvidence).toHaveLength(0);
  });

  it("should allow incomplete evidence when failOnIncompleteEvidence is false", () => {
    const incompleteData: EnhancedReportData = {
      title: "Lenient Report",
      nodes: [{ name: "Empty", result: "" }],
    };
    const result = renderHtmlBrief(incompleteData, { failOnIncompleteEvidence: false });
    expect(result.valid).toBe(true);
    expect(result.missingEvidence).toHaveLength(1); // still reported, just not blocking
  });

  it("should render node content in HTML", () => {
    const result = renderHtmlBrief(completeData);
    expect(result.html).toContain('<div class="node">');
    expect(result.html).toContain("Research");
    expect(result.html).toContain("Found key insights.");
  });

  it("should render decisions with status classes", () => {
    const data: EnhancedReportData = {
      title: "Status Report",
      nodes: [{ name: "N", result: "OK" }],
      decisions: [
        { id: "d1", proposal: "Challenged idea", status: "challenged", evidence: [{ type: "decision", description: "Debate" }] },
        { id: "d2", proposal: "Rejected plan", status: "rejected", evidence: [{ type: "decision", description: "Vote" }] },
        { id: "d3", proposal: "Accepted plan", status: "accepted", evidence: [{ type: "decision", description: "Consensus" }] },
      ],
    };
    const result = renderHtmlBrief(data);
    expect(result.html).toContain('class="decision challenged"');
    expect(result.html).toContain('class="decision rejected"');
    expect(result.html).toContain('class="decision"');
  });

  it("should render evidence trail", () => {
    const result = renderHtmlBrief(completeData);
    expect(result.html).toContain("Evidence Trail");
    expect(result.html).toContain("[source_code]");
    expect(result.html).toContain("Core module");
    expect(result.html).toContain('href="https://github.com/repo/core.ts"');
  });

  it("should render metadata", () => {
    const result = renderHtmlBrief(completeData);
    expect(result.html).toContain("2026-02-23T12:00:00Z");
    expect(result.html).toContain("2/2 completed");
  });

  it("should escape HTML in content", () => {
    const data: EnhancedReportData = {
      title: "<script>alert('xss')</script>",
      nodes: [{ name: 'Node <b>"bold"</b>', result: "A & B > C" }],
    };
    const result = renderHtmlBrief(data);
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).not.toContain("<script>alert");
    expect(result.html).toContain("&amp; B &gt; C");
    expect(result.html).toContain("&lt;b&gt;&quot;bold&quot;&lt;/b&gt;");
  });

  it("should list all missing evidence items", () => {
    const data: EnhancedReportData = {
      title: "Multi-issue Report",
      nodes: [
        { name: "OK Node", result: "Fine" },
        { name: "Empty 1", result: "" },
        { name: "Empty 2", result: "  " },
      ],
      decisions: [
        { id: "d1", proposal: "No evidence decision", status: "proposed", evidence: [] },
      ],
    };
    const result = renderHtmlBrief(data);
    expect(result.missingEvidence).toHaveLength(3);
    expect(result.missingEvidence).toContain('Node "Empty 1" has empty result');
    expect(result.missingEvidence).toContain('Node "Empty 2" has empty result');
    expect(result.missingEvidence).toContain('Decision "No evidence decision" has no evidence');
  });
});
