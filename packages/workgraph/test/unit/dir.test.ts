/**
 * Unit tests for src/dir.ts — path extraction utility.
 */

import { describe, it, expect } from "bun:test";
import { dir } from "../../src/dir";

describe("dir — empty / nullish input", () => {
  it("returns undefined for undefined", () => expect(dir(undefined)).toBeUndefined());
  it("returns undefined for empty string", () => expect(dir("")).toBeUndefined());
  it("returns undefined for whitespace only", () => expect(dir("   ")).toBeUndefined());
});

describe("dir — already-absolute paths", () => {
  it("returns unix absolute path unchanged", () => {
    expect(dir("/Users/alice/project")).toBe("/Users/alice/project");
  });

  it("returns Windows-style absolute path unchanged", () => {
    expect(dir("C:\\Users\\alice")).toBe("C:\\Users\\alice");
  });

  it("returns /private/... unchanged", () => {
    expect(dir("/private/var/foo")).toBe("/private/var/foo");
  });
});

describe("dir — embedded absolute path extraction", () => {
  it("extracts /Users/ path from a longer string", () => {
    expect(dir("prefix text /Users/alice/project")).toBe("/Users/alice/project");
  });

  it("extracts /home/ path from a longer string", () => {
    expect(dir("some output: /home/bob/work")).toBe("/home/bob/work");
  });

  it("extracts /Volumes/ path from a longer string", () => {
    expect(dir("mounted at /Volumes/External/data")).toBe("/Volumes/External/data");
  });

  it("picks the earliest match when multiple prefixes present", () => {
    // /Users/ appears before /home/ — should return from /Users/
    const result = dir("text /Users/alice /home/bob");
    expect(result).toMatch(/^\/Users\/alice/);
  });
});

describe("dir — bare prefix without leading slash", () => {
  it("prepends / when string starts with 'Users/'", () => {
    expect(dir("Users/alice/project")).toBe("/Users/alice/project");
  });

  it("prepends / when string starts with 'home/'", () => {
    expect(dir("home/bob/work")).toBe("/home/bob/work");
  });
});

describe("dir — unrecognised input (passthrough)", () => {
  it("returns the original string when no pattern matches", () => {
    expect(dir("my-relative/path")).toBe("my-relative/path");
  });
});
