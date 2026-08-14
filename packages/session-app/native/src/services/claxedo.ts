// The claxedo transport service — the effect boundary's imperative side.
//
// Services are synchronous static-tier TypeScript (scriptc): HTTP one-shots
// run through spawnSync(curl); dynamic JSON is validated with CHECKED casts
// against JSON-representable shapes, per item, so one odd record never sinks
// a whole response.
//
// RECORDED LIMIT (feeds the port plan's uncertainty table): an in-service
// SSE bridge is not expressible today — operations are sync-only (async
// services are a future compiler phase) and scriptc's static tier projects
// no stream-fd access, so the spawned-curl + readSync bridge does not clear
// the tier. v1 liveness is therefore core-driven polling (Sub.timer →
// loadTranscript). Token-grained streaming on native waits for async
// services or a core-side decoder for service stream channels.

import { spawnSync } from "node:child_process";
import type { PromptRequest, StreamRequest, TranscriptResult, TranscriptRow } from "../shared.ts";

const BASE = "http://127.0.0.1:4480";

/** Transcript part on the wire: text parts carry text; every part has a type. */
type WirePart = { type: string; text: string } | { type: string };

function curlText(url: string, body?: string): string {
  const args = ["-sf", "--noproxy", "*", "--max-time", "20", url];
  if (body !== undefined) {
    args.push("-X", "POST", "-H", "content-type: application/json", "--data", body);
  }
  const result = spawnSync("curl", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw { kind: "http_error", message: `curl exited for ${url}` };
  }
  return result.stdout;
}

function dirParam(directory: Uint8Array): string {
  return encodeURIComponent(new TextDecoder().decode(directory));
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function firstSessionId(directory: string): string {
  const listed = curlText(`${BASE}/session?directory=${directory}`);
  try {
    const sessions = JSON.parse(listed) as { id: string }[];
    if (sessions.length > 0) return sessions[0].id;
  } catch {
    // Fall through to creation.
  }
  const created = curlText(`${BASE}/session?directory=${directory}`, "{}");
  const record = JSON.parse(created) as { id: string };
  return record.id;
}

/** Resolves the workspace, picks (or creates) a session, returns its transcript. */
export function loadTranscript(request: StreamRequest): TranscriptResult {
  const directory = dirParam(request.directory);
  curlText(`${BASE}/api/claxedo/workspace/resolve?directory=${directory}&create=true`);
  const sessionId = firstSessionId(directory);
  const raw = curlText(`${BASE}/session/${encodeURIComponent(sessionId)}/message?directory=${directory}`);
  const rows: TranscriptRow[] = [];
  let items: unknown[] = [];
  try {
    items = JSON.parse(raw) as unknown[];
  } catch {
    throw { kind: "bad_json", message: "unparseable transcript" };
  }
  for (const item of items) {
    let role = "";
    try {
      const info = item as { info: { role: string } };
      role = info.info.role;
    } catch {
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    let parts: WirePart[] = [];
    try {
      const record = item as { parts: WirePart[] };
      parts = record.parts;
    } catch {
      continue;
    }
    for (const part of parts) {
      if (part.type === "text" && "text" in part) text += part.text;
    }
    if (text !== "") rows.push({ isUser: role === "user", body: bytes(text) });
  }
  return { sessionId: bytes(sessionId), title: bytes(""), rows };
}

export function sendPrompt(request: PromptRequest): TranscriptResult {
  const directory = dirParam(request.directory);
  const text = new TextDecoder().decode(request.text);
  const sessionId = firstSessionId(directory);
  curlText(
    `${BASE}/session/${encodeURIComponent(sessionId)}/message?directory=${directory}`,
    JSON.stringify({ parts: [{ type: "text", text }] }),
  );
  return { sessionId: bytes(sessionId), title: bytes(""), rows: [] };
}
