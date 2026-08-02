import {
	decodeUrlEncodedPath,
	detectFallbackLinks,
	detectLinks,
	getCurrentOS,
	type IFallbackLink,
	type IParsedLink,
	removeLinkSuffix,
} from "../link-parsing/index";
import type { ILink } from "@xterm/xterm";
import {
	WrappedLineLinkProvider,
	type LinkProviderTerminal,
} from "./multi-line-link-provider";

/**
 * A link provider that detects file paths in terminal output using VSCode's
 * terminal link parsing logic. Supports a wide variety of path formats including:
 *
 * - Basic paths: /path/to/file.ts, ./src/file.ts, ~/config.json
 * - With line numbers: file.ts:42, file.ts:42:10
 * - With line ranges: file.ts:42-50, file.ts:42:10-50
 * - Parenthesis format: file.ts(42), file.ts(42, 10)
 * - Square bracket format: file.ts[42], file.ts[42, 10]
 * - Verbose formats: "file.ts", line 42, col 10
 * - Git diff paths: --- a/path/file.ts, +++ b/path/file.ts
 *
 * Also handles multi-line wrapped paths across all wrapped rows of the
 * logical line (bounded by the base class's stitching cap).
 *
 * Extends {@link WrappedLineLinkProvider} to reuse the shared line-stitching
 * (`computeLineContext`) and wrapped-line range math (`calculateLinkRange`).
 * It overrides `provideLinks` rather than using the regex-driven
 * MultiLineLinkProvider path because path detection runs VSCode's structured
 * `detectLinks` (prefix/path/suffix) plus a fallback-matcher pass, not a single
 * regex.
 */
export class FilePathLinkProvider extends WrappedLineLinkProvider {
	constructor(
		terminal: LinkProviderTerminal,
		private readonly onOpen: (
			event: MouseEvent,
			path: string,
			line?: number,
			column?: number,
			lineEnd?: number,
			columnEnd?: number,
		) => void,
	) {
		super(terminal);
	}

	private readonly ignored =
		/(^|[\\/])(?:node_modules|\.git|\.next|dist|build|coverage|out|vendor|target|__pycache__|\.turbo|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv)([\\/]|$)/;

