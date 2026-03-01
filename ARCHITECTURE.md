<!-- claxedo: page_id=page_1772218886407_autta57 updated_at=2026-02-27T19:04:03.391Z doc_hash=f7adac9d6ab5a93c05a35f27c163dc61f8b808e535b43488ce776198e103ed01 derived_markdown=1 -->

# REPO_CONTEXT

Last updated: 2025-12-15

Recent change

- 2025-12-15: Chat-assist debugging: added correlated client/server logs (via `x-formlink-trace-id`) and fixed AI chat “repeat question” loop by ensuring tool outputs update `responses` (applied on `output-available`) and by sending a stable `submissionId` with chat requests.

- Runtime/chat scaffold: Added `useChatStartCard` and `useQuestionPlaceholder` hooks to `@formlink/runtime/ui/react` for start-card control and consistent placeholders. See `docs/ai-chat-scaffold-primitives.md`.

  -- 2025-11-06: Renamed `UniversalClassic` → `ClassicTemplate` and added `ChatTemplate` under `@formlink/runtime/ui/react`. Updated stories to use `ClassicTemplate`; added `apps/ui-docs/stories/ChatTemplateRealBackend.stories_v1.tsx` demonstrating controller wiring with `useChat`. For back-compat, a temporary alias `export { ClassicTemplate as UniversalClassic }` remains; remove in next minor.

- 2025-10-23: Codegen deployments will use `wrangler pages deploy` from inside the Vercel sandbox (with Cloudflare tokens) instead of hitting the Pages Direct Upload REST API. The API path is still viable later, but CLI keeps us unblocked now; revisit once we have a stable archive streaming helper.

- Runtime docs: Added consolidated plan at `docs/runtime/RUNTIME_CONSOLIDATED_v1.md` organizing packages, decisions to gavel, Deploy-on-Formlink flow, headless chat testmode, and the Devtools plan. This doc links to existing detailed specs and examples and defines MVP acceptance.

- Runtime/schema: Re‑attached `@formlink/runtime` to the canonical `@formlink/schema` types to prevent drift. `packages/runtime/src/types.ts` now re‑exports `Form`/`Question`/`AddressData` from `@formlink/schema`, and core modules import types from the schema package. Address schema validation also uses `AddressSchema` from `@formlink/schema`.

- Runtime packaging: `@formlink/runtime` now ships the full `src/` tree in npm with a `source` conditional export, and Storybook aliases resolve to those `.ts/.tsx` files so “Open in editor” no longer jumps to `dist/*.d.ts`.

- Runtime packaging: Externalized `@formlink/ui` (and `use-sync-external-store`, `@radix-ui/react-use-is-hydrated`) from the `@formlink/runtime` bundle to avoid CJS shims being inlined into ESM output. This removes the browser error `Dynamic require of "react" is not supported` and SSR `document is not defined` originating from transitively bundled UI/d3 code.

- New: `@formlink/runtime` no longer declares `@formlink/ui` as a peer dependency. Host apps provide AI UI via `AiElementsProvider` (mapping components typically from `@formlink/ui/ai-elements`) and shadcn primitives via `ShadCnProvider`. Shipped in `@formlink/runtime >= 0.1.0-alpha.8`.

- Runtime UI: Introduced `AiElementsProvider` to map ai-elements (Conversation, PromptInput\*, Response) from the host app (typically `@formlink/ui/ai-elements`). `ChatTemplate` and `ChatMessageAssistant` now consume ai-elements via this provider instead of importing `@formlink/ui` directly. In dev, missing mappings throw with a clear message. Available starting in `0.1.0-alpha.8`.

- Runtime: Rewrote `packages/runtime/src/ui/react/InlineSignature.tsx` to use `react-signature-canvas` (matches our UI package) instead of custom `<canvas>` (and dropped prior `@uiw/react-signature` change). Preserves API (`value?: string|null`, `onChange(dataUrl)`, `onSubmit?`, `width`, `height`). Behavior: loads existing `value` into the canvas via `fromDataURL`, new strokes append, and `toDataURL('image/png')` emits the full image; `Clear` resets and emits `null`. Added deps: `react-signature-canvas` and `@types/react-signature-canvas` to `@formlink/runtime`.

- Runtime: Tweaked signature stroke thickness to be slightly lighter: `minWidth` 1 → 0.75 and `maxWidth` 3 → 2.0 in `InlineSignature`. No API change.

- Cleanup: Removed unused hooks in UI package. Deleted `packages/ui/src/hooks/primitives/*` and `packages/ui/src/form/primitives/hooks/*`; dropped their re-exports from `packages/ui/src/index.ts` and `packages/ui/src/form/primitives/index.ts`.

