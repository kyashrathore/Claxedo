import { Hono } from "hono";
import { getDashboardHtml } from "../ui/dashboard.html";

export function dashboardRouter() {
  const router = new Hono();

  router.get("/", (c) => c.html(getDashboardHtml()));

  return router;
}
