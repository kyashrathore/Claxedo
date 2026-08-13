import { describe, expect, test } from "bun:test";
import { QUIET_HOST_LOAD_LIMIT, assertQuietHost, parseLoadAverage } from "../src/agent-host-preflight";

// Real `uptime` output, macOS and Linux, including the comma-separated locale form.
const MAC = "23:14  up 2 days,  4:11, 3 users, load averages: 1.94 2.21 2.40";
const MAC_BUSY = "23:14  up 2 days,  4:11, 3 users, load averages: 11.73 13.02 10.33";
const LINUX = " 23:14:02 up 1:20,  1 user,  load average: 0.51, 0.63, 0.55";

describe("quiet-host preflight", () => {
  test("reads the 1-minute load average from macOS and Linux uptime", () => {
    expect(parseLoadAverage(MAC)).toBeCloseTo(1.94, 5);
    expect(parseLoadAverage(LINUX)).toBeCloseTo(0.51, 5);
  });

  test("accepts a quiet host and returns the load it measured", () => {
    expect(assertQuietHost(MAC)).toBeCloseTo(1.94, 5);
  });

  // The exact observed condition: two orphaned Playwright suites plus ffmpeg video
  // encoders, 11.73 on a 12-core host, through fourteen packaged runs.
  test("refuses a busy host and says why, rather than measuring anyway", () => {
    expect(() => assertQuietHost(MAC_BUSY)).toThrow(/quiet host/u);
    expect(() => assertQuietHost(MAC_BUSY)).toThrow(/11\.73/u);
  });

  test("refuses output it cannot read instead of assuming the host is quiet", () => {
    expect(() => assertQuietHost("no load information here")).toThrow(/could not read/u);
  });

  test("the limit is a documented constant, not a magic number at the call site", () => {
    expect(QUIET_HOST_LOAD_LIMIT).toBe(4);
  });
});