- Cleanup: Removed unused hooks under `packages/ui/src/hooks/form/*` and removed their public re-exports from `packages/ui/src/index.ts`.

- Cleanup: Removed now-empty directories `packages/ui/src/hooks/form` and `packages/ui/src/hooks/primitives`.

- A11y: Replaced temporary `accessibility-fixes` patch module with explicit flags on base primitives. Added `a11y*` props to `BaseSelect`, `useBaseMultiSelect`, and `BaseRating`; updated unified/typeform/chat wrappers to set correct roles/ARIA (group vs combobox, haspopup/expanded, value ARIA).

- Architecture: Moved app-specific context/screens out of UI package. Removed `FormModeContext` exports from UI index; added app-owned `apps/formfiller/contexts/FormModeContext.tsx`. Moved Intro/Completion screens to `apps/formfiller/components/shared/` and updated imports. UI still exports `ConfettiElements` only from shared.

- UI/docs: Adjusted imports in Storybook and app chat components to import AI elements from `@formlink/ui/ai-elements` directly to avoid TS path alias issues.

- Preview stability: Guarded repeated shadcn CSS updates in `apps/formfiller/app/preview/[formId]/PreviewPageClient.tsx:FORMCRAFT_SHADCN_CSS_UPDATE` by comparing `payload.cssText` to `lastCssRef.current` to avoid postMessage feedback loops causing maximum update depth.

- Zustand shallow: Do NOT alias. Zustand v5 continues to export `shallow` from `zustand/shallow` (ESM/CJS). We removed the alias to `zustand/react/shallow` in `apps/formfiller/next.config.ts` because it breaks libraries (e.g., `@xyflow/react`) that import `{ shallow }`.

- Cleanup: Removed unused hooks under `packages/ui/src/hooks/form/*` and removed their public re-exports from `packages/ui/src/index.ts`. Confirmed no in-repo usages. Kept `hooks/ui` (`useIsMobile`, `useThemeStyles`) as they are used by UI components and apps.

- Cleanup: Removed unused app-level hook `apps/formcraft/hooks/use-mobile.tsx` (no references in app). Repo typecheck remains green.

- Cleanup: Removed empty directories `packages/ui/src/hooks/form` and `packages/ui/src/hooks/primitives` after pruning unused hooks.

- A11y: Removed temporary `accessibility-fixes` patch module. Added explicit accessibility flags to base primitives (`useBaseMultiSelect`, `BaseRating`) to control container role and ARIA attributes. Updated `UnifiedMultiSelect` and `UnifiedRating` to use the new flags. Result: no wrapper-side filtering, clearer semantics.

- A11y: Extended the same flag-based approach to `BaseSelect` and updated wrappers that render in-page lists (TypeFormSelect, TypeFormLikert, UnifiedLikert, ChatLikertScale) to use `a11yContainerRole='group'` and disable `aria-haspopup/expanded`. This replaces combobox defaults in those contexts and aligns ARIA with rendered semantics.

- Fix: Single-pass form creation repair now supplies required prompt variables to `form/create-form-repair.md` (`errors_json`, `json_payload`, `generation_context`). This prevents `loadPrompt: missing variables` errors during JSON repair in `apps/formcraft/app/lib/chat/tools/create-form.ts`.

- Enhancement: Pre-repair invalid JSON text with `jsonrepair` before schema repair. Applied in `apps/formcraft/app/lib/chat/tools/create-form.ts: repairFunction` and `apps/formcraft/app/lib/chat/tools/generate-question.ts: repairFunction` to reduce failures from malformed JSON strings. Installed dependency in `apps/formcraft`.

- UI primitives: Renamed `BaseMultiSelect` (hook-using function) to `useBaseMultiSelect` and updated all call sites (`packages/ui/src/form/modes/unified/UnifiedMultiSelect.tsx`) and re-exports (`packages/ui/src/form/primitives/base/index.ts`). Rationale: it’s a custom hook and must be called unconditionally at the top level; the new name makes this contract explicit and prevents conditional invocation leading to hook count mismatches.

- Security/Privacy: Removed ad-hoc debug/info logs and any logs that could emit PII (e.g., `contextPayload`, full responses). Retained/restored essential error logs with redacted messages in server routes. Touched: `apps/formfiller/app/api/ai/chat-assist/**`, branching routes, upload/save-answers/forms/chat-history APIs, and `lib/getFormSchema.ts`.

- Runtime: Unified error‑visibility policy moved into `@formlink/runtime`.

- Typeform mode: reveal errors on `actions.next()` and on submit; clear on `actions.set()` when valid.

