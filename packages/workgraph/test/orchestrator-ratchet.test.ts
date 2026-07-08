import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Ratchet: the orchestrator/DAG half of this package is being deleted
 * (docs/plans/2026-07-06-004-refactor-workgraph-flat-inbox-oss-plan.md).
 * Imports of `src/orchestrator/**` from outside that directory may only
 * decrease. When the sweep completes this baseline reaches 0 and stays there.
 */
const BASELINE = 0;

const SRC = join(__dirname, "..", "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("orchestrator import ratchet", () => {
  it(`src outside orchestrator/ has at most ${BASELINE} orchestrator imports`, () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith("orchestrator")) continue;
      const source = readFileSync(file, "utf8");
      const matches = source.match(/from\s+["'][^"']*orchestrator\/[^"']*["']/g) ?? [];
      for (const m of matches) offenders.push(`${rel}: ${m}`);
    }
    if (offenders.length > BASELINE) {
      throw new Error(
        `orchestrator imports grew from ${BASELINE} to ${offenders.length} — the DAG half is being deleted, do not add dependencies on it:\n` +
          offenders.join("\n"),
      );
    }
    expect(offenders.length).toBeLessThanOrEqual(BASELINE);
  });
});
