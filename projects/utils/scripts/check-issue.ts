#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const DEFAULT_REPO = 'kasakame/kasakame'
const COMPONENT_FIELD_ID = 'IFSS_kgDOAwJCtw'
const COMPONENT_OPTIONS: Record<string, string> = {
  contracts: 'IFSSO_kgDOBUS7Tw',
  frontend: 'IFSSO_kgDOBUS7UA',
  sdk: 'IFSSO_kgDOBUS7UQ',
  cli: 'IFSSO_kgDOBUS7Ug',
  backend: 'IFSSO_kgDOBUS7Uw',
  ci: 'IFSSO_kgDOBUS7VA',
  infra: 'IFSSO_kgDOBUS7VQ',
  docs: 'IFSSO_kgDOBUS7Vg',
  maintenance: 'IFSSO_kgDOBUS7Vw',
}

interface IssueType {
  name: string | null
}

interface ParentIssue {
  number: number
  title: string
  issueType: IssueType | null
  parent?: ParentIssue | null
}

interface IssueFieldValue {
  name?: string
  field?: { name: string }
}

interface Issue {
  id: string
  number: number
  state: string
  issueType: IssueType | null
  parent: ParentIssue | null
  issueFieldValues: { nodes: IssueFieldValue[] }
  labels: { nodes: Array<{ name: string }> }
}

interface IssueData {
  repository: { issue: Issue | null }
}

interface GraphQlEnvelope {
  data?: unknown
  errors?: Array<{ message: string }>
}

const usage = `Usage:
  ISSUE_NUMBER=<number> GH_TOKEN=<token> node projects/utils/scripts/check-issue.ts

Reads GITHUB_REPOSITORY (default ${DEFAULT_REPO}) and ISSUE_NUMBER.
Fills a missing or mismatched Component from the parent and keeps the
needs-triage label aligned with Priority and Effort.`

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function errorStderr(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string') return stderr.trim()
    if (Buffer.isBuffer(stderr)) return stderr.toString().trim()
  }
  return ''
}

function errorMessage(error: unknown): string {
  const stderr = errorStderr(error)
  if (stderr) return stderr
  return error instanceof Error ? error.message : String(error)
}

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    }).trim()
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

function graphql(query: string): unknown {
  const output = runGh(['api', 'graphql', '-f', `query=${query}`])
  const envelope = JSON.parse(output) as GraphQlEnvelope
  if (envelope.errors?.length) throw new Error(envelope.errors.map((error) => error.message).join('; '))
  if (!envelope.data) throw new Error('GitHub returned no data')
  return envelope.data
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage)
  process.exit(0)
}
if (args.length > 0) fail(`unexpected arguments: ${args.join(' ')}`)

const repo = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPO
const [owner, name] = repo.split('/')
if (!owner || !name) fail(`GITHUB_REPOSITORY must be OWNER/REPO, got ${repo}`)
const issueNumber = Number(process.env.ISSUE_NUMBER)
if (!Number.isInteger(issueNumber)) fail('ISSUE_NUMBER must be an integer')

const issueQuery = `
query {
  repository(owner: "${owner}", name: "${name}") {
    issue(number: ${String(issueNumber)}) {
      id
      number
      state
      issueType { name }
      parent {
        number
        title
        issueType { name }
        parent { number title issueType { name } }
      }
      issueFieldValues(first: 10) {
        nodes {
          ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } }
        }
      }
      labels(first: 20) { nodes { name } }
    }
  }
}`

let issue: Issue
try {
  const data = graphql(issueQuery) as IssueData
  const fetched = data.repository.issue
  if (!fetched) fail(`issue #${String(issueNumber)} was not found`)
  issue = fetched
} catch (error) {
  fail(errorMessage(error))
}

const labels = new Set(issue.labels.nodes.map((label) => label.name))
const removeTriage = (): void => {
  if (!labels.has('needs-triage')) return
  try {
    runGh(['issue', 'edit', String(issueNumber), '--repo', repo, '--remove-label', 'needs-triage'])
    labels.delete('needs-triage')
    console.log(`#${String(issueNumber)}: removed needs-triage`)
  } catch (error) {
    fail(errorMessage(error))
  }
}

if (issue.state !== 'OPEN' || issue.issueType?.name === 'Component') {
  removeTriage()
  process.exit(0)
}

const values: Record<string, string> = {}
for (const value of issue.issueFieldValues.nodes) {
  if (value.name && value.field) values[value.field.name] = value.name
}

const type = issue.issueType?.name ?? null
const parent = issue.parent
let expectedComponent: string | null = null
let validParent = false
if (type === 'Epic' && parent?.issueType?.name === 'Component') {
  expectedComponent = parent.title
  validParent = true
} else if (
  ['Task', 'Bug', 'Feature'].includes(type ?? '') &&
  parent?.issueType?.name === 'Epic' &&
  parent.parent?.issueType?.name === 'Component'
) {
  expectedComponent = parent.parent.title
  validParent = true
}

let component = values.Component ?? null
const componentOptionId = expectedComponent ? COMPONENT_OPTIONS[expectedComponent] : undefined
if (validParent && expectedComponent && component !== expectedComponent && componentOptionId) {
  try {
    graphql(`mutation {
  setIssueFieldValue(input: {
    issueId: "${issue.id}"
    issueFields: [{ fieldId: "${COMPONENT_FIELD_ID}", singleSelectOptionId: "${componentOptionId}" }]
  }) { issue { number } }
}`)
    component = expectedComponent
    console.log(`#${String(issueNumber)}: set Component to ${expectedComponent}`)
  } catch (error) {
    console.warn(`#${String(issueNumber)}: could not set Component: ${errorMessage(error)}`)
  }
}

const missing: string[] = []
if (!type || !validParent) missing.push('type or parent')
if (validParent && !component) missing.push('Component')
if (!values.Priority) missing.push('Priority')
if (!values.Effort) missing.push('Effort')

if (missing.length > 0) {
  if (!labels.has('needs-triage')) {
    try {
      runGh(['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', 'needs-triage'])
      labels.add('needs-triage')
    } catch (error) {
      fail(errorMessage(error))
    }
  }
  console.log(`#${String(issueNumber)}: needs triage (${missing.join(', ')})`)
} else {
  removeTriage()
  console.log(`#${String(issueNumber)}: metadata complete`)
}