- Classic mode: reveal errors on `actions.blur(qid)`; clear on `actions.set()` when valid. `next()` no longer reveals in classic.

- UI should render `context.get.visibleError(qid)` instead of `context.get.error(qid)`.

- UI: Combobox close-on-select

- Fixed `kibo-ui/combobox` so `ComboboxItem` always closes the popover on selection even when a consumer supplies `onSelect`. Implementation merges handlers instead of overriding. Affects `UnifiedDropdownSelect` (single-select dropdown) which now closes immediately after choosing an option.

- Formlink Runtime docs consolidated: `packages/runtime/docs/formlink-runtime-spec_v1_normative_only.md` (headless runtime API, preview sessions + linking + retention, chat UI contract, UI registry guidance, glue snippets). Master spec points to it from §3.5–3.6.

Logging policy

- Remove debug/info/trace logs from production code paths.

- Keep error logs for operational visibility; log only messages/identifiers that are non‑PII.

- Never log full user inputs, responses, or identifiers like `submissionId` together with content.

- Prefer structured, redacted telemetry (PostHog via `trackServerEvent`).

- Client `debugLog` shim remains a noop; see `apps/formfiller/components/chat/utils/debug.ts`.

Planned work

- Formfiller multilanguage (i18n) plan: docs/formfiller*i18n*plan_v1.md

## Mental Model (Zoomed Out)

The repository is a Turbo/PNPM monorepo for the Formlink platform. Two production Next.js applications (`formcraft` for admins/builders and `formfiller` for respondents) sit alongside a Storybook catalogue (`ui-docs`). Shared packages provide the design system, Zod schemas, Supabase clients, AI prompt templates, and lint/TypeScript baselines. Supabase serves as the single persistent backend, with lifecycle automation handled by a submission-intelligence pipeline that enriches responses and executes actions through a reusable runner.

```

Formlink Monorepo
├─ Apps
│  ├─ formcraft (admin/builder Next.js app)
│  ├─ formfiller (public respondent Next.js app)
│  └─ ui-docs (UI showcase)
├─ Shared Packages
│  ├─ @formlink/ui (design system & AI widgets)
│  ├─ @formlink/schema (Zod models)
│  ├─ @formlink/db (Supabase clients & types)
│  ├─ @formlink/prompts (guarded AI prompts)
│  └─ configs (eslint, tsconfig, integrations)
├─ Data Layer (Supabase schema + generated types)
├─ Automation/AI (submission job + action runner)
└─ Tooling (Turbo tasks, scripts, quality gates)

```

## Apps

### formcraft — Builder/Admin Portal (`apps/formcraft`)

Purpose: core control plane for creators. Provides form authoring, AI-assisted workflows, response intelligence dashboards, lifecycle automation configuration, subscription management, and marketing pages.

Key directories:

- `app/api/**` — Next.js route handlers exposing internal/external APIs (responses, actions, lifecycle, forms, auth helpers).

- `app/dashboard/**` — authenticated workspace UI; `forms/[formId]/` is the primary surface with tabbed sub-areas (Design, Form, Chat, Responses, Settings, Share).

- `app/dashboard/layout.tsx` — shared server header injected for all dashboard routes (SSR user menu, consistent top-right avatar); individual pages provide their own bodies below the fixed header.

- `app/dashboard/forms/[formId]/components/` — feature-specific UI modules (builder panels, response tables, automation dialogs, charting, lifecycle planner).

- `app/lib/` — shared server/client utilities: action runner, submission intelligence pipeline (`intel/submission-job`), AI orchestration helpers, feature flag logic, analytics, Supabase wrappers, SSE utilities.

- `app/hooks/` — React hooks for stateful client behavior (queries, editors, keyboard shortcuts).

- `app/actions/` — server actions coordinating Supabase operations and AI flows.

Important patterns:

- React 19 with server components + client wrappers; `ReactQueryClientProvider` wires TanStack Query.

- Fixed shared header on dashboard via `app/components/layout/header.tsx` rendered in `app/dashboard/layout.tsx`; avoid duplicating user menus in pages.

- TanStack Table + Query for response grids under `components/data-table`.

- AI planning surfaces (ResponseViewPlan) rely on prompt templates from `@formlink/prompts` and the lifecycle runner.

- Subscription and auth flows integrate Supabase Auth and third-party providers (Polar, Composio).

### formfiller — Respondent Runtime (`apps/formfiller`)

Purpose: public-facing application rendering published forms (classic, AI chat, preview). Handles submission saves, completion flow, and immediate feedback.

Key directories:

- `app/[formId]/**` — dynamic route responsible for form rendering modes, staging AI assist, and multi-step navigation.

