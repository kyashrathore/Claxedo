#!/usr/bin/env bun
import solidPlugin from "./node_modules/@opentui/solid/scripts/solid-plugin"

const result = await Bun.build({
  conditions: ["browser"],
  plugins: [solidPlugin],
  sourcemap: "none",
  target: "bun",
  entrypoints: ["./serve-web-entry.ts"],
  outdir: "./dist-web",
  define: {
    OPENCODE_VERSION: "'0.0.1-claxedo-web'",
    OPENCODE_MIGRATIONS: "[]",
    OTUI_TREE_SITTER_WORKER_PATH: "''",
    OPENCODE_WORKER_PATH: "''",
    OPENCODE_CHANNEL: "'dev'",
    OPENCODE_LIBC: "''",
  },
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Wrap entire bundle in async IIFE (AlmostNode runs as CJS, no top-level await)
// and prepend Bun shim before bundle (bundler hoists `import "bun"` above our code)
const bunShim = `
// --- Bun shim for AlmostNode browser runtime ---
;(function() {
  var fs = require("fs");
  var pathMod = require("path");
  var urlMod = require("url");
  function noop() {}
  function shell() {
    var p = Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    p.text = function() { return Promise.resolve(""); };
    p.quiet = function() { return shell(); };
    p.nothrow = function() { return shell(); };
    p.cwd = function() { return shell(); };
    p.env = function() { return shell(); };
    return p;
  }
  shell.cwd = function() { return shell; };
  var Bun = {
    env: typeof process !== "undefined" ? process.env : {},
    serve: function(opts) {
      var http = require("http");
      var server = http.createServer(function(req, res) {
        var host = req.headers.host || (opts.hostname || "localhost") + ":" + opts.port;
        var fullUrl = "http://" + host + req.url;
        var chunks = [];
        req.on("data", function(c) { chunks.push(c); });
        req.on("end", function() {
          var body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
          var headers = new Headers();
          Object.keys(req.headers).forEach(function(k) {
            if (req.headers[k]) headers.set(k, Array.isArray(req.headers[k]) ? req.headers[k].join(", ") : req.headers[k]);
          });
          var request = new Request(fullUrl, {
            method: req.method,
            headers: headers,
            body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
          });
          opts.fetch(request).then(function(response) {
            var rh = {};
            response.headers.forEach(function(v, k) { rh[k] = v; });
            res.writeHead(response.status, rh);
            if (response.body && typeof response.body.getReader === "function") {
              var reader = response.body.getReader();
              (function pump() {
                reader.read().then(function(r) {
                  if (r.done) { res.end(); return; }
                  res.write(r.value);
                  pump();
                }).catch(function() { res.end(); });
              })();
            } else {
              response.text().then(function(t) { res.end(t); });
            }
          }).catch(function(err) {
            res.writeHead(500, {"Content-Type": "text/plain"});
            res.end("Error: " + (err && err.message || err));
          });
        });
      });
      server.listen(opts.port, opts.hostname || "0.0.0.0");
      var serverUrl = new URL("http://" + (opts.hostname || "localhost") + ":" + opts.port);
      return {
        url: serverUrl,
        hostname: opts.hostname || "localhost",
        port: opts.port,
        stop: function() { return new Promise(function(r) { server.close(r); }); }
      };
    },
    file: function(p) {
      return {
        text: function() { try { return Promise.resolve(fs.readFileSync(p, "utf8")); } catch(e) { return Promise.resolve(""); } },
        exists: function() { return Promise.resolve(fs.existsSync(p)); },
        json: function() { try { return Promise.resolve(JSON.parse(fs.readFileSync(p, "utf8"))); } catch(e) { return Promise.resolve(null); } },
        write: function(d) { return Bun.write(p, d); },
        arrayBuffer: function() { try { var b = fs.readFileSync(p); return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch(e) { return Promise.resolve(new ArrayBuffer(0)); } },
      };
    },
    write: function(dest, data) {
      var dir = pathMod.dirname(dest);
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
      fs.writeFileSync(dest, typeof data === "string" ? data : Buffer.from(data));
      return Promise.resolve(data.length || 0);
    },
    resolve: function() { return Promise.resolve(""); },
    sleep: function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); },
    spawn: function() {
      return { exitCode: Promise.resolve(1), stdout: { text: function() { return Promise.resolve(""); } }, stderr: { text: function() { return Promise.resolve(""); } }, kill: noop };
    },
    stdin: { text: function() { return Promise.resolve(""); } },
    semver: { satisfies: function() { return true; }, order: function() { return 0; } },
    $: shell,
    pathToFileURL: urlMod.pathToFileURL || function(p) { return new URL("file://" + p); },
    fileURLToPath: urlMod.fileURLToPath || function(u) { return u.replace("file://", ""); },
  };
  globalThis.Bun = Bun;
})();
// --- End Bun shim ---
`

const bundlePath = "./dist-web/serve-web-entry.js"
let bundle = await Bun.file(bundlePath).text()

// Remove the leading "// @bun" comment
bundle = bundle.replace(/^\/\/ @bun\n/, "")

// Convert ESM import statements to CJS require() calls
// Handle: import X, { a, b } from "mod"  (default + named)
bundle = bundle.replace(/^import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+"([^"]+)";?$/gm, (_, def, names, mod) => {
  const tmpVar = "__mod_" + mod.replace(/[^a-zA-Z0-9]/g, "_") + "_" + def
  const bindings = names.split(",").map((n: string) => n.trim())
  const destructure = bindings.map((b: string) => {
    const parts = b.split(/\s+as\s+/)
    return parts.length > 1 ? `${parts[1].trim()} = ${tmpVar}["${parts[0].trim()}"]` : `${b} = ${tmpVar}["${b}"]`
  }).join(", ")
  return `var ${tmpVar} = require("${mod}"); var ${def} = ${tmpVar}.default || ${tmpVar}; var ${destructure};`
})
// Handle: import X from "mod"
bundle = bundle.replace(/^import\s+(\w+)\s+from\s+"([^"]+)";?$/gm, 'var $1 = require("$2");')
// Handle: import { a, b } from "mod"
bundle = bundle.replace(/^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";?$/gm, (_, names, mod) => {
  const bindings = names.split(",").map((n: string) => n.trim())
  const tmpVar = "__mod_" + mod.replace(/[^a-zA-Z0-9]/g, "_")
  const destructure = bindings.map((b: string) => {
    const parts = b.split(/\s+as\s+/)
    return parts.length > 1 ? `${parts[1].trim()} = ${tmpVar}["${parts[0].trim()}"]` : `${b} = ${tmpVar}["${b}"]`
  }).join(", ")
  return `var ${tmpVar} = require("${mod}"); var ${destructure};`
})
// Handle: import * as X from "mod"
bundle = bundle.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+"([^"]+)";?$/gm, 'var $1 = require("$2");')

