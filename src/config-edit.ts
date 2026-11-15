import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree, SyntaxKind, type Edit, type ParseError } from "jsonc-parser"

export function editSetting(text: string, index: number, key: string, value: unknown): string {
  const path = ["plugins", index, "options", key]
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (!root || errors.length) throw new Error("Invalid configuration")
  const node = findNodeAtLocation(root, path)
  if (!node) return value === undefined ? text : applyEdits(text, modify(text, path, value, {}))
  const property = node.parent
  if (property?.type !== "property" || property.parent?.type !== "object") throw new Error("Invalid property")
  const edits: Edit[] = []
  const scanner = createScanner(text, false)
  const trivia = (token: SyntaxKind) => token >= SyntaxKind.LineCommentTrivia && token <= SyntaxKind.Trivia
  const editToken = (content = "") => edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content })
  const target = value === undefined ? property : node
  const end = target.offset + target.length
  let content = value === undefined ? "" : JSON.stringify(value)
  if (content === undefined) throw new Error("Invalid setting value")
  let comments = false
  scanner.setPosition(target.offset)
  // Library range edits can erase comments; preserve trivia when deleting or replacing commented values.
  for (let token = scanner.scan(); token !== SyntaxKind.EOF && scanner.getTokenOffset() < end; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) comments = true
    if (!trivia(token)) { editToken(content); content = "" }
  }
  if (value !== undefined) return applyEdits(text, comments ? edits : modify(text, path, value, {}))
  function next(offset: number) {
    scanner.setPosition(offset)
    let token = scanner.scan()
    while (trivia(token)) token = scanner.scan()
    return token
  }
  if (next(end) === SyntaxKind.CommaToken) editToken()
  else {
    const siblings = property.parent.children!
    const previous = siblings[siblings.indexOf(property) - 1]
    if (previous) {
      if (next(previous.offset + previous.length) !== SyntaxKind.CommaToken) throw new Error("Missing separator")
      editToken()
    }
  }
  return applyEdits(text, edits)
}