- `app/api/forms/[formId]/save-answers` — main submission endpoint; after saving, calls lifecycle job via internal API.

- `app/api/ai/chat-assist` — orchestrates AI-assisted filling, also triggers lifecycle job on completion.

- `app/lib/` — shared utilities, analytics, Supabase client bootstrap for runtime.

- `components/`, `hooks/`, `contexts/` — UI and state containers (e.g., drag/drop rearrangement, progress tracking, global form state).

Important patterns:

- Heavy reuse of `@formlink/ui` widgets and `@formlink/schema` validation to align with builder definitions.

- Uses Supabase SSR helpers for authenticated preview flows.

- Schedules background intelligence via `after()` pipeline, ensuring respondent UX remains fast.

### ui-docs — Component Reference (`apps/ui-docs`)

Purpose: isolates design system documentation (Storybook/MDX) for designers and engineers testing components outside the main apps.

Key notes:

- Pulls from `@formlink/ui` exports directly to verify build outputs.

- Useful sandbox when extending shared UI before integrating into formcraft/formfiller.

## Shared Packages

### @formlink/ui (`packages/ui`)

- Structure: `src/ui/**` (primitive components), `src/ai-elements/**` (AI tooling surfaces), `src/components/**` (mid-level composites), `src/hooks/**`, `src/lib/**`, and `src/styles/globals.css`.

- Tech: Tailwind 4, Radix primitives, shadcn patterns, motion/Framer integration, TanStack utilities.

- Build: `tsup` for JS bundles, `tsc` for type declarations; exports configured for tree-shaking and CSS opt-in. The `build` script runs both JS and type declaration emits to ensure app type-checking has package types in CI.

- Cleanup (Nov 6): Removed unused directories and exports to keep `@formlink/ui` stateless and lean.

- Deleted `src/form/**` (contexts, primitives, modes: chat/typeform/unified) and dropped all related exports from `src/index.ts` — unified inputs now live in `@formlink/runtime/ui/react`.

- Deleted `src/hooks/typeform/**`; removed their exports. Kept `src/hooks/ui/use-mobile.ts` and `useTheme.ts` as the public hooks.

- Consolidated duplicate mobile hook: removed `src/hooks/use-mobile.ts` and fixed internal imports to `"@/hooks/ui/use-mobile"` (see `packages/ui/src/components/ui/sidebar.tsx`).

- Deleted `src/motion/**` and removed motion exports from package index (no in-repo usages).

- Deleted `src/icons/**` and unused `src/lib/config.ts`; neither is referenced in apps or stories.

- Trimmed `src/lib` of unused files (`file-handling.ts`, `motion.ts`, `routes.ts`); retained `utils.ts` which is widely used (`cn`).

- Removed unused `src/types/generic.ts` and its export.

TODO: Verify CI caches don’t skip `packages/ui` type emit; if necessary, add an explicit Turbo `type-check` task for `@formlink/ui` and wire it as a dependency for app builds.

- Testing: Jest + Testing Library, with optional visual regression hooks (jest-image-snapshot config present).

### @formlink/schema (`packages/schema`)

- Provides Zod schemas for forms/questions/settings, discriminated unions for question types, type guards, and validation helpers.

- Consumed by both apps to ensure consistent form definition and runtime validation; also referenced in AI prompts for schema enforcement.

- Tests under `src/__tests__` cover schema edge cases.

### @formlink/db (`packages/db`)

- Wraps Supabase clients for browser/server usage (`supabase/client.ts`, `supabase/server.ts`, `supabase/server-guest.ts`).

- Re-exports Supabase types and generated database typings (`src/types`).

- Build via `tsup`; includes `.env` for local supabase CLI usage.

### @formlink/prompts (`packages/prompts`)

- Organized under `md/**` with guard templates (`_guards.md`) and scenario-specific prompts (form creation, insights, lifecycle orchestration).

- Loader enforces parameter substitution (`{{placeholder}}`) and guardrail preamble.

- AI features across apps reference prompts by ID rather than duplicating strings.

- Respondent chat slot embedding policy (strict): every assistant turn that surfaces a new input must end with a single slot token `::PresentQuestionInputComponent qId="<questionId>"::` on its own line (no trailing text). Slots are the sole authority for wiring inline inputs; no auxiliary presentQuestion tool remains.

### Tooling Packages

- `packages/eslint-config` and `packages/typescript-config` centralize lint/TS rules; both apps/packages extend these to stay aligned.

- `packages/integrations/composio` reserved for automation toolkits; scaffold currently minimal but provides namespace for future connectors.

