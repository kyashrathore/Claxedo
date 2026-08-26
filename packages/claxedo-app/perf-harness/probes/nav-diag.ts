#!/usr/bin/env bun
// Live minimap layout diagnostics: connect to the running show-app instance
// (DevTools port from its profile dir) and dump computed geometry for the
// active surface's nav wrapper, list, and first few rows.
import path from "node:path";
import { connectCdpPage } from "../src/agent-cdp-page";

const portFile = "58588";
const port = Number((await Bun.file(portFile).text()).split("\n")[0]);
console.log("cdp port", port);
const page = await connectCdpPage({
  port,
  process: { exited: null } as unknown as Bun.Subprocess,
  timeoutMs: 10_000,
});
const info = await page.evaluate(() => {
  const roots = [...document.querySelectorAll<HTMLElement>('[data-testid="session-page-root"]')];
  const active =
    roots.find((candidate) => candidate.closest("[data-workbench-content]")?.getAttribute("aria-hidden") !== "true") ??
    roots[roots.length - 1]!;
  const sessionId = active.dataset.sessionId;
  const wrapper = active.querySelector<HTMLElement>("[data-component='message-nav-hovercard']");
  const nav = active.querySelector<HTMLElement>("[data-component='message-nav']");
  const wrapperStyle = wrapper ? getComputedStyle(wrapper) : undefined;
  const navStyle = nav ? getComputedStyle(nav) : undefined;
  const rows = nav ? [...nav.querySelectorAll(":scope > li")] : [];
  return {
    surfaces: roots.length,
    sessionId,
    wrapper: {
      display: wrapperStyle?.display,
      height: Math.round(wrapper?.getBoundingClientRect().height ?? -1),
      cls: wrapper?.className.slice(0, 140),
    },
    nav: {
      display: navStyle?.display,
      flexDirection: navStyle?.flexDirection,
      justifyContent: navStyle?.justifyContent,
      height: Math.round(nav?.getBoundingClientRect().height ?? -1),
      children: nav?.children.length ?? -1,
      firstRows: rows.slice(0, 4).map((row) => ({
        slot: row.firstElementChild?.dataset.slot ?? row.tagName.toLowerCase(),
        h: Math.round(row.getBoundingClientRect().height * 10) / 10,
        disabled: (row.firstElementChild as HTMLButtonElement | null)?.disabled,
      })),
    },
  };
});
console.log(JSON.stringify(info, null, 1));
process.exit(0);
