#!/usr/bin/env bun
// Minimap scroll-to verification: opens the heaviest session, clicks ticks
// across the message-nav rail, and reports per-click whether the transcript
// actually moved, where the target row landed relative to the viewport, and
// whether it stayed put (no bounce-back).
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { materializeClaxedoCorpus, readCanonicalCorpusDigest } from "../src/agent-corpus-materializer";
import { launchPackagedClaxedo } from "../src/agent-claxedo-launcher";
import { measureSessionActivation } from "../src/agent-browser-observer";

const corpusPath = process.argv[2] ?? "/tmp/corpus-realistic-long.json";
const appPath =
  process.argv[3] ??
  "/Users/yashvardhansingh/test/opencode/.worktrees/perf-beat-t3/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app";

const digest = await readCanonicalCorpusDigest(corpusPath);
const scratch = await mkdtemp(path.join("/tmp", "claxedo-nav-probe-"));
try {
  const prepared = await materializeClaxedoCorpus({
    corpusPath,
    corpusDigestSha256: digest,
    dataDirectory: path.join(scratch, "data"),
    workspaceDirectory: path.join(scratch, "workspaces"),
    profiles: ["workspace-core-v1"],
  });
  const targets = prepared.readinessTargets;
  const launch = await launchPackagedClaxedo({
    executable: path.join(appPath, "Contents/MacOS/Claxedo Dev"),
    isolatedProfilePath: path.join(scratch, "profile"),
    dataDirectory: path.join(scratch, "data"),
    readinessTargets: targets,
  });
  try {
    const heavy = targets[targets.length - 1]!;
    // Multiple kept-mounted session screens share the DOM; every query must be
    // scoped to the ACTIVE surface's root or it silently hits a sibling.
    const opened = await measureSessionActivation(launch.page, heavy);
    console.log("open heaviest:", opened.state === "exact" ? `${opened.durationMs.toFixed(0)}ms` : opened.reason);

    const rail = await launch.page.evaluate((id) => {
      const roots = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
        ),
      ];
      const root =
        roots.find((candidate) => candidate.closest("[data-workbench-content]")?.getAttribute("aria-hidden") !== "true") ??
        roots[0];
      const nav = root?.querySelector<HTMLElement>('[data-component="message-nav"]');
      return {
        present: !!nav,
        size: nav?.getAttribute("data-size") ?? null,
        height: Math.round(nav?.getBoundingClientRect().height ?? 0),
        ticks: [...(nav?.querySelectorAll('[data-slot="message-nav-tick-button"]') ?? [])]
          .map((el) => (el as HTMLElement).dataset.messageId)
          .filter((value): value is string => !!value),
      };
    }, heavy.sessionId);
    console.log(`rail: ${rail.present ? "present" : "MISSING"} size=${rail.size} ticks=${rail.ticks.length} height=${rail.height}px`);
    if (!rail.present || rail.ticks.length === 0) throw new Error("minimap not rendered");

    // Paged minimap: >30 turns render top/bottom EDGE MOVERS (··· rows) that
    // slide the 30-turn window. Auto-follow opens on the last page; walk the
    // prev mover back to the FIRST page so the jump loop covers the oldest
    // half — the previously-impossible region.
    const readRailPage = () =>
      launch.page.evaluate((id) => {
        const roots = [
          ...document.querySelectorAll<HTMLElement>(
            `[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`,
          ),
        ];
        const root =
          roots.find((candidate) => candidate.closest("[data-workbench-content]")?.getAttribute("aria-hidden") !== "true") ??
          roots[0];
        const nav = root?.querySelector<HTMLElement>('[data-component="message-nav"]');
        return {
          height: Math.round(nav?.getBoundingClientRect().height ?? 0),
          firstTick: nav?.querySelector<HTMLElement>("[data-slot='message-nav-tick-button']")?.dataset.messageId ?? "",
          hasPrev: !!nav?.querySelector("[data-slot='message-nav-page-prev']:not([disabled])"),
          hasNext: !!nav?.querySelector("[data-slot='message-nav-page-next']:not([disabled])"),
        };
      }, heavy.sessionId);
    let page = await readRailPage();
    console.log(`rail: height=${page.height}px firstTick=…${page.firstTick.slice(-6)} prev=${page.hasPrev} next=${page.hasNext}`);
    if (!page.height) throw new Error("minimap not rendered");
    if (!page.hasPrev) throw new Error("expected a prev mover on the auto-followed last page");
    let walks = 0;
    while (page.hasPrev && walks < 80) {
      await launch.page.evaluate((id) => {
        const roots = [
          ...document.querySelectorAll<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`),
        ];
        const root =
          roots.find((candidate) => candidate.closest("[data-workbench-content]")?.getAttribute("aria-hidden") !== "true") ??
          roots[0];
        (root?.querySelector<HTMLElement>("[data-slot='message-nav-page-prev']") as HTMLElement | null)?.click();
      }, heavy.sessionId);
      await Bun.sleep(120);
      page = await readRailPage();
      walks += 1;
    }
    rail.ticks = await launch.page.evaluate((id) => {
      const roots = [
        ...document.querySelectorAll<HTMLElement>(`[data-testid="session-page-root"][data-session-id="${CSS.escape(id)}"]`),
      ];
      const root =
        roots.find((candidate) => candidate.closest("[data-workbench-content]")?.getAttribute("aria-hidden") !== "true") ??
        roots[0];
      return [...(root?.querySelectorAll('[data-slot="message-nav-tick-button"]') ?? [])]
        .map((el) => (el as HTMLElement).dataset.messageId)
        .filter((value): value is string => !!value);
    }, heavy.sessionId);
    console.log(`walked ${walks} pages back → firstTick=…${page.firstTick.slice(-6)} ticks=${rail.ticks.length} prev=${page.hasPrev} next=${page.hasNext}`);
    if (page.hasPrev) throw new Error("prev walk did not reach the first page");

    const positions = [1, 0.2, 0.45, 0.7, 0.9, 0]
      .map((fraction) => Math.round(fraction * (rail.ticks.length - 1)))
      .toReversed();
    await launch.page.evaluate(() => {
      const host = window as unknown as { __tickClicks: Array<{ id: string; prevented: boolean }> };
      host.__tickClicks = [];
      document.addEventListener(
        "click",
        (event) => {
          const target = event.target as HTMLElement | null;
          const button = target?.closest<HTMLElement>('[data-slot="message-nav-tick-button"]');
          if (!button) return;
          (host.__tickClicks ??= []).push({ id: button.dataset.messageId ?? "", prevented: event.defaultPrevented });
        },
        true,
      );
    });
    for (const index of positions) {
      const messageId = rail.ticks[index]!;
      const scoped = `[data-testid="session-page-root"][data-session-id="${cssEscape(heavy.sessionId)}"]`;
      const before = await launch.page.evaluate(
        ({ scope }) => {
          const viewport = document.querySelector<HTMLElement>(`${scope} .scroll-view__viewport`);
          const root = document.querySelector<HTMLElement>(scope);
          return { scrollTop: viewport?.scrollTop ?? -1, turns: Number(root?.dataset.sessionVisibleUserCount ?? -1) };
        },
        { scope: scoped },
      );
      // Jump via deep-link hash: same reveal+seek machinery the minimap click
      // funnels into, without sub-pixel hit-target flakiness at 1600 ticks.
      await launch.page.evaluate(
        ({ id, scope }) => {
          const root = document.querySelector(scope)
          const button = root?.querySelector<HTMLElement>(
            `[data-slot="message-nav-tick-button"][data-message-id="${CSS.escape(id)}"]`,
          )
          if (button) button.click()
          else location.hash = `#message-${id}`
        },
        { id: messageId, scope: scoped },
      );
      const startedAt = Date.now();
      const sample = () =>
        launch.page.evaluate(({ id, scope }) => {
          const viewport = document.querySelector<HTMLElement>(`${scope} .scroll-view__viewport`);
          const anchor = document.getElementById(`message-${CSS.escape(id)}`);
          const view = viewport?.getBoundingClientRect();
          const rect = anchor?.getBoundingClientRect();
          const root = document.querySelector<HTMLElement>(scope);
          return {
            scrollTop: viewport?.scrollTop ?? -1,
            anchorTopInView: rect && view ? Math.round(rect.top - view.top) : null,
            anchorVisible: !!(rect && view && rect.bottom > view.top && rect.top < view.bottom),
            hash: location.hash,
            loadedTurns: Number(root?.dataset.sessionVisibleUserCount ?? -1),
          };
        }, { id: messageId, scope: scoped });
      // Poll until the target row lands AND holds for two consecutive samples —
      // far jumps page through history and can legitimately take a while.
      let landed = false;
      let landMs = -1;
      let previous: Awaited<ReturnType<typeof sample>> | undefined;
      while (Date.now() - startedAt < 60_000) {
        await Bun.sleep(200);
        const current = await sample();
        if (
          current.anchorVisible &&
          previous?.anchorVisible &&
          Math.abs(current.scrollTop - (previous.scrollTop ?? 0)) <= 2
        ) {
          landed = true;
          landMs = Date.now() - startedAt;
          break;
        }
        previous = current;
      }
      const after1 = landed ? previous! : await sample();
      const after2 = await sample();
      const moved = after1.scrollTop - before.scrollTop;
      const bounced = Math.abs(after2.scrollTop - after1.scrollTop) > 2;
      const verdict =
        !after1.anchorVisible || after1.anchorTopInView === null
          ? "MISS"
          : bounced
            ? "BOUNCED-BACK"
            : "OK";
      console.log(
        `tick ${String(index).padStart(4)}  land=${landed ? `${landMs}ms` : "TIMEOUT"}  Δscroll ${String(Math.round(moved)).padStart(7)}  anchor@${String(after1.anchorTopInView ?? "—").padStart(6)}px  turns ${before.turns}→${after1.loadedTurns}  ${verdict}`,
      );
    }
  } finally {
    await launch.shutdown();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function cssEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