- `packages/prompts`, `packages/schema`, and `packages/ui` form the triad consumed by all frontends; ensure any breaking change propagates through Turbo tasks.

## Data & Backend Services

### Supabase as Source of Truth

- Schema: maintained in `packages/db/supabase/schema.sql`. Includes forms, form*versions, form*submissions, response*views, response*actions*log, tool*connections, lifecycle state (`forms.agent_state.lifecycle_v1`), and multi-tenancy scaffolding (`organizations`, `workspaces`).

- Generated Types: refresh with `pnpm db:gen-types` → writes to `packages/db/src/types/database.types.ts` for type-safe queries.

- Local Dev: `pnpm db:hard-reset` runs Supabase CLI, reloads schema, and notifies PgREST; ensure Docker or Supabase local env is running.

- Remote Coordination: background jobs and Next routes use Supabase service role keys (via environment) while maintaining RLS constraints.

### Backend Execution Paths

- API Routes (`apps/formcraft/app/api/**`): handle CRUD for forms/responses/actions, serve internal lifecycle endpoints, expose integration webhooks, and guard via Supabase auth or signed tokens.

- Server Actions (`apps/formcraft/app/actions/**`): incremental adoption for co-locating data mutations with UI; primarily used for builder flows.

- Shared Utilities (`apps/formcraft/app/lib/api.ts`, `lib/routes.ts`): centralize fetchers, Supabase RPC invocations, and error handling.

### Submission Intelligence Pipeline

- Location: `apps/formcraft/app/lib/intel/submission-job/` (`runner.ts`, `orchestrator.ts`, `executor.ts`, `sidecar.ts`, `tool-*.ts`).

- Flow: `runSubmissionJob({ submissionId, versionId, trigger })` → fetch submission/answers (Sense) → orchestrate heuristics/AI (Decide) → execute actions via Action Runner (Act) → persist sidecar metadata (`form_submissions.metadata.sidecar`) and log telemetry (Surface).

- Tools: modular helpers for spam detection, scoring, enrichment, tagging; easily swappable with AI-powered implementations.

- Guardrails: respects lifecycle configuration (`forms.agent_state.lifecycle_v1`), testmode skips, idempotency via action logs.

### Action Runner

- Location: `apps/formcraft/app/lib/actions/runner.ts`.

- Responsibilities: Accept normalized action descriptors, materialize provider clients (Usesend, Composio, etc.), enforce throttles/guardrails, log executions to `response_actions_log` with idempotency keys, and return structured results.

- Consumers: manual bulk actions, view-based automations, lifecycle submission jobs, API endpoints.

### Analytics & Telemetry

- `apps/formcraft/app/lib/analytics.ts` and `analytics/` directory manage event emission (PostHog, internal logging) for both builder and runtime experiences.

- Sidecar metadata exposes derived insights to the dashboard for filtering and charting (`components/responses/charts`).

## Cross-App Flow

1. Respondent interacts with `formfiller`; submissions are written to Supabase.

2. `formfiller` schedules a background job (via `/api/internal/lifecycle`) after saves/completions.

3. `formcraft`'s submission-intelligence runner enriches data, persists sidecar fields, and triggers allowed actions.

4. Response dashboards surface sidecar metadata and provide manual/bulk action controls backed by the same runner.

Additional touchpoints:

- Shared Supabase clients ensure both apps respect the same auth/session handling.

- `@formlink/ui` components keep visual/stylistic parity between creator preview and responder runtime.

- Prompt templates align AI narratives between builder (planning) and respondent (assist) journeys.

## Tooling & Operations

- Turbo tasks (`turbo.json`) coordinate `dev`, `build`, `lint`, `type-check`, and `test` across workspaces.

- Monorepo relies on PNPM (`pnpm-workspace.yaml`) with scripts for DB resets (`pnpm db:hard-reset`), type generation, and repo-wide quality checks.

- Each workspace defines its own lint/type-check commands while inheriting shared config packages, keeping CI consistent.

Additional guidance:

- Preferred commands: `pnpm dev` (runs Turbo dev for filtered apps), `pnpm typecheck` (repo-wide), `pnpm -w lint`, `pnpm test` where applicable.

- Husky/lint-staged enforce Prettier on staged files; follow import ordering rules (prettier sort plugin).

- CI expectations: zero lint/type errors; run targeted tests when modifying shared packages or critical flows.

- Environment: `.env.local` files per app contain Supabase keys, AI provider credentials, Composio tokens; never commit secrets.

Documentation Index (selected)

- Project spec and public contracts

- packages/runtime/docs/formlink-runtime-spec*v1*normative_only.md — single, canonical spec for runtime + chat + registry + preview

