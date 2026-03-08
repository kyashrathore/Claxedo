export interface ReportData {
  title: string;
  nodes: {
    name: string;
    result: string;
  }[];
}

export interface EvidenceLink {
  type: string;
  description: string;
  url?: string;
  nodeId?: string;
  artifactId?: string;
}

export interface DecisionRecord {
  id: string;
  proposal: string;
  status: string;
  evidence: EvidenceLink[];
}

export interface EnhancedReportData extends ReportData {
  decisions?: DecisionRecord[];
  evidence?: EvidenceLink[];
  metadata?: {
    runId?: string;
    generatedAt?: string;
    totalNodes?: number;
    completedNodes?: number;
  };
}

export function renderMarkdown(data: ReportData): string {
  let markdown = `# ${data.title}\n\n`;

  for (const node of data.nodes) {
    markdown += `## ${node.name}\n`;
    markdown += `${node.result}\n\n`;
  }

  return markdown;
}

export function renderEnhancedMarkdown(data: EnhancedReportData): string {
  let md = renderMarkdown(data);

  if (data.decisions?.length) {
    md += "## Decisions\n\n";
    for (const d of data.decisions) {
      md += `### ${d.proposal}\n`;
      md += `**Status:** ${d.status}\n\n`;
      if (d.evidence.length) {
        md += "**Evidence:**\n";
        for (const e of d.evidence) {
          md += `- ${e.description}${e.url ? ` ([source](${e.url}))` : ""}\n`;
        }
        md += "\n";
      }
    }
  }

  if (data.evidence?.length) {
    md += "## Evidence Trail\n\n";
    for (const e of data.evidence) {
      md += `- **[${e.type}]** ${e.description}`;
      if (e.url) md += ` — [link](${e.url})`;
      if (e.nodeId) md += ` (node: ${e.nodeId})`;
      md += "\n";
    }
    md += "\n";
  }

  if (data.metadata) {
    md += "---\n";
    md += `*Generated: ${data.metadata.generatedAt || new Date().toISOString()}*\n`;
    if (data.metadata.totalNodes) {
      md += `*Nodes: ${data.metadata.completedNodes || 0}/${data.metadata.totalNodes} completed*\n`;
    }
  }

  return md;
}