	provideLinks(
		bufferLineNumber: number,
		callback: (links: ILink[] | undefined) => void,
	): void {
		const ctx = this.computeLineContext(bufferLineNumber);
		if (!ctx) {
			callback(undefined);
			return;
		}

		const { combinedText, currentLineOffset, currentLineLength } = ctx;
		const currentLineStart = currentLineOffset;
		const currentLineEnd = currentLineOffset + currentLineLength;

		const links: ILink[] = [];

		// Fallback matchers first: they parse whole-line tool formats (Python
		// tracebacks, compiler output) that the token-based primary detector
		// mangles — e.g. a quoted path with spaces becomes two bogus primary
		// links. Where a fallback matched, it wins and overlapping primary
		// detections are dropped. (Previously fallbacks only ran when primary
		// detection found NOTHING on the line, which made them unreachable for
		// exactly the lines they were written for.)
		const fallbackRanges: Array<{ start: number; end: number }> = [];
		for (const fallback of detectFallbackLinks(combinedText)) {
			if (this.shouldSkipPath(fallback.path)) {
				continue;
			}
			if (!this.isExplicitPath(fallback.path) && !this.hasDotBasename(fallback.path)) {
				continue;
			}

			const linkStart = fallback.index;
			const linkEnd = fallback.index + fallback.link.length;
			fallbackRanges.push({ start: linkStart, end: linkEnd });

			// Only report links that touch the hovered row
			if (linkEnd <= currentLineStart || linkStart >= currentLineEnd) {
				continue;
			}

			links.push({
				range: this.calculateLinkRange(ctx, linkStart, linkEnd),
				text: fallback.link,
				decorations: this.linkDecorations(),
				activate: (event: MouseEvent) => {
					this.handleFallbackActivation(event, fallback);
				},
			});
		}

		// Use VSCode's link detection
		const os = getCurrentOS();
		const detectedLinks = detectLinks(combinedText, os);

		for (let parsedLink of detectedLinks) {
			// Strip trailing punctuation from paths without suffixes
			// (paths with suffixes like :42 already have proper boundaries)
			if (!parsedLink.suffix) {
				parsedLink = this.stripTrailingPunctuation(parsedLink, combinedText);
			}

			// Calculate the full link range including prefix and suffix
			const linkStart = parsedLink.prefix?.index ?? parsedLink.path.index;
			const linkEnd = parsedLink.suffix
				? parsedLink.suffix.suffix.index + parsedLink.suffix.suffix.text.length
				: parsedLink.path.index + parsedLink.path.text.length;

			// A fallback link already covers this span with a better parse
			if (fallbackRanges.some((fb) => linkStart < fb.end && linkEnd > fb.start)) {
				continue;
			}

			// Check if this link overlaps with the current line
			if (linkEnd <= currentLineStart || linkStart >= currentLineEnd) {
				continue;
			}

			// Get the path text (without suffix for opening)
			const pathText = parsedLink.path.text;

			// Skip URLs
			if (this.isUrl(pathText, linkStart, combinedText)) {
				continue;
			}

			// Skip noisy/ignored paths (common build artifacts, deps, etc.)
			if (this.shouldSkipPath(pathText)) {
				continue;
			}

			// Skip version strings like v1.2.3
			if (this.isVersionString(pathText)) {
				continue;
			}

			// Skip npm package references like @scope/package@1.2.3
			if (this.isNpmPackageReference(pathText, linkStart, combinedText)) {
				continue;
			}

			// Skip pure numeric patterns
			if (/^\d+(:\d+)*$/.test(pathText)) {
				continue;
			}

			// Skip numeric ratio-ish patterns like 1/2, 10/20/30
			if (/^\d+(?:\/\d+)+$/.test(pathText)) {
				continue;
			}

			// Require an explicit path prefix (./, ../, ~/, /, drive, UNC, file://) OR a filename
			// that looks like a real file (basename contains a dot). This prevents linkifying
			// generic "word/word" fragments and random "foo 123:456" suffix matches.
			if (!this.isExplicitPath(pathText) && !this.hasDotBasename(pathText)) {
				continue;
			}

			// Build the full link text for display
			const fullLinkText = combinedText.substring(linkStart, linkEnd);

			links.push({
				range: this.calculateLinkRange(ctx, linkStart, linkEnd),
				text: fullLinkText,
				decorations: this.linkDecorations(),
				activate: (event: MouseEvent) => {
					this.handleActivation(event, parsedLink);
				},
			});
		}

		callback(links.length > 0 ? links : undefined);
	}

	private shouldSkipPath(pathText: string): boolean {
		// Common shell devices/redirections that are rarely useful to open.
		if (pathText === "/dev/null" || pathText.startsWith("/dev/fd/")) {
			return true;
		}

		// CLI flags/globs frequently get mis-detected via "suffix" parsing, eg:
		// --include="*.test.ts" 2>/dev/null
		if (/^--?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:=|$)/.test(pathText)) {
			return true;
		}
		if (/[*?[\]]/.test(pathText)) {
			return true;
		}

		if (pathText.startsWith("node:")) {
			return true;
		}

		// Git hash ranges like "9ebf9967e..a514ef81e" from diff index headers
		if (/^[0-9a-f]+\.\.[0-9a-f]+$/i.test(pathText)) {
			return true;
		}