- docs/runtime/formlink-runtime-low-level-examples_v1.md — low‑level wiring examples for common requests

- docs/runtime/runtime-impl-plan_v1.md — implementation plan for @formlink/runtime (TanStack, transports, selectors)

- docs/runtime/llm-codegen-contract_v1.md — pasteable contract for LLM codegen to generate deployable forms

- docs/ui/form-components.md — overview of supported @formlink/ui form components (Unified\* inputs, Field, InputGroup), usage patterns, and runtime wiring guidelines

- Chat runtime data flow (AI-assisted inputs): docs/chat-runtime-data-flow_v1.md

### Component API Notes

- ActionsManagerCard (`apps/formcraft/app/dashboard/forms/[formId]/components/responses/ActionsManagerCard.tsx`)

- Props: `formId: string`, `mode: "lifecycle" | "view"`, `actions?: { slug: string; provider: "usesend" | "composio"; params?: Record<string, unknown> }[]`

- Change: Previously accepted a `plan` and internally derived proposed actions. Now accepts a flat `actions[]` list for proposed items. It still reads configured actions from lifecycle config (lifecycle mode) or active view (view mode) and renders the union.

- SetupDrawer (`apps/formcraft/app/dashboard/forms/[formId]/components/responses/ResponseViewPlan/SetupDrawer.tsx`)

- Refactor (2025-10-06):

- Props typed via `SetupDrawerProps`; destructuring moved inside function body.

- All React state defined before effects; debug logs removed.

- Network work moved to TanStack Query: questions + schema keys via `useQuery` with `await` fetches.

- Complex schema key extraction isolated to pure helpers (`extractKeysFromSchemaJson`, curated fallbacks for HubSpot).

- Auto-suggestion logic extracted into a `useCallback` and invoked from small effects (no inline function defs inside effects).

- Polling constants hoisted (`POLL_INTERVAL_MS`, `POLL_TIMEOUT_MS`).

### Developer Workflow Checklist

1. **Install**: `pnpm install` (workspace aware).

2. **Run Supabase locally** if touching backend: `pnpm -C packages/db dlx supabase start --workdir ./supabase` or use `pnpm db:hard-reset` for clean state.

3. **Launch apps**: `pnpm dev:craft` (builder) and/or `pnpm dev:fill` (responder); `pnpm dev:all` runs both in parallel.

4. **Type/Lint**: run before commit; treat failures as blockers.

5. **Testing**: `pnpm --filter @formlink/ui test` for UI lib, targeted jest commands when modifying components; integration tests live under `apps/formfiller/integration-tests`.

6. **Docs**: authoritative design docs live in `docs/` (see below).

### Key Conventions

- **Imports**: prefer path aliases (`@/app/...`, `@formlink/ui/...`) defined in `tsconfig.json` files; avoid deep relative paths.

- **Styling**: Tailwind utility classes with `tailwind-merge`; global theming via `next-themes`.

- **State**: TanStack Query for async data, Zustand for local stores (e.g., builder state machine under `app/dashboard/forms/[formId]/stores`).

- **Forms**: `react-hook-form` + Zod resolvers; question schemas defined centrally.

- **AI**: use prompt loader + guard rails; do not concatenate strings or bypass guard templates.

- **Error Handling**: server routes throw typed errors; UI surfaces toasts (`sonner`) or inline banners.

## Domain Reference

### Custom Domains

- Design: docs/custom*domains*v1.md — Data model, APIs, middleware, and builder UI for mapping user-owned domains to specific forms (1:1). Includes DNS verification, provider activation, and runtime Host-based routing.

### Form Authoring

- Builder UI: `components/form/` and `components/design/` provide drag/drop editing, AI suggestions (`FormGenerationExample`, `ChatDesignPanel`).

- Versioning: forms reference `form_versions` in Supabase; API routes manage drafts/published states.

- Settings & Share: `components/settings/`, `components/share/` handle metadata, theme overrides, embeds.

### Responses & Intelligence

- Responses tab: `components/responses/Responses.tsx` integrates table, filters, actions, insights.

- Data fetching: `hooks/useFormResponsesQuery.ts` wraps RPC `get_filtered_submissions`; filters generated via `lib/responses/generateFilterFieldsFromForm.tsx`.

- View planning: `components/responses/ResponseViewPlan` orchestrates AI plan, Submission Actions dialog (`SubmissionActionsDialog.tsx`), setup wizard.

- Automation plan: chat can emit a dedicated lifecycle plan event; UI renders a standalone card (no view created) in a right-hand drawer.

