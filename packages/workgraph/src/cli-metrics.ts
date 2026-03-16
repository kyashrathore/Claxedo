/**
 * CLI metrics formatter.
 * Reads RunMetrics from a completed run and formats them for terminal output.
 */

import type { RunMetrics } from "./orchestrator/executor";

export interface NodeSummary {
  title: string;
  status: "completed" | "failed" | "pending" | "active" | string;
  duration_ms?: number;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number | null): string {
  if (usd === null) return "unknown";
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(tokens: number | null): string {
  if (tokens === null) return "unknown";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function formatMetricsTable(metrics: RunMetrics): string {
  const lines: string[] = [
    `  Tasks:        ${metrics.completed_count} completed, ${metrics.failed_count} failed`,
    `  Max parallel: ${metrics.max_parallelism}`,
    `  Wall time:    ${fmtMs(metrics.wall_time_ms)}`,
    `  Tokens:       ${fmtTokens(metrics.total_tokens_used)}`,
    `  Cost est.:    ${fmtCost(metrics.estimated_cost_usd)}`,
  ];
  return lines.join("\n");
}

export function formatNodeStatus(nodes: NodeSummary[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const icon =
      node.status === "completed" ? "✓" :
      node.status === "failed" ? "✗" :
      node.status === "active" ? "→" :
      "·";
    const duration = node.duration_ms !== undefined ? `  ${fmtMs(node.duration_ms)}` : "";
    lines.push(`  ${icon}${duration}  ${node.title}`);
  }
  return lines.join("\n");
}

export function formatHeader(goal: string): string {
  return `[WorkGraph] Starting run...\n[WorkGraph] Goal: ${goal}`;
}

export function formatDone(metrics: RunMetrics): string {
  return [
    `\n[WorkGraph] Done in ${fmtMs(metrics.wall_time_ms)}`,
    formatMetricsTable(metrics),
    "",
  ].join("\n");
}
