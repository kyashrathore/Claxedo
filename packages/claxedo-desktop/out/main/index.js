import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, statSync } from "node:fs";
import { createServer as createServer$1 } from "node:net";
import { tmpdir, homedir } from "node:os";
import path, { extname, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { session, app, webContents, ipcMain, dialog, shell, clipboard, nativeImage, Notification, BrowserWindow, nativeTheme, Menu } from "electron";
import pkg from "electron-updater";
import { execFileSync, spawn, execFile } from "node:child_process";
import log from "electron-log/main.js";
import { createServer } from "node:http";
import readline from "node:readline";
import treeKill from "tree-kill";
import Store from "electron-store";
import { marked } from "marked";
import windowState from "electron-window-state";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function checkAppExists(appName) {
  if (process.platform === "win32") return true;
  if (process.platform === "linux") return true;
  return checkMacosApp(appName);
}
function resolveAppPath(appName) {
  if (process.platform !== "win32") return appName;
  return resolveWindowsAppPath(appName);
}
function wslPath(path2, mode) {
  if (process.platform !== "win32") return path2;
  const flag = mode === "windows" ? "-w" : "-u";
  try {
    if (path2.startsWith("~")) {
      const suffix = path2.slice(1);
      const cmd = `wslpath ${flag} "$HOME${suffix.replace(/\"/g, '\\"')}"`;
      const output2 = execFileSync("wsl", ["-e", "sh", "-lc", cmd]);
      return output2.toString().trim();
    }
    const output = execFileSync("wsl", ["-e", "wslpath", flag, path2]);
    return output.toString().trim();
  } catch (error) {
    throw new Error(`Failed to run wslpath: ${String(error)}`);
  }
}
function checkMacosApp(appName) {
  const locations = [`/Applications/${appName}.app`, `/System/Applications/${appName}.app`];
  const home = process.env.HOME;
  if (home) locations.push(`${home}/Applications/${appName}.app`);
  if (locations.some((location) => existsSync(location))) return true;
  try {
    execFileSync("which", [appName]);
    return true;
  } catch {
    return false;
  }
}
function resolveWindowsAppPath(appName) {
  let output;
  try {
    output = execFileSync("where", [appName]).toString();
  } catch {
    return null;
  }
  const paths = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const hasExt = (path2, ext) => extname(path2).toLowerCase() === `.${ext}`;
  const exe = paths.find((path2) => hasExt(path2, "exe"));
  if (exe) return exe;
  const resolveCmd = (path2) => {
    const content = readFileSync(path2, "utf8");
    for (const token of content.split('"').map((value) => value.trim())) {
      const lower = token.toLowerCase();
      if (!lower.includes(".exe")) continue;
      const index = lower.indexOf("%~dp0");
      if (index >= 0) {
        const base = dirname(path2);
        const suffix = token.slice(index + 5);
        const resolved = suffix.replace(/\//g, "\\").split("\\").filter((part) => part && part !== ".").reduce((current, part) => {
          if (part === "..") return dirname(current);
          return join(current, part);
        }, base);
        if (existsSync(resolved)) return resolved;
      }
      if (existsSync(token)) return token;
    }
    return null;
  };
  for (const path2 of paths) {
    if (hasExt(path2, "cmd") || hasExt(path2, "bat")) {
      const resolved = resolveCmd(path2);
      if (resolved) return resolved;
    }
    if (!extname(path2)) {
      const cmd = `${path2}.cmd`;
      if (existsSync(cmd)) {
        const resolved = resolveCmd(cmd);
        if (resolved) return resolved;
      }
      const bat = `${path2}.bat`;
      if (existsSync(bat)) {
        const resolved = resolveCmd(bat);
        if (resolved) return resolved;
      }
    }
  }
  const key = appName.split("").filter((value) => /[a-z0-9]/i.test(value)).map((value) => value.toLowerCase()).join("");
  if (key) {
    for (const path2 of paths) {
      const dirs = [dirname(path2), dirname(dirname(path2)), dirname(dirname(dirname(path2)))];
      for (const dir of dirs) {
        try {
          for (const entry of readdirSync(dir)) {
            const candidate = join(dir, entry);
            if (!hasExt(candidate, "exe")) continue;
            const stem = entry.replace(/\.exe$/i, "");
            const name = stem.split("").filter((value) => /[a-z0-9]/i.test(value)).map((value) => value.toLowerCase()).join("");
            if (name.includes(key) || key.includes(name)) return candidate;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return paths[0] ?? null;
}
function isBrowserTabEnabled(env = process.env) {
  return env.CLAXEDO_ENABLE_BROWSER_TAB === "1";
}
const MAX_AUDIT_ENTRIES = 500;
class AgentAuditLog {
  #entries = [];
  #nextId = 1;
  #cap;
  #listeners = /* @__PURE__ */ new Set();
  constructor(cap = MAX_AUDIT_ENTRIES) {
    this.#cap = cap;
  }
  get size() {
    return this.#entries.length;
  }
  append(input) {
    const entry = {
      id: this.#nextId++,
      time: input.time ?? Date.now(),
      paneId: input.paneId,
      action: input.action,
      summary: input.summary,
      result: input.result,
      reason: input.reason
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#cap) {
      const overflow = this.#entries.length - this.#cap;
      this.#entries.splice(0, overflow);
    }
    for (const fn of this.#listeners) {
      try {
        fn(entry);
      } catch {
      }
    }
    return entry;
  }
  snapshot() {
    return this.#entries.slice();
  }
  forPane(paneId) {
    return this.#entries.filter((e) => e.paneId === paneId);
  }
  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  clear() {
    this.#entries.length = 0;
  }
}
const agentAuditLog = new AgentAuditLog();
let cachedToken;
const DESKTOP_TOKEN_HEADER = "x-claxedo-desktop-token";
const DESKTOP_MCP_ORIGIN = "claxedo-mcp://local";
function ensureDesktopToken() {
  if (!cachedToken) cachedToken = randomUUID();
  return cachedToken;
}
const BIND_HOST = "127.0.0.1";
const MAX_RESPONSE_IMAGE_BYTES = 1e6;
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
async function startDesktopHttpBridge(deps) {
  const token = ensureDesktopToken();
  const auditLog = deps.auditLog ?? agentAuditLog;
  const server = createServer((req, res) => {
    handleRequest(req, res, deps, auditLog, token).catch((err) => {
      sendJson(res, 500, { error: "internal", message: String(err instanceof Error ? err.message : err) });
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, BIND_HOST, () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("bridge: failed to bind ephemeral port"));
        return;
      }
      resolve(address.port);
    });
  });
  const url = `http://${BIND_HOST}:${port}`;
  return {
    url,
    port,
    token,
    close: () => closeServer(server)
  };
}
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
async function handleRequest(req, res, deps, auditLog, token) {
  const authFailure = authenticate(req, token);
  if (authFailure) {
    sendJson(res, authFailure.status, { error: authFailure.error });
    return;
  }
  const { pathname } = parseUrl(req.url ?? "/");
  const method = (req.method ?? "GET").toUpperCase();
  if (pathname === "/browser/tabs") {
    if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
    return sendJson(res, 200, { tabs: enumerateTabs(deps) });
  }
  const paneMatch = pathname.match(/^\/browser\/([^/]+)\/([a-z-]+)$/);
  if (!paneMatch) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  const paneId = decodeURIComponent(paneMatch[1] ?? "");
  const action = paneMatch[2] ?? "";
  const handle = deps.registry.get(paneId);
  if (!handle) {
    sendJson(res, 404, { error: "pane-not-found", paneId });
    return;
  }
  switch (action) {
    case "console": {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      const url = new URL(req.url ?? "/", `http://${BIND_HOST}`);
      const query = {};
      const since = url.searchParams.get("since");
      const limit = url.searchParams.get("limit");
      const level = url.searchParams.get("level");
      if (since !== null && since !== "") {
        const n = Number.parseInt(since, 10);
        if (Number.isFinite(n)) query.since = n;
      }
      if (limit !== null && limit !== "") {
        const n = Number.parseInt(limit, 10);
        if (Number.isFinite(n)) query.limit = n;
      }
      if (level) query.level = level;
      const entries = handle.getConsoleLogs(query);
      return sendJson(res, 200, { entries });
    }
    case "screenshot": {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJson(req);
      if (body.error) return sendJson(res, 400, { error: body.error });
      const opts = body.value ?? {};
      const result = await handle.screenshot({ clip: opts.clip });
      if (!result.ok) {
        auditLog.append({
          paneId,
          action: "screenshot",
          summary: describeScreenshot(opts),
          result: "denied",
          reason: result.error.code
        });
        return sendJson(res, 200, result);
      }
      const sizeBytes = approxDataUrlBytes(result.dataUrl);
      if (sizeBytes > MAX_RESPONSE_IMAGE_BYTES) {
        auditLog.append({
          paneId,
          action: "screenshot",
          summary: describeScreenshot(opts),
          result: "denied",
          reason: "image-too-large"
        });
        return sendJson(res, 200, {
          ok: false,
          error: { code: "too-large", message: `screenshot exceeds ${MAX_RESPONSE_IMAGE_BYTES} byte cap` }
        });
      }
      auditLog.append({
        paneId,
        action: "screenshot",
        summary: describeScreenshot(opts),
        result: "allowed"
      });
      return sendJson(res, 200, result);
    }
    case "evaluate": {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJson(req);
      if (body.error) return sendJson(res, 400, { error: body.error });
      const value = body.value;
      const expression = typeof value?.expression === "string" ? value.expression : "";
      if (!expression) return sendJson(res, 400, { error: "expression-required" });
      const summary = `eval (${expression.length} chars)`;
      const result = await handle.evaluate(expression);
      if (!result.ok) {
        auditLog.append({
          paneId,
          action: "evaluate",
          summary,
          result: "denied",
          reason: result.error.code
        });
        return sendJson(res, 200, result);
      }
      auditLog.append({ paneId, action: "evaluate", summary, result: "allowed" });
      return sendJson(res, 200, result);
    }
    case "navigate": {
      if (method !== "POST") return sendJson(res, 405, { error: "method-not-allowed" });
      const body = await readJson(req);
      if (body.error) return sendJson(res, 400, { error: body.error });
      const value = body.value;
      const target = typeof value?.url === "string" ? value.url.trim() : "";
      if (!target) return sendJson(res, 400, { error: "url-required" });
      try {
        const parsed = new URL(target);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          auditLog.append({
            paneId,
            action: "navigate",
            summary: target,
            result: "denied",
            reason: `scheme ${parsed.protocol} not allowed`
          });
          return sendJson(res, 200, {
            ok: false,
            error: { code: "bad-scheme", message: `scheme ${parsed.protocol} not allowed` }
          });
        }
      } catch {
        auditLog.append({ paneId, action: "navigate", summary: target, result: "denied", reason: "invalid-url" });
        return sendJson(res, 200, { ok: false, error: { code: "invalid-url", message: `invalid url: ${target}` } });
      }
      try {
        await handle.navigate(target);
        auditLog.append({ paneId, action: "navigate", summary: target, result: "allowed" });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        auditLog.append({ paneId, action: "navigate", summary: target, result: "denied", reason: message });
        return sendJson(res, 200, { ok: false, error: { code: "nav-failed", message } });
      }
    }
    case "audit": {
      if (method !== "GET") return sendJson(res, 405, { error: "method-not-allowed" });
      return sendJson(res, 200, { entries: auditLog.forPane(paneId) });
    }
    default:
      return sendJson(res, 404, { error: "not-found" });
  }
}
function enumerateTabs(deps) {
  const ids = deps.registry.paneIds();
  const out = [];
  for (const paneId of ids) {
    const handle = deps.registry.get(paneId);
    if (!handle) continue;
    let currentUrl = "";
    let title = "";
    try {
      const wc = handle.webContents;
      currentUrl = wc.getURL ? wc.getURL() : "";
      title = wc.getTitle ? wc.getTitle() : "";
    } catch {
    }
    if (!title && deps.resolveTitle) {
      title = deps.resolveTitle(paneId, handle);
    }
    out.push({
      paneId,
      title: title || "",
      currentUrl,
      groupId: deps.getGroupId?.(paneId),
      agentAllowed: handle.agentAllowed
    });
  }
  return out;
}
function authenticate(req, token) {
  const header = lowercaseHeader(req, DESKTOP_TOKEN_HEADER);
  if (!header) return { status: 401, error: "missing-token" };
  if (header.length !== token.length) return { status: 401, error: "bad-token" };
  let diff = 0;
  for (let i = 0; i < header.length; i++) {
    diff |= header.charCodeAt(i) ^ token.charCodeAt(i);
  }
  if (diff !== 0) return { status: 401, error: "bad-token" };
  const origin = lowercaseHeader(req, "origin");
  if (origin !== void 0 && origin !== "" && origin !== "null" && origin !== DESKTOP_MCP_ORIGIN) {
    return { status: 403, error: "bad-origin" };
  }
  return void 0;
}
function lowercaseHeader(req, name) {
  const raw2 = req.headers[name];
  if (Array.isArray(raw2)) return raw2[0];
  return raw2;
}
function parseUrl(raw2) {
  const base = `http://${BIND_HOST}`;
  try {
    const u = new URL(raw2, base);
    return { pathname: u.pathname };
  } catch {
    return { pathname: raw2.split("?")[0] ?? "/" };
  }
}
async function readJson(req) {
  const chunks = [];
  let total = 0;
  let overflowed = false;
  try {
    for await (const chunk of req) {
      const buf = chunk;
      total += buf.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        continue;
      }
      if (!overflowed) chunks.push(buf);
    }
  } catch {
    return { error: "read-error" };
  }
  if (overflowed) return { error: "payload-too-large" };
  if (total === 0) return { value: null };
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "invalid-json" };
  }
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(payload);
}
function approxDataUrlBytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return dataUrl.length;
  const base64 = dataUrl.slice(comma + 1);
  return Math.floor(base64.length * 3 / 4);
}
function describeScreenshot(opts) {
  if (opts.clip) {
    const { x, y, width, height } = opts.clip;
    return `screenshot clip=${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)}`;
  }
  return "screenshot (viewport)";
}
const AGENT_BROWSER_PARTITION = "persist:agent-browser";
const DANGEROUS_WEBPREF_TOKENS = [
  "nodeIntegration",
  "contextIsolation",
  "webSecurity",
  "allowRunningInsecureContent",
  "experimentalFeatures"
];
const DANGEROUS_PARAM_KEYS = [
  "preload",
  "preloadURL",
  "nodeintegration",
  "nodeIntegration",
  "nodeintegrationinsubframes",
  "nodeIntegrationInSubFrames",
  "enableremotemodule",
  "enableRemoteModule",
  "disablewebsecurity",
  "allowpopups"
];
const ALLOWED_SRC_SCHEMES = /* @__PURE__ */ new Set(["http:", "https:"]);
const ALLOWED_SRC_EXACT = /* @__PURE__ */ new Set(["about:blank", ""]);
function createWillAttachWebviewHandler(opts = {}) {
  const expectedPartition = opts.partition ?? AGENT_BROWSER_PARTITION;
  const onReject = opts.onReject ?? (() => {
  });
  const guestPreloadUrl = opts.guestPreloadUrl;
  return function willAttachWebview(event, webPreferences, params) {
    const requestedPartition = (params.partition ?? webPreferences.partition ?? "").trim();
    if (requestedPartition !== expectedPartition) {
      onReject(
        `partition "${requestedPartition}" is not allowed (expected "${expectedPartition}")`,
        params
      );
      event.preventDefault();
      return;
    }
    const rawSrc = typeof params.src === "string" ? params.src.trim() : "";
    if (!isAllowedSrc(rawSrc)) {
      onReject(`src "${rawSrc}" is not an allowed scheme`, params);
      event.preventDefault();
      return;
    }
    if (typeof params.webpreferences === "string" && params.webpreferences.length > 0) {
      const lower = params.webpreferences.toLowerCase();
      for (const token of DANGEROUS_WEBPREF_TOKENS) {
        if (lower.includes(token.toLowerCase())) {
          onReject(`webpreferences contains dangerous token "${token}"`, params);
          event.preventDefault();
          return;
        }
      }
    }
    for (const key of DANGEROUS_PARAM_KEYS) {
      if (key in params) delete params[key];
    }
    if ("webpreferences" in params) {
      delete params.webpreferences;
    }
    if ("preload" in webPreferences) delete webPreferences.preload;
    if ("preloadURL" in webPreferences) delete webPreferences.preloadURL;
    if (typeof guestPreloadUrl === "string" && guestPreloadUrl.length > 0) {
      webPreferences.preload = guestPreloadUrl;
    }
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    if ("enableBlinkFeatures" in webPreferences) delete webPreferences.enableBlinkFeatures;
    webPreferences.partition = expectedPartition;
  };
}
function isAllowedSrc(raw2) {
  if (ALLOWED_SRC_EXACT.has(raw2)) return true;
  try {
    const url = new URL(raw2);
    return ALLOWED_SRC_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}
const DENIED_PERMISSIONS = /* @__PURE__ */ new Set([
  "notifications",
  "geolocation",
  "media",
  "midi",
  "midiSysex",
  "clipboard-read",
  "persistent-storage",
  "fullscreen",
  "pointerLock",
  "openExternal"
]);
let configured = false;
function configureAgentBrowserPartition() {
  const session$1 = session.fromPartition(AGENT_BROWSER_PARTITION);
  if (configured) return session$1;
  configured = true;
  session$1.setPermissionRequestHandler((_wc, permission, callback) => {
    if (DENIED_PERMISSIONS.has(permission)) {
      callback(false);
      return;
    }
    callback(false);
  });
  session$1.setPermissionCheckHandler((_wc, permission) => {
    if (DENIED_PERMISSIONS.has(permission)) return false;
    return false;
  });
  session$1.on("will-download", (event) => {
    event.preventDefault();
  });
  return session$1;
}
function installAgentBrowserNavigationGuards(wc) {
  wc.on("will-navigate", (event, urlString) => {
    if (!isAllowedNavigationUrl(urlString)) {
      event.preventDefault();
    }
  });
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
}
function isAllowedNavigationUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
const MAX_CONSOLE_ENTRIES = 2e3;
function sanitizeConsoleString(input) {
  if (!input) return input;
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 27) {
      let j = i + 1;
      if (j < input.length && input.charCodeAt(j) === 91) {
        j++;
        while (j < input.length) {
          const c = input.charCodeAt(j);
          if (c >= 64 && c <= 126) {
            j++;
            break;
          }
          j++;
        }
      } else if (j < input.length && input.charCodeAt(j) === 93) {
        j++;
        while (j < input.length) {
          const c = input.charCodeAt(j);
          if (c === 7) {
            j++;
            break;
          }
          if (c === 27 && j + 1 < input.length && input.charCodeAt(j + 1) === 92) {
            j += 2;
            break;
          }
          j++;
        }
      } else {
        if (j < input.length) j++;
      }
      i = j - 1;
      continue;
    }
    if (code >= 55296 && code <= 56319) {
      const high = code;
      const low = i + 1 < input.length ? input.charCodeAt(i + 1) : 0;
      if (low >= 56320 && low <= 57343) {
        const cp = (high - 55296) * 1024 + (low - 56320) + 65536;
        if (cp >= 917504 && cp <= 917631) {
          i++;
          continue;
        }
        out += input[i];
        out += input[i + 1];
        i++;
        continue;
      }
    }
    if (code === 8203 || // ZWSP
    code === 8204 || // ZWNJ
    code === 8205 || // ZWJ
    code === 65279 || // BOM / ZWNBSP
    code === 8288) {
      continue;
    }
    out += input[i];
  }
  return out;
}
function sanitizeArgs(args) {
  return args.map((a) => sanitizeConsoleString(typeof a === "string" ? a : String(a)));
}
class ConsoleBuffer {
  #entries = [];
  #nextId = 1;
  #cap;
  constructor(cap = MAX_CONSOLE_ENTRIES) {
    this.#cap = cap;
  }
  get size() {
    return this.#entries.length;
  }
  /** Append an entry; returns the assigned `ConsoleEntry`. Sanitizes `args`. */
  append(input) {
    const entry = {
      id: this.#nextId++,
      time: input.time ?? Date.now(),
      level: input.level,
      args: sanitizeArgs(input.args ?? []),
      stack: input.stack,
      source: input.source,
      sessionId: input.sessionId
    };
    this.#entries.push(entry);
    if (this.#entries.length > this.#cap) {
      const overflow = this.#entries.length - this.#cap;
      this.#entries.splice(0, overflow);
    }
    return entry;
  }
  /** Return a copy of all entries (oldest first). */
  snapshot() {
    return this.#entries.slice();
  }
  /** Clear all entries. Called on `render-process-gone` per the state machine. */
  clear() {
    this.#entries.length = 0;
  }
  /**
   * Return entries matching the query. `since` is an inclusive-greater-than
   * cursor (id > since). Limit truncates the *most recent* N matches.
   */
  query(q = {}) {
    let out = this.#entries;
    if (q.since !== void 0) {
      out = out.filter((e) => e.id > q.since);
    }
    if (q.level !== void 0) {
      out = out.filter((e) => e.level === q.level);
    }
    if (q.limit !== void 0 && q.limit >= 0 && out.length > q.limit) {
      out = out.slice(out.length - q.limit);
    }
    return out;
  }
}
const CDP_PROTOCOL_VERSION = "1.3";
const ENABLED_DOMAINS = ["Runtime", "Page", "Log"];
const SIZE_LIMIT_BYTES = 1e6;
const DOWNSCALE_LONG_EDGE = 1920;
const JPEG_QUALITY = 80;
const passthroughRecompress = async (pngBase64) => ({ mimeType: "image/png", base64: pngBase64 });
class BrowserHandle {
  #wc;
  #state = "detached";
  #console = new ConsoleBuffer();
  #listeners = /* @__PURE__ */ new Set();
  #agentAllowed = false;
  #auditLog;
  #recompress;
  /** Child sessions discovered via Target.attachedToTarget (flat mode). */
  #childSessionIds = /* @__PURE__ */ new Set();
  // Retained references so wc event handlers can be removed on destroy.
  #onDomReady;
  #onDidNavigate;
  #onRenderProcessGone;
  #onDevtoolsClosed;
  #onWcDestroyed;
  #onDebuggerDetach;
  #onDebuggerMessage;
  constructor(wc, opts = {}) {
    this.#wc = wc;
    this.#auditLog = opts.auditLog ?? agentAuditLog;
    this.#recompress = opts.recompress ?? passthroughRecompress;
    this.#onDomReady = () => {
      void this.#handleDomReady();
    };
    this.#onDidNavigate = (_event, _url, _statusCode, _statusText, isMainFrame) => {
      if (isMainFrame === false) return;
      void this.#handleMainFrameNavigated();
    };
    this.#onRenderProcessGone = () => {
      this.#handleRenderProcessGone();
    };
    this.#onDevtoolsClosed = () => {
      void this.#handleDomReady();
    };
    this.#onWcDestroyed = () => {
      this.dispose();
    };
    this.#onDebuggerDetach = (_event, _reason) => {
      this.#state = "detached";
      this.#childSessionIds.clear();
    };
    this.#onDebuggerMessage = (_event, method, params, sessionId) => {
      this.#handleDebuggerMessage(method, params, sessionId);
    };
    this.#wc.on("dom-ready", this.#onDomReady);
    this.#wc.on("did-navigate", this.#onDidNavigate);
    this.#wc.on("render-process-gone", this.#onRenderProcessGone);
    this.#wc.on("devtools-closed", this.#onDevtoolsClosed);
    this.#wc.on("destroyed", this.#onWcDestroyed);
    this.#wc.debugger.on("detach", this.#onDebuggerDetach);
    this.#wc.debugger.on("message", this.#onDebuggerMessage);
  }
  get webContents() {
    return this.#wc;
  }
  get webContentsId() {
    return this.#wc.id;
  }
  get state() {
    return this.#state;
  }
  get agentAllowed() {
    return this.#agentAllowed;
  }
  /** Exposed for tests and IPC diagnostics. */
  get consoleBuffer() {
    return this.#console;
  }
  setAgentAllowed(allowed) {
    this.#agentAllowed = Boolean(allowed);
  }
  /**
   * Legacy element-picker toggle.
   *
   * The CDP-driven picker has been replaced by an in-page react-grab
   * overlay loaded via the guest preload. The renderer drives the picker
   * mode directly over the `<webview>`'s IPC channel now (see
   * `claxedo-picker:set-mode`), so this method is kept as a typed no-op
   * for IPC/test back-compat — callers that still invoke it get a stable
   * `{ ok: true }` and no CDP round-trip.
   */
  async setInspectMode(_enabled) {
    return { ok: true };
  }
  /**
   * Node-selected subscription — retained as a typed no-op for any
   * consumer that still references the old CDP-picker event stream. The
   * picker now emits its payload via the guest `<webview>`'s
   * `ipc-message` channel directly to the host renderer; nothing ever
   * lands in this listener set.
   */
  onNodeSelected(_cb) {
    return () => {
    };
  }
  /**
   * Manually trigger the attach path — useful when the handle is created
   * *after* `dom-ready` fired (e.g. race between webview load and paneId
   * registration). The dom-ready listener will also drive this naturally.
   */
  async attach() {
    await this.#handleDomReady();
  }
  /** Detach best-effort + drop listeners + clear buffer. Idempotent. */
  detach() {
    try {
      if (this.#wc.debugger.isAttached()) this.#wc.debugger.detach();
    } catch {
    }
    this.#state = "detached";
    this.#childSessionIds.clear();
  }
  dispose() {
    try {
      this.#wc.off("dom-ready", this.#onDomReady);
      this.#wc.off("did-navigate", this.#onDidNavigate);
      this.#wc.off("render-process-gone", this.#onRenderProcessGone);
      this.#wc.off("devtools-closed", this.#onDevtoolsClosed);
      this.#wc.off("destroyed", this.#onWcDestroyed);
      this.#wc.debugger.off("detach", this.#onDebuggerDetach);
      this.#wc.debugger.off("message", this.#onDebuggerMessage);
    } catch {
    }
    this.detach();
    this.#listeners.clear();
    this.#console.clear();
  }
  async navigate(url) {
    if (this.#wc.isDestroyed()) {
      throw new Error("webContents has been destroyed");
    }
    await this.#wc.loadURL(url);
  }
  // ─── Navigation / DevTools / Storage (toolbar-driven) ──────────────────────
  //
  // These are thin wrappers around `WebContents` calls. They exist so the IPC
  // layer has one place to route toolbar actions and `handle.test.ts` can stub
  // the minimal surface via `BrowserWc`.
  /**
   * Returns the current URL and whether back/forward are available. Callers
   * poll this after `did-navigate` so the toolbar can reflect the guest's
   * real history state without holding a separate signal on the main side.
   */
  getNavigationState() {
    let url = "";
    try {
      url = this.#wc.getURL() ?? "";
    } catch {
    }
    let canGoBack = false;
    let canGoForward = false;
    try {
      canGoBack = Boolean(this.#wc.canGoBack());
      canGoForward = Boolean(this.#wc.canGoForward());
    } catch {
    }
    return { url, canGoBack, canGoForward };
  }
  goBack() {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" };
    try {
      if (!this.#wc.canGoBack()) return { ok: false, error: "no-history" };
      this.#wc.goBack();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  goForward() {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" };
    try {
      if (!this.#wc.canGoForward()) return { ok: false, error: "no-history" };
      this.#wc.goForward();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  reload(hard = false) {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" };
    try {
      if (hard) this.#wc.reloadIgnoringCache();
      else this.#wc.reload();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  /**
   * Open Chromium DevTools for the guest in a detached window. This gives
   * the user the full Console / Network / Elements surface rather than only
   * our inline drawer. Opening DevTools will trigger `debugger.detach` — the
   * handle's existing detach listener already copes, and we reattach on
   * `devtools-closed`.
   */
  openDevTools(mode = "detach") {
    if (this.#wc.isDestroyed()) return { ok: false, error: "destroyed" };
    try {
      this.#wc.openDevTools({ mode });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  /**
   * Clear the `persist:agent-browser` session's storage. Defaults to cookies
   * only; callers may broaden the list via `storages`. Returns `ok: false`
   * if the underlying electron session isn't exposed on the fake.
   */
  async clearStorage(storages = ["cookies"]) {
    const sess = this.#wc.session;
    if (!sess || typeof sess.clearStorageData !== "function") {
      return { ok: false, error: "no-session" };
    }
    try {
      await sess.clearStorageData({ storages });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }
  // ─── Console ──────────────────────────────────────────────────────────────
  getConsoleLogs(q = {}) {
    return this.#console.query(q);
  }
  onConsoleEntry(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
  // ─── Screenshot ───────────────────────────────────────────────────────────
  async screenshot(opts = {}) {
    if (this.#state !== "attached") {
      return { ok: false, error: { code: "not-attached" } };
    }
    let currentUrl = "";
    try {
      currentUrl = this.#wc.getURL() ?? "";
    } catch {
    }
    if (currentUrl === "" || currentUrl === "about:blank") {
      return { ok: false, error: { code: "no-page" } };
    }
    let pngBase64;
    try {
      const params = {
        format: "png",
        captureBeyondViewport: false
      };
      if (opts.clip) params.clip = { ...opts.clip, scale: opts.clip.scale ?? 1 };
      const response = await this.#wc.debugger.sendCommand("Page.captureScreenshot", params);
      if (!response || typeof response.data !== "string") {
        return { ok: false, error: { code: "cdp-error", message: "Page.captureScreenshot returned no data" } };
      }
      pngBase64 = response.data;
    } catch (err) {
      return { ok: false, error: { code: "cdp-error", message: String(err instanceof Error ? err.message : err) } };
    }
    const approxBytes = Math.floor(pngBase64.length * 3 / 4);
    if (approxBytes <= SIZE_LIMIT_BYTES) {
      return { ok: true, dataUrl: `data:image/png;base64,${pngBase64}`, mimeType: "image/png" };
    }
    const jpeg = await this.#recompress(pngBase64, { toJpegQuality: JPEG_QUALITY });
    const jpegApproxBytes = Math.floor(jpeg.base64.length * 3 / 4);
    if (jpegApproxBytes <= SIZE_LIMIT_BYTES) {
      return {
        ok: true,
        dataUrl: `data:${jpeg.mimeType};base64,${jpeg.base64}`,
        mimeType: jpeg.mimeType
      };
    }
    const downscaled = await this.#recompress(pngBase64, {
      toJpegQuality: JPEG_QUALITY,
      maxLongEdge: DOWNSCALE_LONG_EDGE
    });
    return {
      ok: true,
      dataUrl: `data:${downscaled.mimeType};base64,${downscaled.base64}`,
      mimeType: downscaled.mimeType
    };
  }
  // ─── Evaluate ─────────────────────────────────────────────────────────────
  async evaluate(expression) {
    if (!this.#agentAllowed) {
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", "agent-not-allowed");
      return { ok: false, error: { code: "eval-denied", message: "pane has not opted into agent JS execution" } };
    }
    if (this.#state !== "attached") {
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", "not-attached");
      return { ok: false, error: { code: "not-attached" } };
    }
    let resp;
    try {
      resp = await this.#wc.debugger.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      this.#audit("evaluate", `eval (${expression.length} chars)`, "denied", message);
      return { ok: false, error: { code: "cdp-error", message } };
    }
    if (resp && resp.exceptionDetails) {
      const details = resp.exceptionDetails;
      const message = details.exception?.description ?? (typeof details.text === "string" ? details.text : "script error");
      const stack = details.stackTrace?.callFrames?.map((f) => `${f.functionName ?? "(anonymous)"} (${f.url ?? "?"}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0})`).join("\n");
      this.#audit("evaluate", `eval (${expression.length} chars)`, "allowed", message);
      return { ok: false, error: { code: "script-error", message, stack } };
    }
    this.#audit("evaluate", `eval (${expression.length} chars)`, "allowed");
    return { ok: true, result: resp?.result?.value };
  }
  // ─── Internal: state transitions ──────────────────────────────────────────
  async #handleDomReady() {
    if (this.#state === "attaching" || this.#state === "reattaching") return;
    if (this.#wc.isDestroyed()) return;
    const isReattach = this.#state === "attached";
    this.#state = isReattach ? "reattaching" : "attaching";
    try {
      if (!this.#wc.debugger.isAttached()) {
        this.#wc.debugger.attach(CDP_PROTOCOL_VERSION);
      }
      await this.#wc.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
      await this.#enableDomainsForSession(void 0);
      this.#state = "attached";
    } catch {
      this.#state = "detached";
    }
  }
  async #handleMainFrameNavigated() {
    if (this.#state !== "attached") {
      return;
    }
    this.#childSessionIds.clear();
    try {
      await this.#wc.debugger.sendCommand("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      });
      await this.#enableDomainsForSession(void 0);
    } catch {
    }
  }
  #handleRenderProcessGone() {
    this.#childSessionIds.clear();
    this.#console.clear();
    this.#state = "detached";
  }
  async #enableDomainsForSession(sessionId) {
    for (const domain of ENABLED_DOMAINS) {
      try {
        await this.#wc.debugger.sendCommand(`${domain}.enable`, {}, sessionId);
      } catch {
      }
    }
  }
  // ─── Internal: debugger message routing ───────────────────────────────────
  #handleDebuggerMessage(method, params, sessionId) {
    switch (method) {
      case "Target.attachedToTarget": {
        const p = params;
        if (p?.sessionId) {
          this.#childSessionIds.add(p.sessionId);
          void this.#enableDomainsForSession(p.sessionId);
        }
        return;
      }
      case "Target.detachedFromTarget": {
        const p = params;
        if (p?.sessionId) this.#childSessionIds.delete(p.sessionId);
        return;
      }
      case "Runtime.consoleAPICalled": {
        const p = params;
        if (!p) return;
        const level = mapConsoleType(p.type);
        const args = (p.args ?? []).map(describeRemoteObject);
        this.#emit({
          level,
          args,
          source: "console",
          sessionId: sessionId || void 0,
          stack: p.stackTrace ? mapStackTrace(p.stackTrace) : void 0
        });
        return;
      }
      case "Runtime.exceptionThrown": {
        const p = params;
        if (!p) return;
        const details = p.exceptionDetails;
        const text = details?.exception?.description ?? details?.text ?? details?.exception?.value ?? "Uncaught exception";
        this.#emit({
          level: "error",
          args: [String(text)],
          source: "exception",
          sessionId: sessionId || void 0,
          stack: details?.stackTrace ? mapStackTrace(details.stackTrace) : void 0
        });
        return;
      }
      case "Log.entryAdded": {
        const p = params;
        if (!p?.entry) return;
        const level = mapLogLevel(p.entry.level);
        const args = [];
        if (typeof p.entry.text === "string") args.push(p.entry.text);
        if (p.entry.url) args.push(`(${p.entry.url})`);
        this.#emit({
          level,
          args,
          source: "log",
          sessionId: sessionId || void 0,
          stack: p.entry.stackTrace ? mapStackTrace(p.entry.stackTrace) : void 0
        });
        return;
      }
      default:
        return;
    }
  }
  #emit(input) {
    const entry = this.#console.append(input);
    for (const fn of this.#listeners) {
      try {
        fn(entry);
      } catch {
      }
    }
  }
  #audit(action, summary, result, reason) {
    try {
      this.#auditLog.append({
        paneId: `wc:${this.#wc.id}`,
        action,
        summary,
        result,
        reason
      });
    } catch {
    }
  }
}
function mapConsoleType(t) {
  switch (t) {
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "info":
      return "info";
    case "debug":
    case "trace":
      return "debug";
    case "log":
    default:
      return "log";
  }
}
function mapLogLevel(l) {
  switch (l) {
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "verbose":
    case "debug":
      return "debug";
    case "info":
      return "info";
    default:
      return "log";
  }
}
function describeRemoteObject(arg) {
  if (arg.value !== void 0) {
    return typeof arg.value === "string" ? arg.value : safeStringify(arg.value);
  }
  if (typeof arg.description === "string") return arg.description;
  return arg.type ?? "";
}
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
function mapStackTrace(st) {
  if (!st?.callFrames?.length) return void 0;
  return st.callFrames.map((f) => ({
    url: f.url,
    function: f.functionName,
    line: f.lineNumber,
    column: f.columnNumber
  }));
}
class BrowserRegistry {
  #handles = /* @__PURE__ */ new Map();
  #fromId;
  constructor(fromId) {
    this.#fromId = fromId;
  }
  /**
   * Register a paneId -> webContents mapping. Returns the new handle.
   *
   * Throws if the webContentsId does not resolve, if it is destroyed, or if
   * the paneId is already registered to a different webContents. If the same
   * paneId + webContents pair is re-registered (e.g. dom-ready fires twice),
   * the existing handle is returned unchanged.
   */
  register(paneId, webContentsId) {
    if (!paneId) {
      throw new Error("BrowserRegistry.register: paneId is required");
    }
    const wc = this.#fromId(webContentsId);
    if (!wc) {
      throw new Error(`BrowserRegistry.register: webContents ${webContentsId} not found`);
    }
    if (wc.isDestroyed()) {
      throw new Error(`BrowserRegistry.register: webContents ${webContentsId} is destroyed`);
    }
    const existing = this.#handles.get(paneId);
    if (existing) {
      if (existing.webContentsId === webContentsId) return existing;
      throw new Error(
        `BrowserRegistry.register: paneId ${paneId} already bound to different webContents ${existing.webContentsId}`
      );
    }
    const handle = new BrowserHandle(wc);
    this.#handles.set(paneId, handle);
    return handle;
  }
  /**
   * Unregister a paneId. Disposes the handle (detaches the CDP debugger and
   * removes event listeners) and removes the handle. Safe to call for an
   * unknown paneId.
   */
  unregister(paneId) {
    const handle = this.#handles.get(paneId);
    if (!handle) return;
    try {
      handle.dispose();
    } catch {
    }
    this.#handles.delete(paneId);
  }
  /**
   * Fetch the handle for a paneId, or undefined if none is registered.
   */
  get(paneId) {
    return this.#handles.get(paneId);
  }
  /** Enumerate currently-registered paneIds (stable order). */
  paneIds() {
    return Array.from(this.#handles.keys());
  }
  /** Clear every handle. Detach attempts are best-effort. */
  clear() {
    for (const paneId of Array.from(this.#handles.keys())) {
      this.unregister(paneId);
    }
  }
}
function resolveGuestPreloadUrl() {
  const candidates = [
    path.join(__dirname, "..", "preload", "browser-preload.cjs"),
    path.join(__dirname, "..", "..", "preload", "browser-preload.cjs")
  ];
  for (const abs of candidates) {
    try {
      if (existsSync(abs)) return abs;
    } catch {
    }
  }
  log.warn("[browser-tab] browser-preload.cjs not found; picker overlay will be disabled");
  return void 0;
}
function setupBrowserTab() {
  if (!isBrowserTabEnabled()) return void 0;
  const willAttach = createWillAttachWebviewHandler({
    partition: AGENT_BROWSER_PARTITION,
    guestPreloadUrl: resolveGuestPreloadUrl(),
    onReject: (reason, params) => {
      log.warn("[browser-tab] will-attach-webview rejected", {
        reason,
        src: params.src,
        partition: params.partition
      });
    }
  });
  const willAttachListener = (event, webPreferences, params) => {
    willAttach(
      event,
      webPreferences,
      params
    );
  };
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", willAttachListener);
    try {
      const sessionPartition = contents.session?.partition;
      if (contents.getType?.() === "webview" || sessionPartition === AGENT_BROWSER_PARTITION) {
        installAgentBrowserNavigationGuards(contents);
      }
    } catch (err) {
      log.warn("[browser-tab] failed to install navigation guards", { error: String(err) });
    }
  });
  app.whenReady().then(() => {
    try {
      configureAgentBrowserPartition();
    } catch (err) {
      log.error("[browser-tab] failed to configure partition", { error: String(err) });
    }
  });
  const registry = new BrowserRegistry((id) => webContents.fromId(id) ?? void 0);
  const token = ensureDesktopToken();
  process.env.CLAXEDO_DESKTOP_TOKEN = token;
  const bridge = app.whenReady().then(async () => {
    try {
      const started = await startDesktopHttpBridge({ registry });
      process.env.CLAXEDO_DESKTOP_URL = started.url;
      log.info("[browser-tab] bridge listening", { url: started.url });
      return started;
    } catch (err) {
      log.error("[browser-tab] bridge failed to start", { error: String(err) });
      throw err;
    }
  });
  return { registry, partition: AGENT_BROWSER_PARTITION, bridge };
}
const raw = "dev";
const CHANNEL = raw;
const SETTINGS_STORE = "claxedo.settings";
const DEFAULT_SERVER_URL_KEY = "defaultServerUrl";
const WSL_ENABLED_KEY = "wslEnabled";
const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev";
const cache = /* @__PURE__ */ new Map();
function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name);
  if (cached) return cached;
  const next = new Store({ name });
  cache.set(name, next);
  return next;
}
const store = getStore(SETTINGS_STORE);
const CLI_INSTALL_DIR = ".opencode/bin";
const CLI_BINARY_NAME = "opencode";
const root$1 = dirname(fileURLToPath(import.meta.url));
function getSidecarPath() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const path2 = app.isPackaged ? join(process.resourcesPath, `opencode-cli${suffix}`) : join(root$1, "../../resources", `opencode-cli${suffix}`);
  return path2;
}
async function getConfig() {
  const { events } = spawnCommand("debug config", {});
  let output = "";
  await new Promise((resolve) => {
    events.on("stdout", (line) => {
      output += line;
    });
    events.on("stderr", (line) => {
      output += line;
    });
    events.on("terminated", () => resolve());
    events.on("error", () => resolve());
  });
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}
async function installCli() {
  if (process.platform === "win32") {
    throw new Error("CLI installation is only supported on macOS & Linux");
  }
  const sidecar2 = getSidecarPath();
  const scriptPath = join(app.getAppPath(), "install");
  const script = readFileSync(scriptPath, "utf8");
  const tempScript = join(tmpdir(), "opencode-install.sh");
  writeFileSync(tempScript, script, "utf8");
  chmodSync(tempScript, 493);
  const cmd = spawn(tempScript, ["--binary", sidecar2], { stdio: "pipe" });
  return await new Promise((resolve, reject) => {
    cmd.on("exit", (code) => {
      try {
        unlinkSync(tempScript);
      } catch {
      }
      if (code === 0) {
        const installPath = getCliInstallPath();
        if (installPath) return resolve(installPath);
        return reject(new Error("Could not determine install path"));
      }
      reject(new Error("Install script failed"));
    });
  });
}
function syncCli() {
  if (!app.isPackaged) return;
  const installPath = getCliInstallPath();
  if (!installPath) return;
  let version = "";
  try {
    version = execFileSync(installPath, ["--version"]).toString().trim();
  } catch {
    return;
  }
  const cli = parseVersion(version);
  const appVersion = parseVersion(app.getVersion());
  if (!cli || !appVersion) return;
  if (compareVersions(cli, appVersion) >= 0) return;
  void installCli().catch(() => void 0);
}
function serve(hostname, port, password) {
  const args = `--print-logs --log-level WARN serve --hostname ${hostname} --port ${port}`;
  const env = {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password
  };
  return spawnCommand(args, env);
}
function spawnCommand(args, extraEnv) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string")
  );
  const envs = {
    ...base,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: app.getPath("userData"),
    ...extraEnv
  };
  const { cmd, cmdArgs } = buildCommand(args, envs);
  const child = spawn(cmd, cmdArgs, {
    env: envs,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const events = new EventEmitter();
  const exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code: code ?? null, signal: null });
    });
    child.on("error", (error) => {
      console.error(`[cli] Process error: ${error.message}`);
      events.emit("error", error.message);
    });
  });
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (stdout) {
    readline.createInterface({ input: stdout }).on("line", (line) => {
      if (handleSqliteProgress(events, line)) return;
      events.emit("stdout", `${line}
`);
    });
  }
  if (stderr) {
    readline.createInterface({ input: stderr }).on("line", (line) => {
      if (handleSqliteProgress(events, line)) return;
      events.emit("stderr", `${line}
`);
    });
  }
  exit.then((payload) => {
    events.emit("terminated", payload);
  });
  const kill = () => {
    if (!child.pid) return;
    treeKill(child.pid);
  };
  return { events, child: { kill }, exit };
}
function handleSqliteProgress(events, line) {
  const stripped = line.startsWith("sqlite-migration:") ? line.slice("sqlite-migration:".length).trim() : null;
  if (!stripped) return false;
  if (stripped === "done") {
    events.emit("sqlite", { type: "Done" });
    return true;
  }
  const value = Number.parseInt(stripped, 10);
  if (!Number.isNaN(value)) {
    events.emit("sqlite", { type: "InProgress", value });
    return true;
  }
  return false;
}
function buildCommand(args, env) {
  if (process.platform === "win32" && isWslEnabled()) {
    const version = app.getVersion();
    const script = [
      "set -e",
      'BIN="$HOME/.opencode/bin/opencode"',
      'if [ ! -x "$BIN" ]; then',
      `  curl -fsSL https://opencode.ai/install | bash -s -- --version ${shellEscape(version)} --no-modify-path`,
      "fi",
      `${envPrefix(env)} exec "$BIN" ${args}`
    ].join("\n");
    return { cmd: "wsl", cmdArgs: ["-e", "bash", "-lc", script] };
  }
  if (process.platform === "win32") {
    const sidecar22 = getSidecarPath();
    return { cmd: sidecar22, cmdArgs: args.split(" ") };
  }
  const sidecar2 = getSidecarPath();
  const shell2 = process.env.SHELL || "/bin/sh";
  const line = shell2.endsWith("/nu") ? `^"${sidecar2}" ${args}` : `exec "${sidecar2}" ${args}`;
  return { cmd: shell2, cmdArgs: ["-l", "-c", line] };
}
function envPrefix(env) {
  const entries = Object.entries(env).map(([key, value]) => `${key}=${shellEscape(value)}`);
  return entries.join(" ");
}
function shellEscape(input) {
  if (!input) return "''";
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}
function getCliInstallPath() {
  const home = process.env.HOME;
  if (!home) return null;
  return join(home, CLI_INSTALL_DIR, CLI_BINARY_NAME);
}
function isWslEnabled() {
  return store.get(WSL_ENABLED_KEY) === true;
}
function parseVersion(value) {
  const parts = value.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts;
}
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}
function registerIpcHandlers(deps) {
  ipcMain.handle("kill-sidecar", () => deps.killSidecar());
  ipcMain.handle("install-cli", () => deps.installCli());
  ipcMain.handle("await-initialization", (event) => {
    const send = (step) => event.sender.send("init-step", step);
    return deps.awaitInitialization(send);
  });
  ipcMain.handle("get-default-server-url", () => deps.getDefaultServerUrl());
  ipcMain.handle(
    "set-default-server-url",
    (_event, url) => deps.setDefaultServerUrl(url)
  );
  ipcMain.handle("get-wsl-config", () => deps.getWslConfig());
  ipcMain.handle("set-wsl-config", (_event, config) => deps.setWslConfig(config));
  ipcMain.handle("get-display-backend", () => deps.getDisplayBackend());
  ipcMain.handle(
    "set-display-backend",
    (_event, backend) => deps.setDisplayBackend(backend)
  );
  ipcMain.handle("parse-markdown", (_event, markdown) => deps.parseMarkdown(markdown));
  ipcMain.handle("check-app-exists", (_event, appName) => deps.checkAppExists(appName));
  ipcMain.handle(
    "wsl-path",
    (_event, path2, mode) => deps.wslPath(path2, mode)
  );
  ipcMain.handle("resolve-app-path", (_event, appName) => deps.resolveAppPath(appName));
  ipcMain.on("loading-window-complete", () => deps.loadingWindowComplete());
  ipcMain.handle("run-updater", (_event, alertOnFail) => deps.runUpdater(alertOnFail));
  ipcMain.handle("check-update", () => deps.checkUpdate());
  ipcMain.handle("install-update", () => deps.installUpdate());
  ipcMain.handle("store-get", (_event, name, key) => {
    const store2 = getStore(name);
    const value = store2.get(key);
    if (value === void 0 || value === null) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  });
  ipcMain.handle("store-set", (_event, name, key, value) => {
    getStore(name).set(key, value);
  });
  ipcMain.handle("store-delete", (_event, name, key) => {
    getStore(name).delete(key);
  });
  ipcMain.handle("store-clear", (_event, name) => {
    getStore(name).clear();
  });
  ipcMain.handle("store-keys", (_event, name) => {
    const store2 = getStore(name);
    return Object.keys(store2.store);
  });
  ipcMain.handle("store-length", (_event, name) => {
    const store2 = getStore(name);
    return Object.keys(store2.store).length;
  });
  ipcMain.handle(
    "open-directory-picker",
    async (_event, opts) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...opts?.multiple ? ["multiSelections"] : []],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath
      });
      if (result.canceled) return null;
      return opts?.multiple ? result.filePaths : result.filePaths[0];
    }
  );
  ipcMain.handle(
    "open-file-picker",
    async (_event, opts) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...opts?.multiple ? ["multiSelections"] : []],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath
      });
      if (result.canceled) return null;
      return opts?.multiple ? result.filePaths : result.filePaths[0];
    }
  );
  ipcMain.handle(
    "save-file-picker",
    async (_event, opts) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath
      });
      if (result.canceled) return null;
      return result.filePath ?? null;
    }
  );
  ipcMain.on("open-link", (_event, url) => {
    void shell.openExternal(url);
  });
  ipcMain.handle("open-path", async (_event, path2, app2) => {
    if (!app2) return shell.openPath(path2);
    await new Promise((resolve, reject) => {
      const [cmd, args] = process.platform === "darwin" ? ["open", ["-a", app2, path2]] : [app2, [path2]];
      execFile(cmd, args, (err) => err ? reject(err) : resolve());
    });
  });
  ipcMain.handle("read-clipboard-image", () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const buffer = image.toPNG().buffer;
    const size = image.getSize();
    return { buffer, width: size.width, height: size.height };
  });
  ipcMain.handle("write-clipboard-image", (_event, buffer) => {
    const image = nativeImage.createFromBuffer(Buffer.from(buffer));
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });
  ipcMain.on("show-notification", (_event, title, body) => {
    new Notification({ title, body }).show();
  });
  ipcMain.handle("get-window-focused", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFocused() ?? false;
  });
  ipcMain.handle("get-window-fullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isFullScreen() ?? false;
  });
  ipcMain.handle("set-window-focus", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.focus();
  });
  ipcMain.handle("show-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.show();
  });
  ipcMain.on("relaunch", () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.on("quit", () => {
    app.quit();
  });
  ipcMain.handle("get-zoom-factor", (event) => event.sender.getZoomFactor());
  ipcMain.handle("set-zoom-factor", (event, factor) => event.sender.setZoomFactor(factor));
  ipcMain.on("set-native-theme", (_event, theme) => {
    nativeTheme.themeSource = theme;
  });
  registerBrowserIpcHandlers(deps.browser);
}
function registerBrowserIpcHandlers(registry) {
  ipcMain.handle("browser:enabled", () => Boolean(registry));
  if (!registry) return;
  ipcMain.handle(
    "browser:register",
    (_event, paneId, webContentsId) => {
      try {
        const handle = registry.register(paneId, webContentsId);
        return { ok: true, webContentsId: handle.webContentsId };
      } catch (err) {
        return { ok: false, error: String(err instanceof Error ? err.message : err) };
      }
    }
  );
  ipcMain.handle("browser:unregister", (_event, paneId) => {
    registry.unregister(paneId);
    return { ok: true };
  });
  ipcMain.handle(
    "browser:navigate",
    async (_event, paneId, url) => {
      const handle = registry.get(paneId);
      if (!handle) {
        return { ok: false, error: `no browser pane registered for ${paneId}` };
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, error: `scheme ${parsed.protocol} not allowed` };
        }
      } catch {
        return { ok: false, error: `invalid url: ${url}` };
      }
      try {
        await handle.navigate(url);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err instanceof Error ? err.message : err) };
      }
    }
  );
  ipcMain.handle(
    "browser:getConsoleLogs",
    (_event, paneId, q) => {
      const handle = registry.get(paneId);
      if (!handle) return [];
      return handle.getConsoleLogs(q ?? {});
    }
  );
  const consoleSubs = /* @__PURE__ */ new Map();
  const subKey = (paneId, senderId) => `${senderId}:${paneId}`;
  ipcMain.handle("browser:subscribeConsole", (event, paneId) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    const key = subKey(paneId, event.sender.id);
    if (consoleSubs.has(key)) return { ok: true };
    const unsubscribe = handle.onConsoleEntry((entry) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(`browser:onConsoleEntry:${paneId}`, entry);
    });
    consoleSubs.set(key, unsubscribe);
    const cleanup2 = () => {
      const fn = consoleSubs.get(key);
      if (fn) {
        try {
          fn();
        } catch {
        }
        consoleSubs.delete(key);
      }
    };
    event.sender.once("destroyed", cleanup2);
    return { ok: true };
  });
  ipcMain.handle("browser:unsubscribeConsole", (event, paneId) => {
    const key = subKey(paneId, event.sender.id);
    const fn = consoleSubs.get(key);
    if (fn) {
      try {
        fn();
      } catch {
      }
      consoleSubs.delete(key);
    }
    return { ok: true };
  });
  ipcMain.handle(
    "browser:captureScreenshot",
    async (_event, paneId, opts) => {
      const handle = registry.get(paneId);
      if (!handle) return { ok: false, error: { code: "no-pane", message: `no browser pane registered for ${paneId}` } };
      return handle.screenshot(opts ?? {});
    }
  );
  ipcMain.handle("browser:evaluate", async (_event, paneId, expression) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: { code: "no-pane", message: `no browser pane registered for ${paneId}` } };
    return handle.evaluate(expression);
  });
  ipcMain.handle("browser:setAgentAllowed", (_event, paneId, allowed) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    handle.setAgentAllowed(Boolean(allowed));
    return { ok: true };
  });
  ipcMain.handle("browser:setInspectMode", async (_event, paneId, enabled) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    return handle.setInspectMode(Boolean(enabled));
  });
  const nodeSubs = /* @__PURE__ */ new Map();
  const nodeKey = (paneId, senderId) => `${senderId}:${paneId}`;
  ipcMain.handle("browser:subscribeNodeSelected", (event, paneId) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    const key = nodeKey(paneId, event.sender.id);
    if (nodeSubs.has(key)) return { ok: true };
    const unsubscribe = handle.onNodeSelected((payload) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(`browser:onNodeSelected:${paneId}`, payload);
    });
    nodeSubs.set(key, unsubscribe);
    const cleanup2 = () => {
      const fn = nodeSubs.get(key);
      if (fn) {
        try {
          fn();
        } catch {
        }
        nodeSubs.delete(key);
      }
    };
    event.sender.once("destroyed", cleanup2);
    return { ok: true };
  });
  ipcMain.handle("browser:unsubscribeNodeSelected", (event, paneId) => {
    const key = nodeKey(paneId, event.sender.id);
    const fn = nodeSubs.get(key);
    if (fn) {
      try {
        fn();
      } catch {
      }
      nodeSubs.delete(key);
    }
    return { ok: true };
  });
  ipcMain.handle("browser:getNavigationState", (_event, paneId) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    const state = handle.getNavigationState();
    return { ok: true, ...state };
  });
  ipcMain.handle("browser:goBack", (_event, paneId) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    return handle.goBack();
  });
  ipcMain.handle("browser:goForward", (_event, paneId) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    return handle.goForward();
  });
  ipcMain.handle("browser:reload", (_event, paneId, hard) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    return handle.reload(Boolean(hard));
  });
  ipcMain.handle("browser:openDevTools", (_event, paneId) => {
    const handle = registry.get(paneId);
    if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
    return handle.openDevTools("detach");
  });
  ipcMain.handle(
    "browser:clearStorage",
    async (_event, paneId, storages) => {
      const handle = registry.get(paneId);
      if (!handle) return { ok: false, error: `no browser pane registered for ${paneId}` };
      return handle.clearStorage(storages);
    }
  );
}
function sendSqliteMigrationProgress(win, progress) {
  win.webContents.send("sqlite-migration-progress", progress);
}
function sendMenuCommand(win, id) {
  win.webContents.send("menu-command", id);
}
function sendDeepLinks(win, urls) {
  win.webContents.send("deep-link", urls);
}
function wireFullscreenEvents(win) {
  const send = (fs) => {
    if (!win.isDestroyed()) win.webContents.send("fullscreen-change", fs);
  };
  win.on("enter-full-screen", () => send(true));
  win.on("leave-full-screen", () => send(false));
}
const MAX_LOG_AGE_DAYS = 7;
function initLogging() {
  log.transports.file.maxSize = 5 * 1024 * 1024;
  cleanup();
  return log;
}
function cleanup() {
  const path2 = log.transports.file.getFile().path;
  const dir = dirname(path2);
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1e3;
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    try {
      const info = statSync(file);
      if (!info.isFile()) continue;
      if (info.mtimeMs < cutoff) unlinkSync(file);
    } catch {
      continue;
    }
  }
}
const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
};
function parseMarkdown(input) {
  return marked(input, {
    renderer,
    breaks: false,
    gfm: true
  });
}
function createMenu(deps) {
  if (process.platform !== "darwin") return;
  const template = [
    {
      label: "Claxedo",
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          enabled: UPDATER_ENABLED,
          click: () => deps.checkForUpdates()
        },
        {
          label: "Install CLI...",
          click: () => deps.installCli()
        },
        {
          label: "Reload Webview",
          click: () => deps.reload()
        },
        {
          label: "Restart",
          click: () => deps.relaunch()
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "File",
      submenu: [
        { label: "New Session", accelerator: "Shift+Cmd+S", click: () => deps.trigger("session.new") },
        { label: "Open Project...", accelerator: "Cmd+O", click: () => deps.trigger("project.open") },
        { type: "separator" },
        { label: "Toggle Split View", accelerator: "Cmd+\\", click: () => deps.trigger("claxedo.split.toggle") },
        { label: "Close Tab", accelerator: "Cmd+W", click: () => deps.trigger("claxedo.tab.close") },
        { type: "separator" },
        { label: "Close Window", click: () => BrowserWindow.getFocusedWindow()?.close() }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", accelerator: "Cmd+B", click: () => deps.trigger("sidebar.toggle") },
        { label: "Toggle Terminal", accelerator: "Ctrl+`", click: () => deps.trigger("terminal.toggle") },
        { label: "Toggle File Tree", click: () => deps.trigger("fileTree.toggle") },
        { type: "separator" },
        { label: "Back", click: () => deps.trigger("common.goBack") },
        { label: "Forward", click: () => deps.trigger("common.goForward") },
        { type: "separator" },
        {
          label: "Previous Session",
          accelerator: "Option+ArrowUp",
          click: () => deps.trigger("session.previous")
        },
        {
          label: "Next Session",
          accelerator: "Option+ArrowDown",
          click: () => deps.trigger("session.next")
        },
        { type: "separator" },
        {
          label: "Toggle Developer Tools",
          accelerator: "Alt+Cmd+I",
          click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools()
        }
      ]
    },
    {
      label: "Help",
      submenu: [
        { label: "Claxedo Documentation", click: () => shell.openExternal("https://claxedo.ai/docs") },
        { type: "separator" },
        {
          label: "Share Feedback",
          click: () => shell.openExternal("https://github.com/kyashrathore/Claxedo/issues/new")
        },
        {
          label: "Report a Bug",
          click: () => shell.openExternal("https://github.com/kyashrathore/Claxedo/issues/new")
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
function getDefaultServerUrl() {
  const value = store.get(DEFAULT_SERVER_URL_KEY);
  return typeof value === "string" ? value : null;
}
function setDefaultServerUrl(url) {
  if (url) {
    store.set(DEFAULT_SERVER_URL_KEY, url);
    return;
  }
  store.delete(DEFAULT_SERVER_URL_KEY);
}
function getWslConfig() {
  const value = store.get(WSL_ENABLED_KEY);
  return { enabled: typeof value === "boolean" ? value : false };
}
function setWslConfig(config) {
  store.set(WSL_ENABLED_KEY, config.enabled);
}
async function getSavedServerUrl() {
  const direct = getDefaultServerUrl();
  if (direct) return direct;
  const config = await getConfig().catch(() => null);
  if (!config) return null;
  return getServerUrlFromConfig(config);
}
function spawnLocalServer(hostname, port, password) {
  const { child, exit, events } = serve(hostname, port, password);
  const wait = (async () => {
    const url = `http://${hostname}:${port}`;
    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const ok = await checkHealth(url, password);
        if (ok) return;
      }
    };
    const terminated = async () => {
      const payload = await exit;
      throw new Error(
        `Sidecar terminated before becoming healthy (code=${payload.code ?? "unknown"} signal=${payload.signal ?? "unknown"})`
      );
    };
    await Promise.race([ready(), terminated()]);
  })();
  return { child, health: { wait }, events };
}
async function checkHealth(url, password) {
  let healthUrl;
  try {
    healthUrl = new URL("/global/health", url);
  } catch {
    return false;
  }
  const headers = new Headers();
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64");
    headers.set("authorization", `Basic ${auth}`);
  }
  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3e3)
    });
    return res.ok;
  } catch {
    return false;
  }
}
async function checkHealthOrAskRetry(url) {
  while (true) {
    if (await checkHealth(url)) return true;
    const result = await dialog.showMessageBox({
      type: "warning",
      message: `Could not connect to configured server:
${url}

Would you like to retry or start a local server instead?`,
      title: "Connection Failed",
      buttons: ["Retry", "Start Local"],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) continue;
    return false;
  }
}
function normalizeHostnameForUrl(hostname) {
  if (hostname === "0.0.0.0") return "127.0.0.1";
  if (hostname === "::") return "[::1]";
  if (hostname.includes(":") && !hostname.startsWith("[")) return `[${hostname}]`;
  return hostname;
}
function getServerUrlFromConfig(config) {
  const server = config.server;
  if (!server?.port) return null;
  const host = server.hostname ? normalizeHostnameForUrl(server.hostname) : "127.0.0.1";
  return `http://${host}:${server.port}`;
}
const root = dirname(fileURLToPath(import.meta.url));
function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons");
}
function iconPath() {
  const ext = process.platform === "win32" ? "ico" : "png";
  return join(iconsDir(), `icon.${ext}`);
}
function setDockIcon() {
  if (process.platform !== "darwin") return;
  app.dock?.setIcon(nativeImage.createFromPath(join(iconsDir(), "128x128@2x.png")));
}
function createMainWindow(globals) {
  const state = windowState({
    defaultWidth: 1280,
    defaultHeight: 800
  });
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: true,
    title: "Claxedo",
    icon: iconPath(),
    ...process.platform === "darwin" ? {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 12, y: 12 }
    } : {},
    ...process.platform === "win32" ? {
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "transparent",
        symbolColor: "#999",
        height: 40
      }
    } : {},
    webPreferences: {
      preload: join(root, "../preload/index.cjs"),
      sandbox: false,
      webviewTag: isBrowserTabEnabled()
    }
  });
  state.manage(win);
  loadWindow(win, "index.html");
  wireZoom(win);
  injectGlobals(win, globals);
  devtools(win);
  return win;
}
function createLoadingWindow(globals) {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    resizable: false,
    center: true,
    show: true,
    icon: iconPath(),
    ...process.platform === "darwin" ? { titleBarStyle: "hidden" } : {},
    ...process.platform === "win32" ? {
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "transparent",
        symbolColor: "#999",
        height: 40
      }
    } : {},
    webPreferences: {
      preload: join(root, "../preload/index.cjs"),
      sandbox: false,
      webviewTag: isBrowserTabEnabled()
    }
  });
  loadWindow(win, "loading.html");
  injectGlobals(win, globals);
  return win;
}
function loadWindow(win, html) {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const url = new URL(html, devUrl);
    void win.loadURL(url.toString());
    return;
  }
  void win.loadFile(join(root, `../renderer/${html}`));
}
function devtools(win) {
  if (!process.env.ELECTRON_RENDERER_URL) return;
  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.openDevTools({ mode: "undocked" });
  });
}
function injectGlobals(win, globals) {
  win.webContents.on("dom-ready", () => {
    const deepLinks = globals.deepLinks ?? [];
    const data = {
      updaterEnabled: globals.updaterEnabled,
      wsl: globals.wsl,
      deepLinks: Array.isArray(deepLinks) ? deepLinks.splice(0) : deepLinks
    };
    void win.webContents.executeJavaScript(
      `window.__OPENCODE__ = Object.assign(window.__OPENCODE__ ?? {}, ${JSON.stringify(data)})`
    );
  });
}
function wireZoom(win) {
  win.webContents.setZoomFactor(1);
  win.webContents.on("zoom-changed", () => {
    win.webContents.setZoomFactor(1);
  });
}
const APP_NAMES = {
  dev: "Claxedo Dev",
  beta: "Claxedo Beta",
  prod: "Claxedo"
};
const APP_IDS = {
  dev: "ai.claxedo.desktop.dev",
  beta: "ai.claxedo.desktop.beta",
  prod: "ai.claxedo.desktop"
};
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "Claxedo Dev");
app.setPath("userData", join(app.getPath("appData"), app.isPackaged ? APP_IDS[CHANNEL] : "ai.claxedo.desktop.dev"));
const { autoUpdater } = pkg;
const initEmitter = new EventEmitter();
let initStep = { phase: "server_waiting" };
let mainWindow = null;
let sidecar = null;
let claxedoServerHandle = null;
let local = null;
let quitting = false;
const loadingComplete = defer();
const browserTabSetup = setupBrowserTab();
const browserRegistry = browserTabSetup?.registry;
const browserBridgePromise = browserTabSetup?.bridge;
const pendingDeepLinks = [];
const serverReady = defer();
const logger = initLogging();
logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged
});
setupApp();
function setupApp() {
  ensureLoopbackNoProxy();
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>");
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", (_event, argv) => {
    const urls = argv.filter((arg) => arg.startsWith("claxedo://"));
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls });
      emitDeepLinks(urls);
    }
    focusMainWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    logger.log("deep link received via open-url", { url });
    emitDeepLinks([url]);
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
  });
  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("claxedo");
    setDockIcon();
    syncCli();
    await initialize();
  });
}
function emitDeepLinks(urls) {
  if (urls.length === 0) return;
  pendingDeepLinks.push(...urls);
  if (mainWindow) sendDeepLinks(mainWindow, urls);
}
function focusMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}
function setInitStep(step) {
  initStep = step;
  logger.log("init step", { step });
  initEmitter.emit("step", step);
}
const MAIN_DIR = import.meta.dirname;
function getClaxedoServerPath() {
  return app.isPackaged ? join(MAIN_DIR, "claxedo-server.js") : join(MAIN_DIR, "../../resources/claxedo-server.js");
}
async function startClaxedoServer(opencodeUrl, opencodePassword) {
  const claxedoPort = await getFreePort();
  const serverPath = getClaxedoServerPath();
  logger.log("starting claxedo-server", { serverPath, claxedoPort, opencodeUrl });
  if (!existsSync(serverPath)) {
    logger.warn("claxedo-server.js not found, skipping", { serverPath });
    return { url: opencodeUrl };
  }
  const acpDir = app.isPackaged ? join(process.resourcesPath, "acp") : join(MAIN_DIR, "../../resources/acp");
  if (existsSync(acpDir)) {
    process.env.CLAXEDO_ACP_DIR = acpDir;
    if (!process.env.CLAUDE_CODE_EXECUTABLE) {
      const cliPath = join(acpDir, "claude-cli.js");
      if (existsSync(cliPath)) {
        process.env.CLAUDE_CODE_EXECUTABLE = cliPath;
      }
    }
  }
  try {
    const module = await import(pathToFileURL(serverPath).href);
    claxedoServerHandle = module.startServer(claxedoPort, opencodeUrl, opencodePassword);
    const claxedoUrl = `http://127.0.0.1:${claxedoPort}`;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const res = await fetch(`${claxedoUrl}/api/claxedo/health`, { signal: AbortSignal.timeout(1e3) });
        if (res.ok) {
          logger.log("claxedo-server healthy", { url: claxedoUrl });
          return { url: claxedoUrl };
        }
      } catch {
      }
    }
    logger.warn("claxedo-server health check timed out, falling back to opencode");
    return { url: opencodeUrl };
  } catch (err) {
    logger.error("claxedo-server failed to start", { error: String(err) });
    return { url: opencodeUrl };
  }
}
async function setupServerConnection() {
  if (!app.isPackaged) {
    const candidates = [process.env.CLAXEDO_SERVER_URL, "http://127.0.0.1:3001"].filter(Boolean);
    const results = await Promise.all(candidates.map(async (url) => ({ url, ok: await checkHealth(url) })));
    const hit = results.find((r) => r.ok);
    if (hit) {
      logger.log("dev: using claxedo-server", { url: hit.url });
      local = null;
      serverReady.resolve({ url: hit.url, password: null });
      return { variant: "existing", url: hit.url };
    }
    logger.log("dev: claxedo-server not found, falling back to sidecar");
  }
  const customUrl = await getSavedServerUrl();
  if (customUrl && await checkHealthOrAskRetry(customUrl)) {
    local = null;
    serverReady.resolve({ url: customUrl, password: null });
    return { variant: "existing", url: customUrl };
  }
  const port = await getSidecarPort();
  const hostname = "127.0.0.1";
  const localUrl = `http://${hostname}:${port}`;
  if (await checkHealth(localUrl)) {
    local = null;
    serverReady.resolve({ url: localUrl, password: null });
    return { variant: "existing", url: localUrl };
  }
  const password = randomUUID();
  const { child, health, events } = spawnLocalServer(hostname, port, password);
  sidecar = child;
  local = { url: localUrl, password };
  return {
    variant: "cli",
    url: localUrl,
    password,
    health,
    events
  };
}
async function initialize() {
  const needsMigration = !sqliteFileExists();
  const sqliteDone = needsMigration ? defer() : void 0;
  const loadingTask = (async () => {
    logger.log("setting up server connection");
    const serverConnection = await setupServerConnection();
    logger.log("server connection ready", {
      variant: serverConnection.variant,
      url: serverConnection.url
    });
    if (serverConnection.variant === "cli") {
      const { events, health } = serverConnection;
      events.on("sqlite", (progress) => {
        setInitStep({ phase: "sqlite_waiting" });
        if (loadingWindow2) sendSqliteMigrationProgress(loadingWindow2, progress);
        if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress);
        if (progress.type === "Done") sqliteDone?.resolve();
      });
      logger.log("server connection started");
      const healthDone = health.wait.then(
        async () => {
          sqliteDone?.resolve();
          const { url: claxedoUrl } = await startClaxedoServer(serverConnection.url, serverConnection.password);
          serverReady.resolve({
            url: claxedoUrl,
            password: serverConnection.password
          });
        },
        (err) => {
          sqliteDone?.reject(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      );
      if (needsMigration) await sqliteDone?.promise;
      await healthDone;
    } else {
      logger.log("server connection started");
      serverReady.resolve({ url: serverConnection.url, password: null });
    }
    logger.log("loading task finished");
  })();
  const globals = {
    updaterEnabled: UPDATER_ENABLED,
    wsl: getWslConfig().enabled,
    deepLinks: pendingDeepLinks
  };
  const loadingWindow2 = await (async () => {
    if (needsMigration) {
      const loadingWindow3 = createLoadingWindow(globals);
      await delay(1e3);
      return loadingWindow3;
    } else {
      logger.log("showing main window without loading window");
      mainWindow = createMainWindow(globals);
      wireFullscreenEvents(mainWindow);
      wireMenu();
    }
  })();
  await loadingTask;
  setInitStep({ phase: "done" });
  if (loadingWindow2) {
    await loadingComplete.promise;
  }
  if (!mainWindow) {
    mainWindow = createMainWindow(globals);
    wireFullscreenEvents(mainWindow);
    wireMenu();
  }
  loadingWindow2?.close();
}
function wireMenu() {
  if (!mainWindow) return;
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    installCli: () => {
      void installCli();
    },
    checkForUpdates: () => {
      void checkForUpdates();
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      app.relaunch();
      app.quit();
    }
  });
}
registerIpcHandlers({
  killSidecar: () => killSidecar(),
  installCli: async () => installCli(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep);
    const listener = (step) => sendStep(step);
    initEmitter.on("step", listener);
    try {
      logger.log("awaiting server ready");
      const res = await serverReady.promise;
      logger.log("server ready", { url: res.url });
      return res;
    } finally {
      initEmitter.off("step", listener);
    }
  },
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => void 0,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path2, mode) => wslPath(path2, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  browser: browserRegistry
});
if (browserTabSetup) {
  logger.log("browser-tab feature enabled", { partition: browserTabSetup.partition });
}
function killSidecar() {
  if (!sidecar) return;
  sidecar.kill();
  sidecar = null;
  local = null;
}
async function shutdown() {
  await disposeSidecar();
  killSidecar();
  if (claxedoServerHandle) {
    claxedoServerHandle.close();
    claxedoServerHandle = null;
  }
  if (browserBridgePromise) {
    try {
      const bridge = await browserBridgePromise;
      await bridge.close();
    } catch (err) {
      logger.warn("failed to close browser bridge on shutdown", { error: err });
    }
  }
}
async function disposeSidecar() {
  if (!sidecar || !local) return;
  const headers = new Headers();
  const auth = Buffer.from(`opencode:${local.password}`).toString("base64");
  headers.set("authorization", `Basic ${auth}`);
  try {
    await fetch(new URL("/global/dispose", local.url), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(1500)
    });
  } catch (err) {
    logger.warn("failed to dispose sidecar before quit", { error: err });
  }
}
function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"];
  const upsert = (key) => {
    const items = (process.env[key] ?? "").split(",").map((value) => value.trim()).filter((value) => Boolean(value));
    for (const host of loopback) {
      if (items.some((value) => value.toLowerCase() === host)) continue;
      items.push(host);
    }
    process.env[key] = items.join(",");
  };
  upsert("NO_PROXY");
  upsert("no_proxy");
}
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer$1();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("Failed to get port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return await new Promise((resolve, reject) => {
    const server = createServer$1();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("Failed to get port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return existsSync(join(base, "opencode", "opencode.db"));
}
async function checkUpdate() {
  return { updateAvailable: false };
}
async function installUpdate() {
  return;
}
async function checkForUpdates(alertOnFail) {
  return;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function defer() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