- Charts & Insights: `components/responses/charts` and `insights` render aggregated metrics (TanStack, Recharts).

### Automations & Actions

- Submission Automations (Per submission): form‑level lifecycle stored under `forms.agent_state.lifecycle_v1`. UI label “Submission Automations” with “Submission Hooks”, “Actions to Run”, and “Automation Rules”.

- Config: `GET/PUT /api/forms/[formId]/lifecycle`.

- JSON: `enabledHooks` (subset of `spam|enrichment|lead|tags`), `allowedActions`, `guardrails`, `orchestratorPrompt`. Back‑compat: `enabledTools` accepted and mapped to `enabledHooks`.

- Back‑compat guardrails: older rows may store `guardrails: null`; API/runner normalize this to `{}` before merging with defaults to avoid crashes.

- Execution: lifecycle job (`lib/intel/submission-job`) runs on save/completion.

- Response View Bulk Actions (Manual): configured per view; execute on selection/filter. Not part of Submission Automations.

- Action execution: `app/api/actions/execute` → `lib/actions/runner.ts` (shared by manual/view/lifecycle paths).

- Future triggers research documented in `docs/automation_triggers_v1.md` (deferred).

### AI Prompting & Agents

- Prompt templates: `packages/prompts/md/**`; new prompts must include guard header referencing `_guards.md`.

- Agents: `app/lib/agents/**` organizes orchestrators and reasoning helpers; `app/lib/ai/**` encapsulates provider routing (OpenAI, OpenRouter, Braintrust).

- Submission intelligence design tracked in `docs/submission_intelligence_job_v1.md` (latest plan) and `docs/submission_automations_concepts_v1.md` (naming).

- Chat tool: `proposeLifecycleAutomation` emits `data-agent_event` `type: "lifecycle_automation_plan"`.

- Event wiring: `components/chat/ChatPanel.tsx` (opens drawer via `useAutomationsPlanStore`).

- UI: `components/responses/SubmissionAutomationsCard.tsx` applies proposed `allowedActions`, `enabledHooks`, and `orchestratorPrompt` via `useAutomationsConfig`.

### Multi-Tenancy & Auth

- Supabase tables `organizations` and `workspaces` provide tenant scoping; current UI still primary-user centric but data model ready for expansion.

- Auth flows: `app/auth/**` handles Supabase auth UI and server helpers; `app/providers/**` wires providers (theme, query, analytics).

- Feature flags: `app/lib/feature-flags.ts` centralizes toggles.

### Logging & Monitoring

- `app/lib/logger.ts` (formcraft) and `apps/formfiller/app/lib/logger.ts` (runtime) provide structured logging wrappers.

- Response/action logs accessible via Supabase tables; UI surfaces history in responses tooling.

## Documentation & Further Reading

- `docs/submission_intelligence_job_v1.md` — authoritative background job specification (verify latest before edits).

- `docs/automation_triggers_v1.md` — future-state trigger DSL research.

- `docs/formlinkflow-engine-implementation-plan_v1.md` — FormlinkFlow: centralized, AI-first flow engine (JSONata routes, compile/analyze/nextNode/path, Typeform/Classic integration, Devtools simulation, limitations & mitigations). (Note: previously named branching engine.)

## Mintlify — Runtime Docs (code-based)

- Primary config: `packages/runtime/docs/mint.json` (site root for published docs).

- Scope: publish only `packages/runtime/docs/**/*` (public runtime docs, examples, pitfalls). Internal repo docs under `docs/` remain private.

- Added landing: `packages/runtime/docs/index.mdx` and updated navigation in `mint.json` to include `index` first.

- Added `packages/runtime/docs/design-guidelines.md` (Design & UX) and wired a new "Design & UX" group in navigation.

- Added `packages/runtime/docs/pitfalls/shadcn-missing-primitives.md` and linked in "Pitfalls" group.

Verification (local preview):

- From `packages/runtime/docs`, run: `pnpm dlx mint dev --port 3100`

- Keep app `pnpm run dev` running; this uses a separate port.

Publish (Mintlify Cloud):

- Settings → Code-based → Docs directory: set to `packages/runtime/docs`.

- Mintlify looks for `mint.json` or `docs.json` in that directory.

- Branch defaults to `main`; adjust as needed.

Notes / TODOs:

- TODO(mintlify): If any page shows as “Untitled”, add frontmatter `title:`.

- TODO(mintlify): Add brand colors/logo later; currently `#3b82f6`.

- `docs/` folder holds additional context; keep synchronized when architecture evolves.

- `AGENTS.md` — operational rules for AI agents collaborating on the repo.

## Quick Start for Contributors & Agents

1. Read this file end-to-end to internalize architecture.

