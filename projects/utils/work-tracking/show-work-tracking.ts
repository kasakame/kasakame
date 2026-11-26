#!/usr/bin/env node
import process from 'node:process'
import { loadWorkTracking } from './config.ts'
import { fail, graphql, runGh } from './gh.ts'

interface FieldOption {
  id: string
  name: string
}

interface FieldNode {
  __typename: string
  name: string
  id?: string
  options?: FieldOption[]
}

interface ConfigData {
  organization: {
    projectV2: { id: string; fields: { nodes: FieldNode[] } }
    issueFields: { nodes: FieldNode[] }
  }
}

interface ComponentIssue {
  number: number
  title: string
}

interface EpicIssue {
  number: number
  title: string
  parent: { number: number; title: string }
  subIssuesSummary: { total: number; completed: number }
}

const usage = `Usage:
  node projects/utils/work-tracking/show-work-tracking.ts

Validates projects/utils/work-tracking/config.json against the live project and prints
the component-to-epic tree. Requires a gh token with project read access.`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage)
  process.exit(0)
}

const config = loadWorkTracking()
const errors: string[] = []

const data = graphql(`
query {
  organization(login: "${config.org}") {
    projectV2(number: ${String(config.project.number)}) {
      id
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { name }
          ... on ProjectV2Field { id }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }
    issueFields(first: 50) {
      nodes {
        ... on IssueFieldCommon { name }
        ... on IssueFieldSingleSelect { id options { id name } }
      }
    }
  }
}`) as ConfigData
const project = data.organization.projectV2
const issueFields = data.organization.issueFields.nodes

if (project.id !== config.project.id) errors.push(`project id is ${project.id}, config has ${config.project.id}`)

const status = project.fields.nodes.find((field) => field.name === 'Status')
if (!status?.id || !status.options) {
  errors.push('project Status field is missing or is not a single-select field')
} else {
  if (status.id !== config.project.statusField.id) {
    errors.push(`Status field id is ${status.id}, config has ${config.project.statusField.id}`)
  }
  const liveOptions = Object.fromEntries(status.options.map((option) => [option.name, option.id]))
  for (const [name, id] of Object.entries(config.project.statusField.options)) {
    if (liveOptions[name] !== id) errors.push(`Status option ${name} is ${liveOptions[name] ?? 'missing'}, config has ${id}`)
  }
}

for (const [name, expected] of Object.entries(config.issueFields)) {
  const field = issueFields.find((candidate) => candidate.name === name)
  if (!field?.id || !field.options) {
    errors.push(`issue field ${name} is missing or is not a single-select field`)
    continue
  }
  if (field.id !== expected.id) errors.push(`${name} field id is ${field.id}, config has ${expected.id}`)
  const liveOptions = Object.fromEntries(field.options.map((option) => [option.name, option.id]))
  for (const [optionName, optionId] of Object.entries(expected.options)) {
    if (liveOptions[optionName] !== optionId) {
      errors.push(`${name} option ${optionName} is ${liveOptions[optionName] ?? 'missing'}, config has ${optionId}`)
    }
  }
}

const components = JSON.parse(
  runGh(['issue', 'list', '--repo', config.repo, '--state', 'open', '--type', 'Component', '--json', 'number,title']),
) as ComponentIssue[]
const componentNames = new Set(Object.keys(config.components))
for (const [name, number] of Object.entries(config.components)) {
  const issue = components.find((candidate) => candidate.number === number)
  if (!issue) errors.push(`component ${name} issue #${String(number)} is missing`)
  else if (issue.title !== name) errors.push(`component #${String(number)} is ${issue.title}, config has ${name}`)
}
for (const issue of components) {
  if (!componentNames.has(issue.title)) errors.push(`component ${issue.title} (#${String(issue.number)}) is not in the config`)
}
if (new Set(Object.values(config.components)).size !== Object.keys(config.components).length) {
  errors.push('component issue numbers are duplicated in the config')
}

const epics = JSON.parse(
  runGh(['issue', 'list', '--repo', config.repo, '--state', 'open', '--type', 'Epic', '--json', 'number,title,parent,subIssuesSummary']),
) as EpicIssue[]
for (const epic of epics) {
  if (!componentNames.has(epic.parent.title)) {
    errors.push(`epic #${String(epic.number)} has parent ${epic.parent.title}, which is not in the config`)
  }
}

const byComponent = new Map<string, EpicIssue[]>()
for (const epic of epics) {
  const list = byComponent.get(epic.parent.title) ?? []
  list.push(epic)
  byComponent.set(epic.parent.title, list)
}

for (const [name, number] of Object.entries(config.components)) {
  console.log(`${name} (#${String(number)})`)
  const list = (byComponent.get(name) ?? []).sort((left, right) => left.number - right.number)
  for (const epic of list) {
    console.log(
      `  #${String(epic.number)} ${epic.title} (${String(epic.subIssuesSummary.completed)}/${String(epic.subIssuesSummary.total)})`,
    )
  }
}

console.log(`config: ${errors.length === 0 ? 'ok' : 'mismatch'} (verified ${config.lastVerified})`)
if (errors.length > 0) fail(errors.join('\n'))