// Replace bun: prefixed modules with plain names for AlmostNode compatibility
bundle = bundle.replace(/require\("bun:(\w+)"\)/g, 'require("bun_$1")')

// Replace import.meta.require with require (AlmostNode doesn't have import.meta.require)
bundle = bundle.replace(/import\.meta\.require/g, 'require')

// Ensure Buffer is globally available
bundle = 'if(typeof Buffer==="undefined"){var Buffer=require("buffer").Buffer;}\n' + bundle

// Polyfill AsyncLocalStorage inline (AlmostNode stubs async_hooks as no-op)
const alsInline = `(function(){function ALS(){this._store=undefined;}ALS.prototype.run=function(store,fn){var prev=this._store;this._store=store;try{var r=fn();if(r&&typeof r.then==="function"){return r;}return r;}catch(e){this._store=prev;throw e;}};ALS.prototype.getStore=function(){return this._store;};ALS.prototype.enterWith=function(s){this._store=s;};ALS.prototype.disable=function(){this._store=undefined;};ALS.prototype.exit=function(fn){var p=this._store;this._store=undefined;try{return fn();}finally{this._store=p;}};function AR(){}AR.prototype.runInAsyncScope=function(fn,t){return fn.call(t);};AR.prototype.bind=function(fn){return fn;};return{AsyncLocalStorage:ALS,AsyncResource:AR};})()`
// Order matters: replace __require first (longer match), then require
bundle = bundle.replace(/__require\("async_hooks"\)/g, alsInline)
bundle = bundle.replace(/([^_])require\("async_hooks"\)/g, `$1${alsInline}`)
bundle = bundle.replace(/import\("async_hooks"\)/g, `Promise.resolve(${alsInline})`)

// Wrap in async IIFE for top-level await support
await Bun.write(bundlePath, bunShim + "\n;(async function() {\n" + bundle + "\n})();\n")

const final = await Bun.file(bundlePath).text()
console.log(`Build succeeded: ${(final.length / 1024 / 1024).toFixed(1)}MB`)
