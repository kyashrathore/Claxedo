import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PRIMARY_AGENT_APP_METRICS, type PrimaryAgentAppMetric } from "./agent-metrics";

export type MetricTarget = { direction: "lower" | "higher"; value: number; unit: string };
export type AgentBenchmarkTargets = {
  schemaVersion: 1;
  program: "claxedo-five-times-u1";
  application: "Claxedo";
  corpus: { path: string; sha256: string };
  terminalWorkload: { path: string; sha256: string };
  absoluteBudgets: Record<PrimaryAgentAppMetric, MetricTarget>;
};

export async function loadAgentBenchmarkTargets(path: string): Promise<AgentBenchmarkTargets> {
  const raw = JSON.parse(await readFile(path, "utf8")) as AgentBenchmarkTargets;
  if (raw.schemaVersion !== 1 || raw.program !== "claxedo-five-times-u1" || raw.application !== "Claxedo") throw new Error("target manifest is not the Claxedo U1 absolute-budget contract");
  if (!raw.corpus || !/^[0-9a-f]{64}$/u.test(raw.corpus.sha256) || typeof raw.corpus.path !== "string") throw new Error("target manifest corpus provenance is invalid");
  if (!raw.terminalWorkload || !/^[0-9a-f]{64}$/u.test(raw.terminalWorkload.sha256) || typeof raw.terminalWorkload.path !== "string") throw new Error("target manifest terminal workload provenance is invalid");
  const terminalWorkloadBytes = await readFile(resolve(dirname(path), raw.terminalWorkload.path));
  if (createHash("sha256").update(terminalWorkloadBytes).digest("hex") !== raw.terminalWorkload.sha256) throw new Error("target manifest terminal workload hash does not match");
  const keys = Object.keys(raw.absoluteBudgets ?? {});
  if (keys.length !== PRIMARY_AGENT_APP_METRICS.length || PRIMARY_AGENT_APP_METRICS.some((metric) => !keys.includes(metric))) throw new Error("target manifest must declare exactly all ten metrics");
  for (const metric of PRIMARY_AGENT_APP_METRICS) {
    const target = raw.absoluteBudgets[metric];
    if (!target || !["lower", "higher"].includes(target.direction) || !Number.isFinite(target.value) || target.value <= 0 || !target.unit) throw new Error(`invalid absolute target for ${metric}`);
  }
  return raw;
}

export function evaluateTarget(target: MetricTarget, value: number) {
  return target.direction === "lower" ? value <= target.value : value >= target.value;
}
