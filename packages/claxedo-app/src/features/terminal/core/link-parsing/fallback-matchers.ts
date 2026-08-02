/*---------------------------------------------------------------------------------------------
 *  Fallback matchers for special link formats that the main parser doesn't catch.
 *  Ported from VSCode's terminalLocalLinkDetector.ts
 *--------------------------------------------------------------------------------------------*/

/**
 * A link detected by a fallback matcher.
 */
export interface IFallbackLink {
	/** The full link text including line/col suffix */
	link: string;
	/** The path portion of the link */
	path: string;
	/** Line number if detected */
	line?: number;
	/** Column number if detected */
	col?: number;
	/** Index in the original line where the link starts */
	index: number;
}

/**
 * Fallback matchers for special formats that the main parser doesn't catch.
 * These are mainly designed to catch paths with spaces or special tool output formats.
 */
// Ordered specific → generic. `detectFallbackLinks` stops at the first matcher
// that hits, so the generic C++ formats MUST come last: their unanchored greedy
// paths used to bind Rust/Go/Node/Ruby/Swift/ESLint lines first and swallow the
// surrounding text (arrows, "at ...", "from ...") into the path.
// All matchers carry the `d` flag so link positions come from match indices
// rather than a textual `indexOf` (which finds the wrong occurrence when the
// link text also appears earlier in the match).
const fallbackMatchers: RegExp[] = [
	// Python style error: File "<path>", line <line>
	// Example: File "/path/to/file.py", line 42
	// Lazy path so a later quoted string on the same line can't extend it.
	/^ *File (?<link>"(?<path>.+?)"(?:, line (?<line>\d+))?)/d,

	// Unknown tool format: FILE  <path>:<line>:<col>
	// Example:  FILE  /path/to/file.ts:10:5
	/^ +FILE +(?<link>(?<path>.+?)(?::(?<line>\d+)(?::(?<col>\d+))?)?)\s*$/d,

	// Rust/Cargo error format:
	// Example: --> src/main.rs:10:5
	/^ *--> (?<link>(?<path>[^:]+):(?<line>\d+)(?::(?<col>\d+))?)/d,

	// Go error format:
	// Example: path/file.go:10:5: undefined: foo
	/^(?<link>(?<path>[^\s:]+\.go):(?<line>\d+)(?::(?<col>\d+))?):/d,

	// Java/Kotlin stack trace:
	// Example: at com.example.Class.method(File.java:10)
	/\bat \S+\((?<link>(?<path>[^:)]+):(?<line>\d+))\)/d,

	// Node.js/JavaScript stack trace:
	// Example: at Object.<anonymous> (/path/to/file.js:10:5)
	// Example: at Module._compile (node:internal/modules/cjs/loader:1105:14)
	/\bat .+\((?<link>(?<path>\/[^:)]+):(?<line>\d+)(?::(?<col>\d+))?)\)/d,

	// ESLint/Prettier/TypeScript style (with dash separator):
	// Example: /path/to/file.js:10:5 - error: Something went wrong
	/^(?<link>(?<path>\/[^\s:]+):(?<line>\d+)(?::(?<col>\d+))?) [-–]/d,

	// Webpack/Vite error format:
	// Example: @ ./src/file.ts 10:5-20
	/^@ (?<link>(?<path>\.[^\s]+) (?<line>\d+):(?<col>\d+))/d,

	// Ruby error format:
	// Example: from /path/to/file.rb:10:in `method'
	/from (?<link>(?<path>[^:]+):(?<line>\d+)):in/d,

	// PHP error format:
	// Example: in /path/to/file.php on line 10
	/in (?<link>(?<path>[^\s]+) on line (?<line>\d+))/d,

	// Swift error format:
	// Example: /path/to/file.swift:10:5: error: ...
	/^(?<link>(?<path>[^\s:]+\.swift):(?<line>\d+)(?::(?<col>\d+))?):/d,

	// C++ compile error formats (Visual Studio CL/NVIDIA CUDA compiler):
	// Example: C:\foo\bar baz(339) : error C2065
	// Example: C:\foo\bar baz(339,12) : error C2065
	// Example: /path/to/file.cpp(339): error
	// Lazy path: greedy `.+` bound the LAST "(digits)" pair and pulled leading
	// junk into the path. The terminating colon must be followed by a space or
	// line end (real compiler output always has ": error ..."), so the matcher
	// can't satisfy itself by consuming part of a location it mis-parsed.
	/^(?<link>(?<path>.+?)\((?<line>\d+)(?:, ?(?<col>\d+))?\)) ?:(?= |$)/d,

	// C++ compile error formats (Clang/GCC):
	// Example: /path/to/file.cpp:339:12: error: ...
	// Example: C:\foo/bar baz:339: error ...
	// Lazy path (greedy `.+` turned "/a.cpp:42:9:" into path "/a.cpp:42" line 9)
	// and no ": " inside the path, so message prefixes like "warning: /a.c:1:2:"
	// fail cleanly instead of matching with the prefix baked into the path. The
	// terminating colon must be followed by a space or line end (real compiler
	// output is "file:339:12: error: ..."), otherwise the matcher terminates
	// itself with the colon of a column suffix and hijacks plain
	// "path:line:col" text that the primary detector parses correctly.
	/^(?<link>(?<path>(?:[^:]|:(?! ))+?):(?<line>\d+)(?::(?<col>\d+))?) ?:(?= |$)/d,

	// PowerShell and cmd prompt (extracts CWD from prompt):
	// Example: PS C:\Users\foo>
	// Example: C:\Users\foo>
	// Require a drive letter (X:\) or UNC path (\\) to avoid false positives on lines containing =>
	/^(?:PS\s+)?(?<link>(?<path>(?:[a-zA-Z]:[\\/]|\\\\)[^>]*))>/d,
];

