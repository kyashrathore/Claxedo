# Source Context Data Model Design

## Overview

This document defines the data model for capturing source context when WorkGraph runs are created from pasted specs, docs, or other intake sources.

## TypeScript Interface

```typescript
type SourceKind = "spec" | "doc" | "task" | "issue" | "template_instance" | "recurring_trigger"

interface RunSource {
  run_id: string
  kind: SourceKind
  title: string
  content: string
  source_path: string | null
  created_at: string
}
```

## Design Decisions

### 1. Source-to-Run Linking: Foreign Key Relationship

**Decision:** Use a separate `run_sources_current` table with `run_id` as the primary key (1:1 relationship).

**Rationale:**

- Current implementation uses `run_id` as PRIMARY KEY in `run_sources_current` — enforces 1:1
- FK from `runs_current.source_id` provides back-reference (nullable for manually-created runs)
- Clean separation allows independent evolution of source metadata
- Query performance: direct lookup by run_id without join

**Schema:**

```sql
CREATE TABLE run_sources_current (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_path TEXT,
  created_at TEXT NOT NULL
);

-- Optional: FK constraint (if SQLite supports it in your version)
-- ALTER TABLE runs_current ADD CONSTRAINT fk_run_source
-- FOREIGN KEY (source_id) REFERENCES run_sources_current(run_id);
```

### 2. Persistence Strategy: SQLite via Bun

**Decision:** Use SQLite (already implemented in `packages/workgraph/src/app.ts`) with Bun's built-in SQLite support.

**Rationale:**

- Already the primary storage backend for WorkGraph
- Survives page refresh (server-side persistence)
- Supports complex queries for filtering by kind, date range
- ACID compliant for concurrent access
- Natural fit for desktop/CLI app architecture

**Storage Location:** SQLite database file in app data directory (e.g., `~/.opencode/data.db`)

### 3. One Source vs Multiple Sources per Run

**Decision:** One source per run (1:1 relationship).

**Rationale:**

- Simplicity: current implementation enforces this via PRIMARY KEY
- Clear ownership: each run has single intake source
- Future extensibility: if multiple sources needed, can create junction table
- Use cases like "spec + context doc" can be handled by:
  - Including context in the primary source content
  - Creating separate runs for each source
  - Using the `template_instance` kind to reference parent sources

**Alternative considered:** Multiple sources (1:N)

- Rejected for v1 to keep implementation simple
- Can be added later if demand emerges

### 4. Retrieval API Shape

**Decision:** RESTful endpoint returning single source object.

**Current Implementation:**

```typescript
// GET /runs/:run_id/source
app.get("/runs/:run_id/source", async (c) => {
  const runId = c.req.param("run_id")
  const row = db.query("SELECT * FROM run_sources_current WHERE run_id = ?").get(runId)
  return c.json(row ?? null)
})
```

**Response:**

```json
{
  "run_id": "run_01ABC123",
  "kind": "spec",
  "title": "Q1 Product Roadmap",
  "content": "Full pasted spec text...",
  "source_path": null,
  "created_at": "2026-03-14T10:30:00.000Z"
}
```

**Frontend Usage:**

```typescript
const src = await api("/runs/" + runId + "/source")
// Display: src.kind, src.title, src.content.length, src.source_path
```

### 5. Storage Key Conventions

**Database Table:** `run_sources_current`

**Column Naming:** snake_case (SQLite convention)

- `run_id` - PRIMARY KEY, FK to runs_current
- `kind` - source type enum
- `title` - human-readable label
- `content` - raw text content
- `source_path` - optional file/URL path
- `created_at` - ISO 8601 timestamp

**API Response Keys:** camelCase (JSON convention)

- Matches TypeScript interface properties

## Implementation Notes

### Current Implementation Status

- ✅ Table exists: `run_sources_current` (lines 71-80 in `app.ts`)
- ✅ API endpoint exists: `GET /runs/:run_id/source` (lines 445-470)
- ✅ Creation on orchestrate: `INSERT OR REPLACE INTO run_sources_current` (orchestrate.ts:78)
- ✅ Frontend consumption: Dashboard renders source chips (dashboard.html.ts:1193-1196)

### Gaps to Address

1. **TypeScript types:** Define `SourceKind` enum and `RunSource` interface in shared types
2. **Validation:** Add input validation for kind enum on source creation
3. **Multiple sources:** Not supported in v1 — document limitation
4. **Content size limits:** Consider capping at 100KB to prevent DB bloat

### Future Enhancements

- Multiple sources per run: Add `run_source_junction` table
- Source versioning: Add `version` column for edits
- Source templates: Pre-defined templates for common intake formats
- Fetch from URL: Add `source_url` field and auto-fetch capability
