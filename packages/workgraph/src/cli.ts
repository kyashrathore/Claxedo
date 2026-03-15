#!/usr/bin/env bun
/**
 * wg CLI — WorkGraph task runner.
 *
 * Usage:
 *   wg "implement login feature"
 *   wg "implement login feature" --dir /repo --runtime workspace --dry-run
 */

import { runCLI } from "./cli-runner";
import {
  formatHeader,
  formatDone,
  formatNodeStatus,
} from "./cli-metrics";

function parseArgs(argv: string[]): {
  goal: string;
  dir?: string;
  runtime?: "workspace" | "task";
  dryRun: boolean;
  help: boolean;
} {
  const args = argv.slice(2); // strip node/bun + script path
  let goal = "";
  let dir: string | undefined;
  let runtime: "workspace" | "task" | undefined;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--dir" && args[i + 1]) {
      dir = args[++i];
    } else if (arg === "--runtime" && args[i + 1]) {
      const val = args[++i];
      if (val === "workspace" || val === "task") {
        runtime = val;
      } else {
        console.error(`[WorkGraph] Unknown runtime: ${val}. Use workspace or task.`);
        process.exit(1);
      }
    } else if (!arg.startsWith("--")) {
      goal = arg;
    }
  }

  return { goal, dir, runtime, dryRun, help };
}

function printHelp() {
  console.log(`
wg — WorkGraph CLI task runner

Usage:
  wg "<goal>" [options]

Options:
  --dir <path>      Working directory for agents (default: current dir)
  --runtime <type>  Runtime type: workspace | task (default: auto)
  --dry-run         Simulate run without spawning real agents
  --help, -h        Show this help

Examples:
  wg "implement login feature"
  wg "write unit tests for auth module" --dir /repo --dry-run
  wg "review pull request #42" --runtime task
`);
}

async function main() {
  const { goal, dir, runtime, dryRun, help } = parseArgs(Bun.argv);

  if (help) {
    printHelp();
    process.exit(0);
  }

  if (!goal) {
    console.error("[WorkGraph] Error: goal is required.");
    console.error("Usage: wg \"<goal>\" [--dir <path>] [--runtime workspace|task] [--dry-run]");
    process.exit(1);
  }

  if (!dryRun) {
    console.error("[WorkGraph] Error: real agent spawning not yet implemented. Use --dry-run.");
    process.exit(1);
  }

  console.log(formatHeader(goal));
  if (dryRun) {
    console.log("[WorkGraph] Mode: dry-run (no real agents)");
  }
  console.log("[WorkGraph] Planning...");

  let lastNodeCount = 0;
  let planningDone = false;

  try {
    const result = await runCLI({
      goal,
      directory: dir,
      runtime,
      dryRun,
      onUpdate: (nodes, phase) => {
        if (!planningDone && phase === "executing") {
          planningDone = true;
          console.log(`[WorkGraph] Executing...`);
        }
        if (nodes.length > lastNodeCount) {
          lastNodeCount = nodes.length;
        }
      },
    });

    // Print final node statuses
    console.log(formatNodeStatus(result.nodes));

    if (result.metrics) {
      console.log(formatDone(result.metrics));
    } else {
      console.log(`\n[WorkGraph] Run ${result.phase}`);
    }

    process.exit(result.phase === "completed" ? 0 : 1);
  } catch (err: any) {
    console.error(`[WorkGraph] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
