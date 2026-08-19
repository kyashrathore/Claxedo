import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAgentBenchmarkOptions, runAgentAppBenchmark } from "../src/agent-app-benchmark";
import { AGENT_APP_PROFILES } from "../src/agent-driver-contract";
import { captureHostState, validateHostTransition, type HostCommands } from "../src/agent-host-preflight";
import { isT3Process, parseProcessTable, processFamily, processLineage } from "../src/agent-process-family";
import { checkExperimentProposal, loadPriorEvidence, REQUIRED_PRIOR_EVIDENCE_IDS } from "../src/agent-prior-evidence";
import { loadAgentBenchmarkTargets } from "../src/agent-benchmark-targets";
import { AGENT_APP_WINDOW, agentAppViewport } from "../src/agent-display-contract";

const harnessRoot = path.resolve(import.meta.dir, "..");
const targetsPath = path.join(harnessRoot, "targets/five-times.json");

describe("authoritative Claxedo agent-app benchmark infrastructure", () => {
  test("keeps the fixed app window distinct from platform-owned content chrome", () => {
    expect(AGENT_APP_WINDOW).toEqual({ width: 1440, height: 900 });
    expect(agentAppViewport("darwin")).toEqual({ width: 1440, height: 875 });
    expect(agentAppViewport("linux")).toEqual({ width: 1440, height: 900 });
  });

  test("expands --profiles all into the exact four-profile ten-metric contract", () => {
    const options = parseAgentBenchmarkOptions([
      "--app", "/tmp/Claxedo Dev.app", "--profiles", "all", "--run-profile", "iteration",
      "--seed", "1729", "--targets", targetsPath, "--output", "/tmp/evidence",
    ], "/");
    expect(options.profiles).toEqual([...AGENT_APP_PROFILES]);
    expect(() => parseAgentBenchmarkOptions([
      "--app", "/tmp/app", "--profiles", "all", "--run-profile", "publication",
      "--seed", "1729", "--targets", targetsPath, "--output", "/tmp/evidence",
    ], "/")).toThrow("belongs to U11");
  });

  test("loads ten independent absolute budgets and no T3 target", async () => {
    const targets = await loadAgentBenchmarkTargets(targetsPath);
    expect(Object.keys(targets.absoluteBudgets)).toHaveLength(10);
    expect(targets.application).toBe("Claxedo");
    expect(JSON.stringify(targets)).not.toContain("smokeMedians");
  });

  test("imports every required prior record and rejects duplicate experiments without a new boundary", async () => {
    const manifest = await loadPriorEvidence(path.join(harnessRoot, "evidence/prior-evidence.json"));
    expect(manifest.entries.map((entry) => entry.id)).toEqual(REQUIRED_PRIOR_EVIDENCE_IDS);
    expect(() => checkExperimentProposal(manifest, { question: "Mount only the visible non-terminal surface", priorEvidenceId: "2" })).toThrow("duplicate experiment rejected");
    expect(checkExperimentProposal(manifest, { question: "Mount only the visible non-terminal surface", priorEvidenceId: "2", newMetric: "connected layout objects" })).toMatchObject({ decision: "allowed-with-new-question", linkedPriorEvidenceId: "2" });
    expect(manifest.entries.filter((entry) => entry.inheritance.status === "unresolved").every((entry) => entry.inheritance.missing.length > 0)).toBe(true);
  });

  test("accounts for descendants and rejects T3 in executable or parent lineage", () => {
    const rows = parseProcessTable([
      " 100 1 1000 00:01:00 Sun Mar 29 12:26:55 2026 /Applications/T3.app/T3",
      " 200 100 2000 00:00:20 Sun Mar 29 12:26:56 2026 /Applications/Claxedo --type=renderer",
      " 201 200 3000 00:00:03 Sun Mar 29 12:26:57 2026 /bin/worker",
    ].join("\n"));
    expect(processFamily(rows, 200).map((row) => row.pid)).toEqual([200, 201]);
    expect(processLineage(rows, 200).map((row) => row.pid)).toEqual([200, 100]);
    expect(processLineage(rows, 200).some(isT3Process)).toBe(true);
  });

  test("requires known AC, nominal thermal, stable display, and uninterrupted clocks", async () => {
    if (process.platform !== "darwin") return;
    const commands: HostCommands = { async run(command) {
      if (command[0] === "pmset" && command.at(-1) === "batt") return { code: 0, stdout: "Now drawing from 'AC Power'\n", stderr: "" };
      if (command[0] === "pmset") return { code: 0, stdout: "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n", stderr: "" };
      // A quiet host is now a preflight precondition alongside AC, thermal and display:
      // fourteen packaged runs were measured while two orphaned e2e suites held the machine
      // at load 11.73, and nothing in the harness noticed.
      if (command[0] === "uptime") return { code: 0, stdout: "23:14  up 2 days, 4:11, 3 users, load averages: 1.02 1.10 1.30\n", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ SPDisplaysDataType: [{ display: "stable" }] }), stderr: "" };
    } };
    const before = await captureHostState(commands);
    const after = { ...before, wallTimeMs: before.wallTimeMs + 2_000, monotonicTimeMs: before.monotonicTimeMs + 2_000 };
    expect(validateHostTransition(before, after)).toEqual([]);
    expect(validateHostTransition(before, { ...after, monotonicTimeMs: before.monotonicTimeMs })).toContain("sleep-or-clock-interruption");
    expect(validateHostTransition(before, { ...after, displays: { ...after.displays, sha256: "b".repeat(64) } })).toContain("display-configuration-changed");
  });

  test("retains a complete typed-invalid ten-metric attempt when preflight cannot launch the app", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claxedo-agent-orchestrator-"));
    const output = path.join(root, "attempt");
    try {
      const result = await runAgentAppBenchmark(parseAgentBenchmarkOptions([
        "--app", path.join(root, "missing.app"), "--profiles", "all", "--run-profile", "iteration",
        "--seed", "1729", "--targets", targetsPath, "--output", output,
      ]));
      expect(result.exitCode).toBe(1);
      expect(result.manifest.validity).toBe("invalid");
      expect(result.manifest.samples).toHaveLength(10);
      expect(result.manifest.samples.every((sample) => sample.validity.status === "invalid")).toBe(true);
      expect(result.manifest.summary.every((metric) => metric.validSamples === 0 && metric.excludedInvalidSamples === 1)).toBe(true);
      const persisted = JSON.parse(await readFile(path.join(output, "attempt.json"), "utf8"));
      expect(persisted.samples).toHaveLength(10);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
