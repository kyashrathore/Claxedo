#!/usr/bin/env node
// Fill in PUBLIC PROFILE emails for an audience.csv produced by collect-stargazers.mjs.
//
// This uses the ONE clean, consented source: GET /users/{login} returns `email` only when
// the user deliberately set a public profile email. It does NOT scrape commit metadata.
// Expect a low fill rate (~2-10%) — that's the tradeoff for every hit being a real,
// intentionally-published address.
//
// Reminder: a public email is not consent to be cold-mailed in bulk. Using these for
// outreach still lives under GitHub's AUP + CAN-SPAM/GDPR. This tool just resolves what
// people chose to publish; the compliance burden is on how you send.
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx node enrich-public-emails.mjs [--in audience.csv] [--out audience-emails.csv] [--limit N]
//
//   --limit N  only enrich the top N rows (audience.csv is score-sorted, so this is
//              "the N hottest leads"). Great for measuring hit rate on a sample first.

import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const IN = args.in ?? "audience.csv";
const OUT = args.out ?? "audience-emails.csv";
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("ERROR: set GITHUB_TOKEN (classic PAT, no scopes needed) for 5,000 req/hr.");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "claxedo-star-audience",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// minimal CSV parse (our own well-formed output; handles quoted fields)
function parseCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

async function ghGet(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: H });
    if (res.status === 404) return null;
    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
      const waitMs = Math.max(reset - Date.now(), 1000) + 1000;
      console.warn(`  rate-limited, sleeping ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${url}`);
    if (remaining < 50) await sleep(1200);
    return res.json();
  }
  throw new Error(`giving up: ${url}`);
}

const rows = parseCsv(readFileSync(IN, "utf8"));
const targets = rows.slice(0, LIMIT);
console.log(`Enriching ${targets.length} of ${rows.length} rows via /users/{login}...`);

let hits = 0, done = 0;
for (const row of targets) {
  const u = await ghGet(`https://api.github.com/users/${row.login}`);
  row.email = u?.email ?? "";
  row.name = u?.name ?? "";
  row.company = u?.company ?? "";
  row.blog = u?.blog ?? "";
  row.twitter = u?.twitter_username ?? "";
  if (row.email) hits++;
  if (++done % 100 === 0) console.log(`  ${done}/${targets.length}  emails: ${hits} (${((hits / done) * 100).toFixed(1)}%)`);
}
// rows beyond LIMIT keep original columns with blanks for the new ones
for (const row of rows.slice(LIMIT)) {
  row.email ??= ""; row.name ??= ""; row.company ??= ""; row.blog ??= ""; row.twitter ??= "";
}

const cols = ["login", "score", "repo_count", "email", "name", "company", "blog", "twitter", "repos", "profile"];
const esc = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
writeFileSync(OUT, csv);

console.log(`\nWrote ${rows.length} rows -> ${OUT}`);
console.log(`Public profile emails found: ${hits}/${done} (${done ? ((hits / done) * 100).toFixed(1) : 0}% fill rate)`);
console.log("These are profile-published emails only. Verify + comply before sending.");
