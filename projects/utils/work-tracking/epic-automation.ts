#!/usr/bin/env node
import process from 'node:process'
import { loadWorkTracking } from './config.ts'
import { errorMessage, fail, graphql, runGh } from './gh.ts'

interface IssueType {
  name: string | null
}

interface ChildIssue {
  number: number
  state: string
  issueType: IssueType | null
  parent: { number: number; title: string; issueType: IssueType | null } | null
}

interface ChildData {
  repository: { issue: ChildIssue | null }
}

interface ProjectFieldValue {
  name?: string
  field?: { name: string }
}

interface ProjectItem {
  id: string
  project: { id: string }
  fieldValues?: { nodes: ProjectFieldValue[] }
}

interface EpicIssue {
  number: number
  state: string
  title: string
  subIssues: { nodes: Array<{ number: number; state: string }> }
  projectItems: { nodes: ProjectItem[] }
}

interface EpicData {
  repository: { issue: EpicIssue | null }
}

type StatusName = 'In Progress' | 'Done'

const usage = `Usage:
  ISSUE_NUMBER=<number> GH_TOKEN=<token> PROJECT_TOKEN=<token> node projects/utils/work-tracking/epic-automation.ts

Updates the parent epic Status from a child issue event. PROJECT_TOKEN needs
Organization Projects read and write plus Issues read.`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

const issueNumber = Number(process.env.ISSUE_NUMBER)
if (!Number.isInteger(issueNumber)) fail('ISSUE_NUMBER must be an integer')
const projectToken = process.env.PROJECT_TOKEN
if (!projectToken) fail('PROJECT_TOKEN is required for project updates')
const issueToken = process.env.GH_TOKEN
const config = loadWorkTracking()
const [owner, name] = config.repo.split('/')
if (!owner || !name) fail(`repo must be OWNER/REPO, got ${config.repo}`)
if (owner !== config.org) fail(`repo owner ${owner} does not match org ${config.org}`)

let child: ChildIssue
try {
  const data = graphql(
    `query {
  repository(owner: "${owner}", name: "${name}") {
    issue(number: ${String(issueNumber)}) {
      number
      state
      issueType { name }
      parent { number title issueType { name } }
    }
  }
}`,
    issueToken,
  ) as ChildData
  const fetched = data.repository.issue
  if (!fetched) fail(`issue #${String(issueNumber)} was not found`)
  child = fetched
} catch (error) {
  fail(errorMessage(error))
}

if (child.issueType?.name !== 'Task' && child.issueType?.name !== 'Bug' && child.issueType?.name !== 'Feature') {
  console.log(`#${String(issueNumber)}: no ticket parent, nothing to do`)
  process.exit(0)
}
if (child.parent?.issueType?.name !== 'Epic') {
  console.log(`#${String(issueNumber)}: no parent epic, nothing to do`)
  process.exit(0)
}

let epic: EpicIssue
try {
  const data = graphql(
    `query {
  repository(owner: "${owner}", name: "${name}") {
    issue(number: ${String(child.parent.number)}) {
      number
      state
      title
      subIssues(first: 100) { nodes { number state } }
      projectItems(first: 10) {
        nodes {
          id
          project { id }
          fieldValues(first: 10) {
            nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } }
          }
        }
      }
    }
  }
}`,
    projectToken,
  ) as EpicData
  const fetched = data.repository.issue
  if (!fetched) fail(`epic #${String(child.parent.number)} was not found`)
  epic = fetched
} catch (error) {
  fail(errorMessage(error))
}

const projectItem = epic.projectItems.nodes.find((item) => item.project.id === config.project.id)
if (!projectItem) fail(`epic #${String(epic.number)} is not in project ${config.project.title}`)

const openChildren = epic.subIssues.nodes.filter((node) => node.state === 'OPEN').length
const hasOpenWork = child.state === 'OPEN' || openChildren > 0
const targetStatus: StatusName = hasOpenWork ? 'In Progress' : 'Done'
const statusValue = projectItem.fieldValues?.nodes.find((value) => value.field?.name === 'Status')?.name ?? null
const statusOptionId = config.project.statusField.options[targetStatus]

if (hasOpenWork && epic.state === 'CLOSED') {
  try {
    runGh(['issue', 'reopen', String(epic.number), '--repo', config.repo], issueToken)
    epic.state = 'OPEN'
    console.log(`#${String(epic.number)}: reopened for #${String(issueNumber)}`)
  } catch (error) {
    fail(errorMessage(error))
  }
}

if (statusValue !== targetStatus) {
  try {
    graphql(
      `mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "${config.project.id}"
    itemId: "${projectItem.id}"
    fieldId: "${config.project.statusField.id}"
    value: { singleSelectOptionId: "${statusOptionId}" }
  }) { projectV2Item { id } }
}`,
      projectToken,
    )
    console.log(`#${String(epic.number)}: Status ${targetStatus}`)
  } catch (error) {
    fail(errorMessage(error))
  }
} else {
  console.log(`#${String(epic.number)}: Status already ${targetStatus}`)
}