2. Skim schema.sql for data model awareness.

3. Run `pnpm dev:craft` and `pnpm dev:fill` to observe both surfaces; log in via Supabase auth.

4. When implementing features:

- Identify target domain (builder, runtime, shared).

- Locate corresponding directory (see above) and review existing patterns.

- Update prompts via loader (no ad-hoc strings).

- Extend schema definitions first, then UI/backend.

5. Validate with lint/type-check/tests and document any new behaviors under `docs/`.

This context should equip both humans and AI agents to reason about Formlink’s architecture, locate relevant modules quickly, and implement features while respecting existing contracts and guardrails.

## Mintlify — Runtime Docs Site (code-based)

- Added `docs/runtime/docs.json` and `docs/runtime/index.mdx` to publish only `@runtime/docs` via Mintlify’s code‑based workflow.

- Scope: pages under `docs/runtime/` are surfaced; navigation grouped (Overview, Specification, Implementation, Policies & Ideas, Examples).

Verification (local preview):

- Ensure `pnpm` is installed.

- From `docs/runtime/`, run: `pnpm dlx mint dev --port 3100`

- This avoids conflicts with any app dev server; don’t stop `pnpm run dev`.

Publish (Mintlify Cloud):

- In Mintlify Cloud → Create site → Connect this repository.

- Set the docs directory to `docs/runtime` (where `docs.json` lives).

- Mintlify will build from `main` by default; adjust branch as needed.

Notes / TODOs:

- TODO(mintlify): If any page shows as “Untitled”, add frontmatter `title:` to the source `.md` file.

- TODO(mintlify): Add brand colors/logo later; currently using a neutral primary `#3b82f6`.

- Runtime/Flow: Added deep explainer `docs/formlinkflow_typeform_transition_explainer_v1.md` covering FormlinkFlow navigation semantics, Typeform visibility (required‑only gating), the animation architecture, and the two tricky bugs (optional back navigation and direction/opacity issues) with fixes and modeling patterns for deferred branching (depend on Q1, execute at Q5).

## Shadcn Registry (formlink)

- We maintain a dedicated registry app at `apps/registry` to serve shadcn-compatible items under `/r/{name}.json`.

- Purpose: install formlink templates into host apps via `shadcn add`.

What’s included

- `chat-template`: Chat template with embedded providers

- `classic-template`: Classic template with embedded ShadCnProvider

- `typeform-template`: Typeform template with embedded ShadCnProvider

Location

- Built items are emitted to `apps/registry/public/r/*.json` via `shadcn build`.

- Source lives under `apps/registry/registry/**` and is compiled by the CLI.

Usage (from a host app)

- Install with shadcn CLI (one-off):

- `pnpm dlx shadcn@latest add chat-template --registry https://registry.formlini.ai/r`

- Dependency resolution:

- NPM deps are declared via `dependencies` (e.g., `@formlink/runtime`, `lucide-react`). The CLI adds them to the host app.

- UI primitives and AI elements are declared via `registryDependencies` and will be installed (e.g., `button`, `input`, `ai-elements/conversation`, `ai-elements/prompt-input`, `ai-elements/response`). Ensure your components.json has the AI registry mapping if you use chat.

- Styling:

- Import CSS once: `import "@formlink/runtime/ui/react/style.css"` (e.g., in your root layout).

- Namespaces:

- Recommended `components.json` registries mapping in the host:

- `"registries": { "@formlink": "https://registry.formlini.ai/r/{name}.json", "@ai-elements": "https://registry.ai-sdk.dev/{name}.json" }`

- Then: `pnpm dlx shadcn@latest add @formlink/chat-template`

- Runtime injection for Classic/Typeform:

- `import { createRuntime } from "@formlink/runtime";`

- `const runtime = createRuntime({ form, transport });`

- `<ClassicTemplate runtime={runtime} />` or `<TypeformTemplate runtime={runtime} />`

Notes

- Templates are provider-agnostic; they throw in dev if required providers are missing.

- If you prefer pure shadcn components instead of `@formlink/ui`, replace imports inside the provider file with your local `@/components/ui/*` equivalents; keep the `ShadCnProvider` keys intact.

### Registry App — Build & Deploy

- Build registry JSON:

- `pnpm --filter registry run registry:build`

- Local preview: `pnpm --filter registry dev` then visit `http://localhost:3000/r/chat-template.json`.

- Production build: `pnpm --filter registry build` (runs `shadcn build` then `next build`).

- Deploy to Vercel:

- Project root: `apps/registry`

- Custom domain: `registry.formlini.ai`

- Output: static JSON served from `public/r/*`.
