import path from "node:path"
import { describe, expect, it } from "vitest"

import { resolveTranscriptPath } from "./transcript-path"

const home = path.resolve("/home/agent")
const workspace = path.resolve("/srv/workspaces/repo")
const options = { homeDirectory: home, workspaceDirectory: workspace }

describe("resolveTranscriptPath", () => {
  it("allows the real harness transcript locations", () => {
    for (const candidate of [
      path.join(home, ".claude/projects/-srv-workspaces-repo/abc.jsonl"),
      path.join(home, ".codex/sessions/2026/07/15/rollout-abc.jsonl"),
      path.join(home, ".gemini/tmp/session.json"),
      path.join(workspace, ".claxedo/transcript.jsonl"),
    ]) {
      const verdict = resolveTranscriptPath(candidate, options)
      expect(verdict.ok, `${candidate}: ${verdict.ok ? "" : verdict.reason}`).toBe(true)
    }
  })

  it("refuses paths outside every allowed root", () => {
    for (const candidate of ["/etc/passwd", "/var/log/system.log", "/root/.ssh/id_rsa", "/tmp/steal.jsonl"]) {
      const verdict = resolveTranscriptPath(candidate, options)
      expect(verdict.ok, candidate).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toContain("outside the allowed roots")
    }
  })

  it("refuses traversal that escapes an allowed root", () => {
    const verdict = resolveTranscriptPath(path.join(home, ".claude/../../../etc/passwd"), options)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toContain("outside the allowed roots")
  })

  it("normalises traversal that stays inside a root", () => {
    const verdict = resolveTranscriptPath(path.join(home, ".claude/projects/../projects/a.jsonl"), options)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.path).toBe(path.join(home, ".claude/projects/a.jsonl"))
  })

  it("refuses credential subtrees that live under home", () => {
    for (const candidate of [
      path.join(home, ".ssh/id_ed25519"),
      path.join(home, ".aws/credentials"),
      path.join(home, ".kube/config"),
      path.join(home, ".gnupg/secring.gpg"),
    ]) {
      const verdict = resolveTranscriptPath(candidate, options)
      expect(verdict.ok, candidate).toBe(false)
    }
  })

  it("refuses credential-shaped basenames anywhere allowed", () => {
    for (const candidate of [
      path.join(workspace, ".env"),
      path.join(home, ".netrc"),
      path.join(home, ".claude/auth.json"),
      path.join(workspace, ".git-credentials"),
    ]) {
      const verdict = resolveTranscriptPath(candidate, options)
      expect(verdict.ok, candidate).toBe(false)
    }
  })

  it("refuses relative, empty, and NUL-bearing paths", () => {
    expect(resolveTranscriptPath("", options).ok).toBe(false)
    expect(resolveTranscriptPath("   ", options).ok).toBe(false)
    expect(resolveTranscriptPath("relative/transcript.jsonl", options).ok).toBe(false)
    const nul = resolveTranscriptPath(`${path.join(home, "a.jsonl")}\0/../../etc/passwd`, options)
    expect(nul.ok).toBe(false)
    if (!nul.ok) expect(nul.reason).toContain("NUL")
  })

  it("skips a workspace:<id> ref, which names no local directory", () => {
    const verdict = resolveTranscriptPath("/etc/passwd", {
      homeDirectory: home,
      workspaceDirectory: "workspace:ws-1",
    })
    expect(verdict.ok).toBe(false)
    // The home root still applies, and the bogus ref must not widen anything.
    const allowed = resolveTranscriptPath(path.join(home, ".claude/projects/a.jsonl"), {
      homeDirectory: home,
      workspaceDirectory: "workspace:ws-1",
    })
    expect(allowed.ok).toBe(true)
  })

  it("does not treat a sibling directory sharing the root's prefix as contained", () => {
    const verdict = resolveTranscriptPath("/srv/workspaces/repo-evil/transcript.jsonl", options)
    expect(verdict.ok).toBe(false)
  })
})