/**
 * Detect links using fallback matchers for special formats.
 * These catch paths that the main regex-based parser might miss.
 *
 * @param line The line to search for links
 * @returns Array of detected fallback links
 */
export function detectFallbackLinks(line: string): IFallbackLink[] {
	const results: IFallbackLink[] = [];

	for (const matcher of fallbackMatchers) {
		const match = matcher.exec(line);
		const groups = match?.groups;
		if (!match || !groups?.link || !groups.path) {
			continue;
		}

		// Prefer the capture group's real position (`d` flag). A textual indexOf
		// lands on the wrong cells when the link text also occurs earlier in the
		// match, e.g. "at A.java:12.run(A.java:12)".
		const groupIndices = (
			match as RegExpExecArray & {
				indices?: { groups?: Record<string, [number, number] | undefined> };
			}
		).indices?.groups;
		let linkIndex = groupIndices?.link?.[0];
		if (linkIndex === undefined) {
			const linkOffset = match[0].indexOf(groups.link);
			if (linkOffset === -1) {
				continue;
			}
			linkIndex = (match.index ?? 0) + linkOffset;
		}

		results.push({
			link: groups.link,
			path: groups.path,
			line: groups.line ? Number.parseInt(groups.line, 10) : undefined,
			col: groups.col ? Number.parseInt(groups.col, 10) : undefined,
			index: linkIndex,
		});

		// Only use the first matching fallback to avoid duplicates
		break;
	}

	return results;
}

/**
 * Characters that are likely to be trailing punctuation, not part of the path.
 */
const TRAILING_SPECIAL_CHARS = /[[\]"'.,;:!?)]+$/;

/**
 * A trimmed path candidate with the amount trimmed.
 */
export interface ITrimmedCandidate {
	/** The trimmed path */
	path: string;
	/** Number of characters trimmed from the end */
	trimAmount: number;
}

/**
 * Generate alternative link candidates by trimming trailing special characters.
 * This helps when paths are followed by punctuation that got included.
 *
 * @param path The original path
 * @returns Array of trimmed candidates, most trimmed last
 */
export function generateTrimmedCandidates(path: string): ITrimmedCandidate[] {
	const candidates: ITrimmedCandidate[] = [];
	let current = path;
	let totalTrimmed = 0;

	while (true) {
		const match = current.match(TRAILING_SPECIAL_CHARS);
		if (!match) break;

		const trimmed = current.slice(0, -match[0].length);
		totalTrimmed += match[0].length;

		if (trimmed.length === 0) break;

		candidates.push({ path: trimmed, trimAmount: totalTrimmed });
		current = trimmed;
	}

	return candidates;
}
