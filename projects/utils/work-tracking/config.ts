import { readFileSync } from 'node:fs'

export interface IssueFieldConfig {
  id: string
  options: Record<string, string>
}

export interface StatusFieldConfig {
  id: string
  options: {
    Todo: string
    'In Progress': string
    Done: string
  }
}

export interface WorkTrackingConfig {
  schemaVersion: 1
  lastVerified: string
  org: string
  repo: string
  project: {
    owner: string
    title: string
    number: number
    id: string
    statusField: StatusFieldConfig
  }
  issueFields: {
    Component: IssueFieldConfig
    Priority: IssueFieldConfig
    Effort: IssueFieldConfig
  }
  components: Record<string, number>
}

const CONFIG_URL = new URL('./config.json', import.meta.url)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => isString(entry))

const isIssueField = (value: unknown): value is IssueFieldConfig => isRecord(value) && isString(value.id) && isStringMap(value.options)

const isStatusField = (value: unknown): value is StatusFieldConfig =>
  isRecord(value) &&
  isString(value.id) &&
  isRecord(value.options) &&
  isString(value.options.Todo) &&
  isString(value.options['In Progress']) &&
  isString(value.options.Done)

const isComponentMap = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((entry) => isNumber(entry))

const isConfig = (value: unknown): value is WorkTrackingConfig => {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== 1) return false
  if (!isString(value.lastVerified) || !isString(value.org) || !isString(value.repo)) return false
  if (!isRecord(value.project)) return false
  if (
    !isString(value.project.owner) ||
    !isString(value.project.title) ||
    !isNumber(value.project.number) ||
    !isString(value.project.id) ||
    !isStatusField(value.project.statusField)
  ) {
    return false
  }
  if (!isRecord(value.issueFields)) return false
  if (!isIssueField(value.issueFields.Component) || !isIssueField(value.issueFields.Priority) || !isIssueField(value.issueFields.Effort)) {
    return false
  }
  return isComponentMap(value.components)
}

export const loadWorkTracking = (): WorkTrackingConfig => {
  let raw: string
  try {
    raw = readFileSync(CONFIG_URL, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${CONFIG_URL.pathname}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`cannot parse ${CONFIG_URL.pathname}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isConfig(parsed)) throw new Error(`${CONFIG_URL.pathname} does not match the work-tracking schema`)
  return parsed
}
