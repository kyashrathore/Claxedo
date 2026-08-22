import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  parseStartupClockLog,
  startupClockEnabled,
  startupClockEnv,
  startupClockLead,
  startupClockPath,
} from "../src/agent-claxedo-launcher";

// The lead is the whole question a server-side prewarm turns on: how long the
// local server is able to serve while nothing has yet asked it for engine work.
// It spans two processes and two clocks, so it is only ever a subtraction the
// harness performs — these tests pin that subtraction, and pin that a default
// run is handed the environment it always was.

const previous = process.env.CLAXEDO_BENCH_STARTUP_CLOCK;

afterEach(() => {
  if (previous === undefined) delete process.env.CLAXEDO_BENCH_STARTUP_CLOCK;
  else process.env.CLAXEDO_BENCH_STARTUP_CLOCK = previous;
});

describe("startup clock request", () => {
  test("adds nothing to the application environment unless asked for", () => {
    delete process.env.CLAXEDO_BENCH_STARTUP_CLOCK;
    expect(startupClockEnabled()).toBe(false);
    expect(startupClockEnv("/runs/cold-1")).toEqual({});

    process.env.CLAXEDO_BENCH_STARTUP_CLOCK = "0";
    expect(startupClockEnv("/runs/cold-1")).toEqual({});
  });

  test("names a file inside the run that owns it", () => {
    process.env.CLAXEDO_BENCH_STARTUP_CLOCK = "1";
    expect(startupClockEnabled()).toBe(true);
    expect(startupClockEnv("/runs/cold-1")).toEqual({
      CLAXEDO_DIAG_STARTUP_CLOCK: path.join("/runs/cold-1", "startup-clock.jsonl"),
    });
  });
});

describe("startup clock lead", () => {
  const events = [
    { event: "main-server-forked", epochMs: 1_000, pid: 1, processStartEpochMs: 900 },
    { event: "server-listening", epochMs: 1_400, pid: 2, processStartEpochMs: 1_010, detail: { port: 65_202 } },
    { event: "main-server-ready-message", epochMs: 1_405, pid: 1, processStartEpochMs: 900 },
    { event: "main-server-health-verified", epochMs: 1_450, pid: 1, processStartEpochMs: 900 },
    { event: "main-server-ready-published", epochMs: 1_452, pid: 1, processStartEpochMs: 900 },
  ];
  const timeOrigin = 1_200;
  const resources = [
    { name: "http://127.0.0.1:65202/api/claxedo/health", startTime: 260 },
    { name: "http://127.0.0.1:65202/provider", startTime: 284 },
    { name: "http://127.0.0.1:65202/provider?harness=opencode", startTime: 700 },
  ];

  test("subtracts the server's own listen stamp from the renderer's first requests", () => {
    const lead = startupClockLead({ events, timeOrigin, resources });

    expect(lead.serverListeningEpochMs).toBe(1_400);
    expect(lead.serverProcessStartEpochMs).toBe(1_010);
    expect(lead.firstRequestEpochMs).toBe(1_460);
    expect(lead.firstProviderRequestEpochMs).toBe(1_484);
    expect(lead.leadToFirstRequestMs).toBe(60);
    expect(lead.leadToFirstProviderRequestMs).toBe(84);
  });

  test("decomposes the handoff main performs between listening and publishing the URL", () => {
    const lead = startupClockLead({ events, timeOrigin, resources });

    expect(lead.mainReadyMessageEpochMs! - lead.serverListeningEpochMs!).toBe(5);
    expect(lead.mainHealthVerifiedEpochMs! - lead.mainReadyMessageEpochMs!).toBe(45);
    expect(lead.mainReadyPublishedEpochMs! - lead.mainHealthVerifiedEpochMs!).toBe(2);
  });

  test("takes the EARLIEST /provider, not the first listed, and ignores query strings", () => {
    const reordered = [...resources].reverse();
    expect(startupClockLead({ events, timeOrigin, resources: reordered }).firstProviderRequestEpochMs).toBe(1_484);
  });

  test("does not count a path that merely contains provider", () => {
    const lead = startupClockLead({
      events,
      timeOrigin,
      resources: [{ name: "http://127.0.0.1:65202/api/claxedo/provider-auth", startTime: 10 }],
    });
    expect(lead.firstProviderRequestEpochMs).toBeUndefined();
    expect(lead.leadToFirstProviderRequestMs).toBeUndefined();
  });

  test("reports no lead rather than a wrong one when the server never stamped", () => {
    const lead = startupClockLead({ events: [], timeOrigin, resources });
    expect(lead.serverListeningEpochMs).toBeUndefined();
    expect(lead.leadToFirstRequestMs).toBeUndefined();
    expect(lead.leadToFirstProviderRequestMs).toBeUndefined();
  });
});

describe("startup clock log", () => {
  test("keeps well-formed events and drops anything else", () => {
    const contents = [
      JSON.stringify({ event: "server-listening", epochMs: 1_400, pid: 2, processStartEpochMs: 1_010 }),
      "",
      "{ not json",
      JSON.stringify({ event: "missing-epoch" }),
      JSON.stringify({ event: "main-server-ready-published", epochMs: 1_452, pid: 1, processStartEpochMs: 900 }),
    ].join("\n");

    expect(parseStartupClockLog(contents).map((entry) => entry.event)).toEqual([
      "server-listening",
      "main-server-ready-published",
    ]);
  });
});

describe("startup clock file", () => {
  test("lives beside the run's other cold-ready diagnostics", () => {
    expect(startupClockPath("/runs/cold-1")).toBe(path.join("/runs/cold-1", "startup-clock.jsonl"));
  });
});
