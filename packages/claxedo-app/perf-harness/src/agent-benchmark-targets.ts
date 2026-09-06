import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PRIMARY_AGENT_APP_METRICS, type PrimaryAgentAppMetric } from "./agent-metrics";
import { isRecord, numberField, recordField, textField } from "./json-fields";

export type MetricTarget = { direction: "lower" | "higher"; value: number; unit: string };
export type AgentBenchmarkTargets = {
  schemaVersion: 1;
  program: "claxedo-five-times-u1";
  application: "Claxedo";
  corpus: { path: string; sha256: string };
  terminalWorkload: { path: string; sha256: string };
  absoluteBudgets: Record<PrimaryAgentAppMetric, MetricTarget>;
};

/** Read one metric's absolute budget from the target manifest. */
function metricTarget(value: unknown, metric: string): MetricTarget {
  const direction = isRecord(value) ? textField(value, "direction") : undefined;
  const target = isRecord(value) ? numberField(value, "value") : undefined;
  const unit = isRecord(value) ? textField(value, "unit") : undefined;
  if (
    (direction !== "lower" && direction !== "higher") ||
    target === undefined ||
    !Number.isFinite(target) ||
    target <= 0 ||
    !unit
  ) {
    throw new Error(`invalid absolute target for ${metric}`);
  }
  return { direction, value: target, unit };
}

/** Read a `{ path, sha256 }` provenance pair, which every artifact reference is. */
function artifactReference(value: unknown, what: string): { path: string; sha256: string } {
  const artifactPath = isRecord(value) ? textField(value, "path") : undefined;
  const sha256 = isRecord(value) ? textField(value, "sha256") : undefined;
  if (artifactPath === undefined || sha256 === undefined || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error(`target manifest ${what} provenance is invalid`);
  }
  return { path: artifactPath, sha256 };
}

export async function loadAgentBenchmarkTargets(path: string): Promise<AgentBenchmarkTargets> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    parsed.program !== "claxedo-five-times-u1" ||
    parsed.application !== "Claxedo"
  ) {
    throw new Error("target manifest is not the Claxedo U1 absolute-budget contract");
  }
  const corpus = artifactReference(parsed.corpus, "corpus");
  const terminalWorkload = artifactReference(parsed.terminalWorkload, "terminal workload");
  const terminalWorkloadBytes = await readFile(resolve(dirname(path), terminalWorkload.path));
  if (createHash("sha256").update(terminalWorkloadBytes).digest("hex") !== terminalWorkload.sha256) throw new Error("target manifest terminal workload hash does not match");
  const budgets = recordField(parsed, "absoluteBudgets") ?? {};
  const keys = Object.keys(budgets);
  if (keys.length !== PRIMARY_AGENT_APP_METRICS.length || PRIMARY_AGENT_APP_METRICS.some((metric) => !keys.includes(metric))) throw new Error("target manifest must declare exactly the primary metric set");
  // Listed rather than accumulated in a loop: a record built by iteration
  // cannot be typed as covering every metric without an assertion, and adding
  // a primary metric should fail to compile here rather than read as absent.
  const read = (metric: PrimaryAgentAppMetric) => metricTarget(budgets[metric], metric);
  const absoluteBudgets: Record<PrimaryAgentAppMetric, MetricTarget> = {
    "app.cold_ready_ms": read("app.cold_ready_ms"),
    "work_item.cold_open_ms": read("work_item.cold_open_ms"),
    "work_item.warm_switch_p95_ms": read("work_item.warm_switch_p95_ms"),
    "stream.interaction_p95_ms": read("stream.interaction_p95_ms"),
    "stream.blocked_frame_ratio_pct": read("stream.blocked_frame_ratio_pct"),
    "terminal.input_to_paint_p95_ms": read("terminal.input_to_paint_p95_ms"),
    "terminal.output_mib_s": read("terminal.output_mib_s"),
    "resource.peak_process_family_rss_mib": read("resource.peak_process_family_rss_mib"),
    "resource.quiescent_cpu_p95_pct": read("resource.quiescent_cpu_p95_pct"),
  };
  return {
    schemaVersion: 1,
    program: "claxedo-five-times-u1",
    application: "Claxedo",
    corpus,
    terminalWorkload,
    absoluteBudgets,
  };
}

export function evaluateTarget(target: MetricTarget, value: number) {
  return target.direction === "lower" ? value <= target.value : value >= target.value;
}
