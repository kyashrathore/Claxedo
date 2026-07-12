import type { IBufferLine, ILink, ILinkProvider } from "@xterm/xterm";

export type LinkProviderLine = Pick<IBufferLine, "translateToString" | "isWrapped">;

export interface LinkProviderTerminal {
	buffer: {
		active: {
			getLine: (index: number) => LinkProviderLine | null | undefined;
		};
	};
}

export interface LinkMatch {
	text: string;
	index: number;
	end: number;
	combinedText: string;
	regexMatch: RegExpMatchArray;
}

/**
 * Stitched view of a buffer line together with its wrapped neighbours, used by
 * every link provider so the "combine prev+current+next wrapped line and locate
 * the current line's slice" math has a single implementation.
 */
export interface WrappedLineContext {
	lineText: string;
	lineLength: number;
	isCurrentLineWrapped: boolean;
	prevLineText: string;
	prevLineLength: number;
	nextLineText: string;
	nextLineIsWrapped: boolean;
	/** prevLineText + lineText + nextLineText (the search window). */
	combinedText: string;
	/** Offset of the current line's first char within combinedText (= prevLineLength). */
	currentLineOffset: number;
}

/**
 * Shared geometry base for terminal link providers whose links can span up to 3
 * wrapped lines (previous + current + next). Owns the line-stitching
 * (`computeLineContext`) and the wrapped-line range math (`calculateLinkRange`)
 * so subclasses never re-implement them. Links spanning 4+ wrapped lines are
 * truncated.
 *
 * Two flavours extend this:
 *  - {@link MultiLineLinkProvider} — regex-driven (UrlLinkProvider), matching a
 *    single `getPattern()` against the combined text.
 *  - FilePathLinkProvider — override-driven, feeding the combined text through
 *    VSCode's structured link detector instead of one regex, then reusing the
 *    same range math here.
 */
export abstract class WrappedLineLinkProvider implements ILinkProvider {
	constructor(protected readonly terminal: LinkProviderTerminal) {}

	abstract provideLinks(
		bufferLineNumber: number,
		callback: (links: ILink[] | undefined) => void,
	): void;

	/**
	 * Stitch the current buffer line with its wrapped previous/next neighbours.
	 * Returns null when the current line is absent (caller should report no links).
	 */
	protected computeLineContext(bufferLineNumber: number): WrappedLineContext | null {
		const lineIndex = bufferLineNumber - 1;
		const line = this.terminal.buffer.active.getLine(lineIndex);
		if (!line) {
			return null;
		}

		const lineText = line.translateToString(true);
		const lineLength = lineText.length;
		const isCurrentLineWrapped = line.isWrapped;

		const prevLine = isCurrentLineWrapped
			? this.terminal.buffer.active.getLine(lineIndex - 1)
			: null;
		const prevLineText = prevLine ? prevLine.translateToString(true) : "";
		const prevLineLength = prevLineText.length;

		const nextLine = this.terminal.buffer.active.getLine(lineIndex + 1);
		const nextLineIsWrapped = nextLine?.isWrapped ?? false;
		const nextLineText =
			nextLineIsWrapped && nextLine ? nextLine.translateToString(true) : "";

		const combinedText = prevLineText + lineText + nextLineText;

		return {
			lineText,
			lineLength,
			isCurrentLineWrapped,
			prevLineText,
			prevLineLength,
			nextLineText,
			nextLineIsWrapped,
			combinedText,
			currentLineOffset: prevLineLength,
		};
	}

	protected calculateLinkRange(
		matchIndex: number,
		matchEnd: number,
		prevLineLength: number,
		lineLength: number,
		bufferLineNumber: number,
		isCurrentLineWrapped: boolean,
		nextLineIsWrapped: boolean,
	): ILink["range"] {
		const currentLineStart = prevLineLength;
		const currentLineEnd = prevLineLength + lineLength;

		const startsInPrevLine =
			isCurrentLineWrapped && matchIndex < currentLineStart;
		const endsInNextLine = nextLineIsWrapped && matchEnd > currentLineEnd;

		let startY: number;
		let startX: number;
		let endY: number;
		let endX: number;

		if (startsInPrevLine) {
			startY = bufferLineNumber - 1;
			startX = matchIndex + 1;
		} else {
			startY = bufferLineNumber;
			startX = matchIndex - currentLineStart + 1;
		}

		if (endsInNextLine) {
			endY = bufferLineNumber + 1;
			endX = matchEnd - currentLineEnd + 1;
		} else if (matchEnd <= currentLineStart) {
			endY = bufferLineNumber - 1;
			endX = matchEnd + 1;
		} else {
			endY = bufferLineNumber;
			endX = matchEnd - currentLineStart + 1;
		}

		return {
			start: { x: startX, y: startY },
			end: { x: endX, y: endY },
		};
	}
}

/**
 * Regex-driven link provider: matches a single {@link getPattern} against the
 * stitched multi-line text. Subclasses supply the pattern, a skip predicate, an
 * optional match transform, and an activation handler.
 */
export abstract class MultiLineLinkProvider extends WrappedLineLinkProvider {
	protected abstract getPattern(): RegExp;
	protected abstract shouldSkipMatch(match: LinkMatch): boolean;
	protected abstract handleActivation(
		event: MouseEvent,
		text: string,
		regexMatch: RegExpMatchArray,
	): void;

	/**
	 * Optional hook to transform a match before creating the link.
	 * Useful for stripping trailing characters. Return null to skip the match.
	 */
	protected transformMatch(match: LinkMatch): LinkMatch | null {
		return match;
	}

	provideLinks(
		bufferLineNumber: number,
		callback: (links: ILink[] | undefined) => void,
	): void {
		const ctx = this.computeLineContext(bufferLineNumber);
		if (!ctx) {
			callback(undefined);
			return;
		}

		const {
			lineLength,
			isCurrentLineWrapped,
			prevLineLength,
			nextLineIsWrapped,
			combinedText,
			currentLineOffset,
		} = ctx;

		const links: ILink[] = [];
		const regex = this.getPattern();

		for (const match of combinedText.matchAll(regex)) {
			const matchText = match[0];
			const matchIndex = match.index ?? 0;
			const matchEnd = matchIndex + matchText.length;

			const currentLineStart = currentLineOffset;
			const currentLineEnd = currentLineOffset + lineLength;

			if (matchEnd <= currentLineStart || matchIndex >= currentLineEnd) {
				continue;
			}

			let linkMatch: LinkMatch | null = {
				text: matchText,
				index: matchIndex,
				end: matchEnd,
				combinedText,
				regexMatch: match,
			};

			if (this.shouldSkipMatch(linkMatch)) {
				continue;
			}

			linkMatch = this.transformMatch(linkMatch);
			if (!linkMatch) {
				continue;
			}

			const range = this.calculateLinkRange(
				linkMatch.index,
				linkMatch.end,
				prevLineLength,
				lineLength,
				bufferLineNumber,
				isCurrentLineWrapped,
				nextLineIsWrapped,
			);

			links.push({
				range,
				text: linkMatch.text,
				activate: (event: MouseEvent, text: string) => {
					this.handleActivation(event, text, match);
				},
			});
		}

		callback(links.length > 0 ? links : undefined);
	}
}
