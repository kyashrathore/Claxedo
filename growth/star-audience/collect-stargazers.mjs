#!/usr/bin/env node
// Collect + dedup + rank stargazers of target AI-dev repos into an audience CSV.
//
// WHAT THIS DOES (and deliberately does NOT do):
//   - Pulls the PUBLIC stargazer usernames of each target repo via the GitHub API.
//   - Dedups across repos and scores each person by weighted repo overlap.
//   - Outputs usernames + public profile URLs for use as an audience (ads, enrichment, research).
//   - It does NOT scrape emails. Harvesting emails from GitHub to send bulk mail violates
//     GitHub's Acceptable Use Policy. Get verified business emails from a compliant B2B
//     enrichment provider keyed on the identity fields, not from here.
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx node collect-stargazers.mjs [--repos repos.json] [--out audience.csv] [--max-pages 400]
//
// Notes:
//   - Needs a token (even a no-scope classic PAT) for the 5,000 req/hr limit; unauth = 60/hr.
//   - GitHub caps stargazer pagination at 400 pages (~40,000 users) per repo. For repos
//     bigger than that you get the FIRST ~40k stargazers only. The script logs when it hits the cap.

import { readFileSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const REPOS_FILE = args.repos ?? new URL("./repos.json", import.meta.url).pathname;
const OUT_FILE = args.out ?? "audience.csv";
const MAX_PAGES = Number(args["max-pages"] ?? 400); // GitHub hard cap
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error("ERROR: set GITHUB_TOKEN (a classic PAT, no scopes needed) to avoid 60 req/hr limit.");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(REPOS_FILE, "utf8"));
const weights = cfg.weights ?? {};
const repoToWeight = new Map();
for (const [tier, repos] of Object.entries(cfg.tiers)) {
  for (const r of repos) repoToWeight.set(r, weights[tier] ?? 1);
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "claxedo-star-audience",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghGet(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: H });
    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0") * 1000;
      const waitMs = Math.max(reset - Date.now(), 1000) + 1000;
      console.warn(`  rate-limited, sleeping ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${url}: ${await res.text()}`);
    // Proactively pace when the budget gets low.
    if (remaining < 50) await sleep(1500);
    return res.json();
  }
  throw new Error(`giving up after retries: ${url}`);
}

// login -> { repos: Set<string>, score: number }
const people = new Map();

for (const [repo, weight] of repoToWeight) {
  console.log(`\n== ${repo} (weight ${weight}) ==`);
  let page = 1;
  let count = 0;
  for (; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${repo}/stargazers?per_page=100&page=${page}`;
    let batch;
    try {
      batch = await ghGet(url);
    } catch (e) {
      console.warn(`  skipping ${repo} @ page ${page}: ${e.message}`);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const u of batch) {
      const login = u.login;
      if (!login) continue;
      let p = people.get(login);
      if (!p) { p = { repos: new Set(), score: 0 }; people.set(login, p); }
      if (!p.repos.has(repo)) { p.repos.add(repo); p.score += weight; }
    }
    count += batch.length;
    if (page % 20 === 0) console.log(`  ...${count} stargazers, ${people.size} unique so far`);
  }
  if (page > MAX_PAGES) console.warn(`  NOTE: hit ${MAX_PAGES}-page cap on ${repo} — only first ~${MAX_PAGES * 100} stargazers captured.`);
  console.log(`  done: ${count} stargazers scanned`);
}

// Rank: weighted score desc, then breadth (number of repos) desc.
const rows = [...people.entries()]
  .map(([login, p]) => ({
    login,
    score: p.score,
    repo_count: p.repos.size,
    repos: [...p.repos].join("|"),
    profile: `https://github.com/${login}`,
  }))
  .sort((a, b) => b.score - a.score || b.repo_count - a.repo_count);

const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const header = "login,score,repo_count,repos,profile\n";
const body = rows.map((r) => [r.login, r.score, r.repo_count, r.repos, r.profile].map(esc).join(",")).join("\n");
writeFileSync(OUT_FILE, header + body + "\n");

const hot = rows.filter((r) => r.repo_count >= 3).length;
console.log(`\nWrote ${rows.length} unique people -> ${OUT_FILE}`);
console.log(`Hot leads (starred 3+ target repos): ${hot}`);
console.log("Next: hand off to a compliant B2B email-enrichment provider. Do NOT scrape emails from GitHub.");
