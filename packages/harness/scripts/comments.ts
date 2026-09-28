import ts from "typescript-5"

export function sourceComments(source: ts.SourceFile): ts.CommentRange[] {
  const spans: { start: number; end: number }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      spans.push({ start: node.getStart(source), end: node.end })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let masked = source.text
  for (const span of spans.sort((a, b) => b.start - a.start)) {
    masked = masked.slice(0, span.start) + masked.slice(span.start, span.end).replace(/[^\r\n]/g, " ") + masked.slice(span.end)
  }
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, masked)
  const comments: ts.CommentRange[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      comments.push({ kind: token, pos: scanner.getTokenPos(), end: scanner.getTextPos() })
    }
  }
  return comments
}
