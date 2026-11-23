import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

type BlockKind = 'line' | 'block' | 'jsdoc' | 'hash' | 'css' | 'html'

interface CommentBlock {
  kind: BlockKind
  line: number
  lines: number
  text: string
  proseViolation: boolean
  violation: boolean
  longLine: number | null
  longLength: number
}

interface FileStats {
  commentLines: number
  files: number
  lines: number
  longLines: number
  multiBlocks: number
  multiLines: number
  violations: number
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const report = args.includes('--report')
const selfTest = args.includes('--self-test')
const scopes = args
  .filter((arg) => !arg.startsWith('--'))
  .map((arg) => arg.replace(/^\.\//, '').replace(/\/$/, ''))
  .map((arg) => arg.split(path.sep).join('/'))

const SKIP_EXT = /\.(?:md|markdown|txt|map|lock|png|jpe?g|gif|ico|webp|svg|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp4|mov)$/i
const SKIP_NAME = /(?:^|\/)(?:LICENSE|COPYING|robots\.txt)$/i
const GENERATED = /(?:^|\/)(?:node_modules|dist|artifacts|generated|coverage|\.git)\//
const SLASH = /\.(?:[cm]?[jt]sx?|jsonc)$/i
const HASH = /\.(?:ya?ml|toml|py|sh|bash)$/i
const HASH_NAME = /(?:^|\/)(?:\.gitignore|\.gitattributes|\.env(?:\..*)?|\.npmrc|\.editorconfig)$/i
const TEMPLATE = /\.template$/i
const LINE_DIRECTIVE = /^\/\/\s*(?:eslint|prettier|@ts-|#\s*sourceMappingURL|comment-lint-ignore)/i
const HASH_DIRECTIVE = /^#\s*(?:shellcheck|actionlint|yaml-language-server|renovate:|prettier-ignore|comment-lint-ignore|noqa)/i
const HASH_CONFIG = /^#\s*[A-Z][A-Z0-9_]*\s*=/
const MAX_COMMENT_LENGTH = 200

function isSlash(file: string): boolean {
  return SLASH.test(file)
}

function isHash(file: string): boolean {
  return HASH.test(file) || HASH_NAME.test(file) || TEMPLATE.test(file)
}

function isInScope(file: string): boolean {
  if (!scopes.length) return true
  return scopes.some((scope) => file === scope || file.startsWith(`${scope}/`))
}

function isTrackedSource(file: string): boolean {
  return (
    !SKIP_EXT.test(file) &&
    !SKIP_NAME.test(file) &&
    !GENERATED.test(file) &&
    isInScope(file) &&
    (isSlash(file) || isHash(file) || /\.(?:css|html)$/i.test(file))
  )
}

function jsdocDescriptionLines(raw: string[]): number {
  const body = raw
    .join('\n')
    .replace(/^\s*\/\*\*/, '')
    .replace(/\*\/\s*$/, '')
  const lines = body
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
    .filter((line) => line.length > 0)
  const firstTag = lines.findIndex((line) => /^@\w/.test(line))
  return firstTag === -1 ? lines.length : firstTag
}

function widestLine(raw: string[], startLine: number): { line: number | null; length: number } {
  let line: number | null = null
  let length = 0
  for (let index = 0; index < raw.length; index += 1) {
    const size = (raw[index] ?? '').length
    if (size > length && size > MAX_COMMENT_LENGTH) {
      line = startLine + index
      length = size
    }
  }
  return { line, length }
}

function scanSlash(source: string): CommentBlock[] {
  const lines = source.split('\n')
  const blocks: CommentBlock[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//')) {
      const start = index
      const parts: string[] = []
      const rawParts: string[] = []
      while (index < lines.length) {
        const full = lines[index] ?? ''
        const next = full.trimStart()
        if (!next.startsWith('//')) break
        parts.push(next)
        rawParts.push(full)
        index += 1
      }
      const prose = parts.filter((part) => !LINE_DIRECTIVE.test(part))
      const proseViolation = prose.length > 1
      const widest = widestLine(rawParts, start + 1)
      blocks.push({
        kind: 'line',
        line: start + 1,
        lines: parts.length,
        text: parts[0] ?? '',
        proseViolation,
        violation: proseViolation || widest.line !== null,
        longLine: widest.line,
        longLength: widest.length,
      })
      continue
    }
    if (trimmed.startsWith('/*')) {
      const start = index
      const isJsdoc = trimmed.startsWith('/**')
      const raw: string[] = [line]
      const rest = trimmed.slice(2)
      index += 1
      if (!rest.includes('*/')) {
        while (index < lines.length) {
          const current = lines[index] ?? ''
          raw.push(current)
          index += 1
          if (current.includes('*/')) break
        }
      }
      const isSingleLine = raw.length === 1
      const proseViolation = isJsdoc ? jsdocDescriptionLines(raw) > 1 : !isSingleLine
      const widest = widestLine(raw, start + 1)
      blocks.push({
        kind: isJsdoc ? 'jsdoc' : 'block',
        line: start + 1,
        lines: raw.length,
        text: raw[0]?.trimStart() ?? '',
        proseViolation,
        violation: proseViolation || widest.line !== null,
        longLine: widest.line,
        longLength: widest.length,
      })
      continue
    }
    index += 1
  }
  return blocks
}

function scanHash(source: string): CommentBlock[] {
  const lines = source.split('\n')
  const blocks: CommentBlock[] = []
  let index = 0
  while (index < lines.length) {
    const trimmed = (lines[index] ?? '').trimStart()
    if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
      const start = index
      const parts: string[] = []
      const rawParts: string[] = []
      while (index < lines.length) {
        const full = lines[index] ?? ''
        const next = full.trimStart()
        if (!next.startsWith('#') || next.startsWith('#!')) break
        parts.push(next)
        rawParts.push(full)
        index += 1
      }
      const prose = parts.filter((part) => !HASH_DIRECTIVE.test(part) && !HASH_CONFIG.test(part))
      const proseViolation = prose.length > 1
      const widest = widestLine(rawParts, start + 1)
      blocks.push({
        kind: 'hash',
        line: start + 1,
        lines: parts.length,
        text: parts[0] ?? '',
        proseViolation,
        violation: proseViolation || widest.line !== null,
        longLine: widest.line,
        longLength: widest.length,
      })
      continue
    }
    index += 1
  }
  return blocks
}

function scanDelimited(source: string, pattern: RegExp, kind: BlockKind): CommentBlock[] {
  const blocks: CommentBlock[] = []
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    const text = match[0]
    const line = source.slice(0, start).split('\n').length
    const raw = text.split('\n')
    const lines = raw.length
    const proseViolation = lines > 1
    const widest = widestLine(raw, line)
    blocks.push({
      kind,
      line,
      lines,
      text,
      proseViolation,
      violation: proseViolation || widest.line !== null,
      longLine: widest.line,
      longLength: widest.length,
    })
  }
  return blocks
}

function scanSource(file: string, source: string): CommentBlock[] {
  if (isSlash(file)) return scanSlash(source)
  if (isHash(file)) return scanHash(source)
  if (/\.css$/i.test(file)) return scanDelimited(source, /\/\*[\s\S]*?\*\//g, 'css')
  if (/\.html$/i.test(file)) return scanDelimited(source, /<!--[\s\S]*?-->/g, 'html')
  return []
}

function areaOf(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'projects' && parts.length > 2) return `projects/${parts[1] ?? ''}`
  return parts[0] ?? file
}

function formatTable(rows: Map<string, FileStats>): void {
  const header = ['area', 'files', 'lines', 'comment', 'share', 'blocks>1', 'lines', 'long', 'violations']
  const table = [...rows.entries()]
    .sort((a, b) => b[1].lines - a[1].lines)
    .map(([area, stats]) => [
      area,
      String(stats.files),
      String(stats.lines),
      String(stats.commentLines),
      `${((100 * stats.commentLines) / Math.max(stats.lines, 1)).toFixed(1)}%`,
      String(stats.multiBlocks),
      String(stats.multiLines),
      String(stats.longLines),
      String(stats.violations),
    ])
  const widths = header.map((cell, column) => Math.max(cell.length, ...table.map((row) => (row[column] ?? '').length)))
  const print = (row: string[]): void => {
    console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  '))
  }
  print(header)
  for (const row of table) print(row)
}

function selfTestRun(): void {
  const cases: Array<[string, string, number]> = [
    ['x.ts', '// one\n// two\nexport const a = 1\n', 1],
    ['x.ts', '// one line\nexport const a = 1\n', 0],
    ['x.ts', '/**\n * one\n * two\n */\nexport const a = 1\n', 1],
    ['x.ts', '/**\n * one\n *\n * @param a thing\n * @returns value\n */\nexport function f(a: number): number {\n  return a\n}\n', 0],
    ['x.ts', '/*\n * one\n * two\n */\nexport const a = 1\n', 1],
    ['x.ts', '/* one */\nexport const a = 1\n', 0],
    ['x.yaml', '# one\n# two\nkey: value\n', 1],
    ['x.yaml', '# one\nkey: value\n', 0],
    ['x.template', '# optional accounts:\n# A_MNEMONIC=\n# B_MNEMONIC=\n', 0],
    ['x.css', '/*\n one\n two\n */\n', 1],
    ['x.html', '<!--\n one\n two\n -->\n', 1],
    ['x.ts', `// ${'a'.repeat(197)}\nexport const a = 1\n`, 0],
    ['x.ts', `// ${'a'.repeat(198)}\nexport const a = 1\n`, 1],
    ['x.ts', `/**\n * one\n *\n * @param a ${'a'.repeat(190)}\n */\nexport function f(a: number): number {\n  return a\n}\n`, 1],
  ]
  for (const [file, source, expected] of cases) {
    const actual = scanSource(file, source).filter((block) => block.violation).length
    assert.equal(actual, expected, `${file}: ${JSON.stringify(source)}`)
  }
  console.log('self-test ok')
}

function main(): void {
  if (selfTest) {
    selfTestRun()
    return
  }
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).filter(isTrackedSource)
  const stats = new Map<string, FileStats>()
  const violations: Array<{ file: string; block: CommentBlock }> = []
  for (const file of files) {
    const full = path.join(root, file)
    const source = fs.readFileSync(full, 'utf8')
    const blocks = scanSource(file, source)
    const area = areaOf(file)
    const entry = stats.get(area) ?? {
      commentLines: 0,
      files: 0,
      lines: 0,
      longLines: 0,
      multiBlocks: 0,
      multiLines: 0,
      violations: 0,
    }
    entry.files += 1
    entry.lines += source.split('\n').length
    for (const block of blocks) {
      entry.commentLines += block.lines
      if (block.lines > 1) {
        entry.multiBlocks += 1
        entry.multiLines += block.lines
      }
      if (block.longLine !== null) entry.longLines += 1
      if (block.violation) {
        entry.violations += 1
        violations.push({ file, block })
      }
    }
    stats.set(area, entry)
  }
  if (report) {
    formatTable(stats)
    return
  }
  if (violations.length === 0) {
    console.log(`comment-lint: ${String(files.length)} files clean`)
    return
  }
  for (const { file, block } of violations) {
    const reasons: string[] = []
    if (block.proseViolation) reasons.push(`${String(block.lines)} lines`)
    if (block.longLine !== null) reasons.push(`${String(block.longLength)} chars`)
    const text = block.text.length > 100 ? `${block.text.slice(0, 97)}...` : block.text
    console.log(`${file}:${String(block.longLine ?? block.line)}  ${reasons.join(', ')}  ${text}`)
  }
  console.error(
    `\ncomment-lint: ${String(violations.length)} comment violations; keep prose to one line and ${String(MAX_COMMENT_LENGTH)} characters`,
  )
  process.exitCode = 1
}

main()
