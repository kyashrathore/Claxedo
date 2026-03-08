import type { EnhancedReportData, EvidenceLink } from "../markdown";

export interface HtmlBriefOptions {
  includeStyles?: boolean;
  failOnIncompleteEvidence?: boolean;
}

export interface HtmlBriefResult {
  html: string;
  valid: boolean;
  missingEvidence: string[];
}

export function renderHtmlBrief(
  data: EnhancedReportData,
  options?: HtmlBriefOptions
): HtmlBriefResult {
  const missingEvidence: string[] = [];
  const failOnIncomplete = options?.failOnIncompleteEvidence ?? true;

  // Check evidence completeness
  if (data.decisions) {
    for (const d of data.decisions) {
      if (!d.evidence.length) {
        missingEvidence.push(`Decision "${d.proposal}" has no evidence`);
      }
    }
  }

  for (const node of data.nodes) {
    if (!node.result || node.result.trim() === "") {
      missingEvidence.push(`Node "${node.name}" has empty result`);
    }
  }

  const valid = !failOnIncomplete || missingEvidence.length === 0;

  // Build HTML
  let html = "";
  if (options?.includeStyles !== false) {
    html += `<style>
  .brief { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
  .brief h1 { border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
  .brief .node { margin: 1rem 0; padding: 1rem; border-left: 3px solid #4a9eff; background: #f8f9fa; }
  .brief .decision { margin: 1rem 0; padding: 1rem; border-left: 3px solid #28a745; background: #f0fff4; }
  .brief .decision.challenged { border-color: #ffc107; background: #fffdf0; }
  .brief .decision.rejected { border-color: #dc3545; background: #fff5f5; }
  .brief .evidence { font-size: 0.9em; color: #666; }
  .brief .evidence a { color: #4a9eff; }
  .brief .metadata { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: 0.85em; color: #888; }
  .brief .warning { color: #dc3545; font-weight: bold; }
</style>\n`;
  }

  html += `<div class="brief">\n`;
  html += `<h1>${escapeHtml(data.title)}</h1>\n`;

  if (!valid) {
    html += `<p class="warning">⚠ Evidence incomplete — ${missingEvidence.length} issue(s) found</p>\n`;
  }

  // Nodes
  for (const node of data.nodes) {
    html += `<div class="node">\n`;
    html += `  <h2>${escapeHtml(node.name)}</h2>\n`;
    html += `  <p>${escapeHtml(node.result)}</p>\n`;
    html += `</div>\n`;
  }

  // Decisions
  if (data.decisions?.length) {
    html += `<h2>Decisions</h2>\n`;
    for (const d of data.decisions) {
      const statusClass =
        d.status === "challenged"
          ? " challenged"
          : d.status === "rejected"
            ? " rejected"
            : "";
      html += `<div class="decision${statusClass}">\n`;
      html += `  <h3>${escapeHtml(d.proposal)}</h3>\n`;
      html += `  <p><strong>Status:</strong> ${escapeHtml(d.status)}</p>\n`;
      if (d.evidence.length) {
        html += `  <div class="evidence">\n`;
        for (const e of d.evidence) {
          html += `    <p>• ${escapeHtml(e.description)}`;
          if (e.url) html += ` (<a href="${escapeHtml(e.url)}">source</a>)`;
          html += `</p>\n`;
        }
        html += `  </div>\n`;
      }
      html += `</div>\n`;
    }
  }

  // Evidence trail
  if (data.evidence?.length) {
    html += `<h2>Evidence Trail</h2>\n`;
    html += `<ul>\n`;
    for (const e of data.evidence) {
      html += `  <li class="evidence"><strong>[${escapeHtml(e.type)}]</strong> ${escapeHtml(e.description)}`;
      if (e.url) html += ` — <a href="${escapeHtml(e.url)}">link</a>`;
      html += `</li>\n`;
    }
    html += `</ul>\n`;
  }

  // Metadata
  if (data.metadata) {
    html += `<div class="metadata">\n`;
    html += `  <p>Generated: ${data.metadata.generatedAt || new Date().toISOString()}</p>\n`;
    if (data.metadata.totalNodes) {
      html += `  <p>Nodes: ${data.metadata.completedNodes || 0}/${data.metadata.totalNodes} completed</p>\n`;
    }
    html += `</div>\n`;
  }

  html += `</div>\n`;

  return { html, valid, missingEvidence };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
