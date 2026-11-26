#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { loadWorkTracking, type IssueFieldConfig } from './config.ts'

const TYPES = ['Task', 'Bug', 'Feature', 'Epic', 'Component'] as const

type IssueTypeName = (typeof TYPES)[number]

interface IssueType {
  name: string | null
}

interface ParentIssue {
  number: number
  title: string
  issueType: IssueType | null
  parent?: ParentIssue | null
}

interface Issue {
  id: string
  number: number
  title: string
  issueType: IssueType | null
  parent: ParentIssue | null
}

interface IssueQueryData {
  repository: { issue: Issue | null }
}

interface NativeFieldSet {
  component: { field: IssueFieldConfig; option: { name: string; id: string } }
  priority: { field: IssueFieldConfig; option: { name: string; id: string } }
  effort: { field: IssueFieldConfig; option: { name: string; id: string } }
}

interface IssueFieldValue {
  name?: string
  field?: { name: string }
}

interface VerifyIssue {
  number: number
  issueType: IssueType | null
  parent: { number: number } | null
  issueFieldValues: { nodes: IssueFieldValue[] }
  projectItems: { nodes: Array<{ project: { number: number } }> }
}

interface VerifyData {
  repository: { issue: VerifyIssue | null }
}

interface GraphQlEnvelope {
  data?: unknown
  errors?: Array<{ message: string }>
}

const usage = `Usage:
  node projects/utils/work-tracking/create-issue.ts --type Task --parent 52 --priority P2 --effort Medium --title "..." --body-file body.md

Required for Task, Bug, Feature, and Epic:
  --type      Task | Bug | Feature | Epic
  --parent    Epic (for a ticket) or Component (for an Epic)
  --priority  P1 | P2 | P3
  --effort    High | Medium | Low
  --title     Issue title
  --body      Inline body, or --body-file <path>

Component issues take --type Component, --title, and a body only.
Optional: --milestone <name>`

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

const errorStderr = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string') return stderr.trim()
    if (Buffer.isBuffer(stderr)) return stderr.toString().trim()
  }
  return ''
}

const runGh = (args: string[]): string => {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    }).trim()
  } catch (error) {
    const stderr = errorStderr(error)
    const message = error instanceof Error ? error.message : String(error)
    fail(stderr || message)
  }
}

const graphql = (query: string): unknown => {
  const output = runGh(['api', 'graphql', '-f', `query=${query}`])
  const envelope = JSON.parse(output) as GraphQlEnvelope
  if (envelope.errors?.length) fail(envelope.errors.map((error) => error.message).join('; '))
  if (!envelope.data) fail('GitHub returned no data')
  return envelope.data
}

const isIssueType = (value: string): value is IssueTypeName => TYPES.some((type) => type === value)

const parseArgs = (argv: string[]): Record<string, string> => {
  const options: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(usage)
      process.exit(0)
    }
    if (!arg) fail('missing argument')
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`missing value for --${key}`)
    options[key] = value
    index += 1
  }
  return options
}

const issueQuery = (owner: string, repo: string, number: number): string => `
query {
  repository(owner: "${owner}", name: "${repo}") {
    issue(number: ${String(number)}) {
      id
      number
      title
      issueType { name }
      parent { number title issueType { name } parent { number title issueType { name } } }
    }
  }
}`

const options = parseArgs(process.argv.slice(2))
const config = loadWorkTracking()
const [repoOwner, repoName] = config.repo.split('/')
if (!repoOwner || !repoName) fail(`repo must be OWNER/REPO, got ${config.repo}`)
if (repoOwner !== config.org) fail(`repo owner ${repoOwner} does not match org ${config.org}`)
const typeValue = options.type
if (!typeValue || !isIssueType(typeValue)) fail(`--type must be one of: ${TYPES.join(', ')}`)
const type = typeValue
const title = options.title
if (!title) fail('--title is required')
const body = options.body
const bodyFile = options['body-file']
if (!body && !bodyFile) fail('--body or --body-file is required')
const parentNumber = options.parent
const priorityValue = options.priority
const effortValue = options.effort

let component: string | null = null
let expectedParent: number | null = null
let nativeFields: NativeFieldSet | null = null

