import type { APIRoute } from "astro"
import { pricingMarkdown, markdownResponse } from "../content/markdown"

export const GET: APIRoute = () => markdownResponse(pricingMarkdown)
