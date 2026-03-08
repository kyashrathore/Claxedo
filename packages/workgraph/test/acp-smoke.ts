#!/usr/bin/env bun
/**
 * ACP Backend smoke test — verifies the full lifecycle against a real ACP agent.
 *
 * Usage:
 *
 *   # Stdio agent (opencode acp — default)
 *   cd packages/api-server
 *   bun run test/acp-smoke.ts
 *
 *   # Custom stdio agent
 *   bun run test/acp-smoke.ts --command codex --args "--full-auto"
 *
 *   # HTTP agent
 *   bun run test/acp-smoke.ts --mode http --baseUrl http://127.0.0.1:9090 --agent claude
 *
 *   # Custom prompt
 *   bun run test/acp-smoke.ts --prompt "List 3 prime numbers"
 */

import { AcpBackend } from "../src/orchestrator/acp/acp-backend";
import type { AcpRegistryConfig } from "../src/orchestrator/acp/acp-registry";
import type { DecomposedTask } from "../src/orchestrator/types";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

const flags = parseArgs();
const mode = flags.mode ?? "stdio";
const prompt = flags.prompt ?? 'Reply with exactly: "ACP smoke test passed"';

let registry: AcpRegistryConfig;

if (mode === "http") {
  const baseUrl = flags.baseUrl ?? "http://127.0.0.1:3001";
  const agent = flags.agent ?? "opencode";
  console.log("=== ACP Backend Smoke Test (HTTP) ===");
  console.log(`  Server:  ${baseUrl}`);
  console.log(`  Agent:   ${agent}`);
  registry = {
    entries: [{
      id: "smoke",
      name: "Smoke Test",
      transport: { mode: "http", baseUrl, agent, token: flags.token, path: flags.path },
      taskKinds: ["smoke"],
    }],
  };
} else {
  const command = flags.command ?? "opencode";
  const args = flags.args ? flags.args.split(" ") : ["acp"];
  console.log("=== ACP Backend Smoke Test (stdio) ===");
  console.log(`  Command: ${command} ${args.join(" ")}`);
  registry = {
    entries: [{
      id: "smoke",
      name: "Smoke Test",
      transport: { mode: "stdio", command, args },
      taskKinds: ["smoke"],
    }],
  };
}

console.log(`  Prompt:  ${prompt}`);
console.log();

const task: DecomposedTask = {
  id: "smoke_1",
  title: "Smoke Test",
  kind: "smoke",
  team: "test",
  prompt,
  depends_on: [],
};

const backend = new AcpBackend(registry);

console.log("[1/3] Launching task (initialize → newSession → prompt)...");
const handle = await backend.launch(task, "run_smoke", "node_smoke");
console.log(`  Handle ID: ${handle.id}`);

console.log("[2/3] Awaiting response (streaming events via sessionUpdate)...");
const result = await handle.await();

console.log("[3/3] Result:");
console.log(`  Status: ${result.status}`);
console.log(`  Output: ${result.output.slice(0, 500)}`);
if (result.error) {
  console.log(`  Error:  ${result.error}`);
}

console.log();
if (result.status === "completed" && result.output.length > 0) {
  console.log("PASS — full ACP lifecycle works end-to-end");
  process.exit(0);
} else {
  console.log("FAIL — unexpected result");
  process.exit(1);
}