		return this.ignored.test(pathText);
	}

	private isExplicitPath(pathText: string): boolean {
		// unix-ish + file:// + windows drive + UNC
		return /^(?:file:\/\/\/|~\/|\.{1,2}\/|\/|\\\\|[a-zA-Z]:[\\/])/.test(
			pathText,
		);
	}

	private hasDotBasename(pathText: string): boolean {
		const base = pathText.split(/[\\/]/).pop() ?? "";
		if (!base.includes(".")) {
			return false;
		}
		const i = base.lastIndexOf(".");
		if (i === -1 || i === base.length - 1) {
			return false;
		}
		// Avoid treating "foo." as a file; require at least one letter in the suffix.
		return /[a-zA-Z]/.test(base.slice(i + 1));
	}

	/**
	 * Strip trailing punctuation from a link that has no suffix.
	 * This handles cases like "See ./path/file." where the period is sentence punctuation,
	 * not part of the path.
	 */
	private stripTrailingPunctuation(
		parsedLink: IParsedLink,
		combinedText: string,
	): IParsedLink {
		const pathText = parsedLink.path.text;
		const linkEnd = parsedLink.path.index + pathText.length;

		// Check if the path ends with common sentence punctuation
		// Only strip if followed by whitespace or end of line (to avoid stripping valid extensions)
		const trailingPunctMatch = pathText.match(/([.,;:!?)]+)$/);
		if (trailingPunctMatch) {
			const punct = trailingPunctMatch[1];
			const afterPunct = combinedText[linkEnd];

			// Only strip if followed by whitespace, end of string, or another punctuation
			if (
				afterPunct === undefined ||
				/\s/.test(afterPunct) ||
				afterPunct === '"' ||
				afterPunct === "'"
			) {
				// Don't strip if it looks like a file extension (e.g., "file.ts")
				// A period followed by 1-4 alphanumeric characters at the end is likely an extension
				if (punct === "." && /\.[a-zA-Z0-9]{1,4}$/.test(pathText)) {
					return parsedLink;
				}

				return {
					...parsedLink,
					path: {
						index: parsedLink.path.index,
						text: pathText.slice(0, -punct.length),
					},
				};
			}
		}

		return parsedLink;
	}

	private isUrl(
		pathText: string,
		linkStart: number,
		combinedText: string,
	): boolean {
		if (
			pathText.startsWith("http://") ||
			pathText.startsWith("https://") ||
			pathText.startsWith("ftp://")
		) {
			return true;
		}

		// Check if this is part of a URL (e.g., the path portion after ://).
		// Unix-mode detectLinks captures "//host/path" from "http://host/path"
		// starting at the FIRST slash, so the context window must reach one char
		// past linkStart to contain both slashes of "://" — substring's exclusive
		// end at linkStart + 1 only reached "https:/" and never matched.
		if (linkStart >= 1) {
			const contextStart = Math.max(0, linkStart - 10);
			const context = combinedText.substring(contextStart, linkStart + 2);
			if (/https?:\/\//.test(context) || /ftp:\/\//.test(context)) {
				return true;
			}
		}

		return false;
	}

	private isVersionString(pathText: string): boolean {
		// Match version strings like 1.2.3, v1.2.3, 1.2.3.4
		return /^v?\d+\.\d+(\.\d+)*$/.test(pathText);
	}

	private isNpmPackageReference(
		pathText: string,
		linkStart: number,
		combinedText: string,
	): boolean {
		// Skip npm package references like @scope/package@1.2.3: the @version
		// must be part of the detected text or attached directly to its end. A
		// wide lookbehind window suppressed legitimate paths that merely sat
		// near a version string (e.g. `lodash@4.17.21 needs ./src/patch.ts`).
		if (/@\d+\.\d+/.test(pathText)) {
			return true;
		}
		return /^@\d+\.\d+/.test(combinedText.slice(linkStart + pathText.length));
	}

	private handleActivation(event: MouseEvent, parsedLink: IParsedLink): void {
		if (!event.metaKey && !event.ctrlKey) {
			return;
		}

		event.preventDefault();

		const pathText = parsedLink.path.text;

		// Clean up the path - remove any remaining suffix patterns that might have been
		// included (defensive, since detectLinks should handle this)
		let cleanPath = removeLinkSuffix(pathText);

		if (!cleanPath) {
			return;
		}

		// Decode URL-encoded characters (e.g., %3A -> :, %20 -> space)
		cleanPath = decodeUrlEncodedPath(cleanPath);

		// Extract line/column info from suffix, or try to parse from URL-encoded path
		let line = parsedLink.suffix?.row;
		let column = parsedLink.suffix?.col;
		const lineEnd = parsedLink.suffix?.rowEnd;
		const columnEnd = parsedLink.suffix?.colEnd;

		// If no suffix was detected, check if the decoded path contains line:col info
		if (line === undefined) {
			const lineColMatch = cleanPath.match(/:(\d+)(?::(\d+))?$/);
			if (lineColMatch) {
				cleanPath = cleanPath.replace(/:(\d+)(?::(\d+))?$/, "");
				line = Number.parseInt(lineColMatch[1], 10);
				if (lineColMatch[2]) {
					column = Number.parseInt(lineColMatch[2], 10);
				}
			}
		}

		this.onOpen(event, cleanPath, line, column, lineEnd, columnEnd);
	}

	private handleFallbackActivation(
		event: MouseEvent,
		fallback: IFallbackLink,
	): void {
		if (!event.metaKey && !event.ctrlKey) {
			return;
		}

		event.preventDefault();

		const cleanPath = decodeUrlEncodedPath(fallback.path);

		if (!cleanPath) {
			return;
		}

		this.onOpen(event, cleanPath, fallback.line, fallback.col);
	}
}