if (type === 'Component') {
  if (parentNumber || priorityValue || effortValue) fail('Component issues take no parent, priority, or effort')
} else {
  if (!parentNumber) fail('--parent is required for Task, Bug, Feature, and Epic')
  if (!priorityValue) fail('--priority is required')
  if (!effortValue) fail('--effort is required')
  const parentId = Number(parentNumber)
  expectedParent = parentId
  const parent = (graphql(issueQuery(config.org, repoName, parentId)) as IssueQueryData).repository.issue
  if (!parent) fail(`parent issue #${parentNumber} was not found`)

  if (type === 'Epic') {
    if (parent.issueType?.name !== 'Component')
      fail(`an Epic needs a Component parent, but #${String(parent.number)} is ${parent.issueType?.name ?? 'untyped'}`)
    component = parent.title
  } else {
    if (parent.issueType?.name !== 'Epic')
      fail(`a ${type} needs an Epic parent, but #${String(parent.number)} is ${parent.issueType?.name ?? 'untyped'}`)
    const grandparent = parent.parent
    if (grandparent?.issueType?.name !== 'Component') fail(`Epic #${String(parent.number)} has no Component parent`)
    component = grandparent.title
  }

  const componentName = component
  if (!componentName) fail('could not derive Component from the parent')
  const componentId = config.issueFields.Component.options[componentName]
  if (!componentId) fail(`Component "${componentName}" is not in the work-tracking config`)
  const chooseOption = (field: IssueFieldConfig, value: string, label: string): { name: string; id: string } => {
    const name = Object.keys(field.options).find((option) => option.toLowerCase() === value.toLowerCase())
    if (!name) fail(`${label} must be one of: ${Object.keys(field.options).join(', ')}`)
    const id = field.options[name]
    if (!id) fail(`${label} has no id for ${name}`)
    return { name, id }
  }
  const priorityOption = chooseOption(config.issueFields.Priority, priorityValue, '--priority')
  const effortOption = chooseOption(config.issueFields.Effort, effortValue, '--effort')
  nativeFields = {
    component: { field: config.issueFields.Component, option: { name: componentName, id: componentId } },
    priority: { field: config.issueFields.Priority, option: priorityOption },
    effort: { field: config.issueFields.Effort, option: effortOption },
  }
}

const createArgs = ['issue', 'create', '--repo', config.repo, '--type', type, '--project', config.project.title, '--title', title]
if (bodyFile) createArgs.push('--body-file', bodyFile)
else if (body) createArgs.push('--body', body)
if (parentNumber) createArgs.push('--parent', parentNumber)
if (options.milestone) createArgs.push('--milestone', options.milestone)

const created = runGh(createArgs)
const match = created.match(/https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/)
if (!match) fail(`could not read the new issue URL from: ${created}`)
const issueNumber = match[1]
if (!issueNumber) fail(`could not read the new issue number from: ${created}`)
const number = Number(issueNumber)
const url = match[0]

if (nativeFields) {
  const issue = (graphql(issueQuery(config.org, repoName, number)) as IssueQueryData).repository.issue
  if (!issue) fail(`issue #${String(number)} was created but could not be read back`)
  const fieldInputs = [nativeFields.component, nativeFields.priority, nativeFields.effort].map(
    (field) => `{ fieldId: "${field.field.id}", singleSelectOptionId: "${field.option.id}" }`,
  )
  graphql(`
mutation {
  setIssueFieldValue(input: {
    issueId: "${issue.id}"
    issueFields: [${fieldInputs.join(' ')}]
  }) { issue { number } }
}`)
}

const verifyQuery = `
query {
  repository(owner: "${config.org}", name: "${repoName}") {
    issue(number: ${String(number)}) {
      number
      issueType { name }
      parent { number }
      issueFieldValues(first: 10) {
        nodes {
          ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { name } } }
        }
      }
      projectItems(first: 10) { nodes { project { number } } }
    }
  }
}`
let verified: VerifyIssue | null = null
for (let attempt = 0; attempt < 5; attempt += 1) {
  verified = (graphql(verifyQuery) as VerifyData).repository.issue
  if (verified?.projectItems.nodes.some((item) => item.project.number === config.project.number)) break
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
}
if (!verified) fail(`issue #${String(number)} was created but could not be read back`)

const values: Record<string, string> = {}
for (const value of verified.issueFieldValues.nodes) {
  if (value.name && value.field) values[value.field.name] = value.name
}
const errors: string[] = []
if (verified.issueType?.name !== type) errors.push(`type is ${verified.issueType?.name ?? 'untyped'}`)
if (type === 'Component') {
  if (verified.parent) errors.push('component issues must not have a parent')
} else {
  if (verified.parent?.number !== expectedParent) errors.push(`parent is #${String(verified.parent?.number ?? '-')}`)
  if (nativeFields) {
    if (values.Component !== nativeFields.component.option.name) errors.push(`Component is ${values.Component ?? 'missing'}`)
    if (values.Priority !== nativeFields.priority.option.name) errors.push(`Priority is ${values.Priority ?? 'missing'}`)
    if (values.Effort !== nativeFields.effort.option.name) errors.push(`Effort is ${values.Effort ?? 'missing'}`)
  }
}
if (!verified.projectItems.nodes.some((item) => item.project.number === config.project.number))
  errors.push(`project ${String(config.project.number)} item is missing`)
if (errors.length > 0) fail(`${url} was created but verification failed: ${errors.join('; ')}`)

console.log(`Created #${String(number)}: ${url}`)
console.log(
  `type=${type} parent=${parentNumber ?? '-'} component=${component ?? '-'} priority=${nativeFields?.priority.option.name ?? '-'} effort=${nativeFields?.effort.option.name ?? '-'} project=${String(config.project.number)}`,
)
