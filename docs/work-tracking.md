# Work tracking

KasaKame tracks work in the [KasaKame project](https://github.com/orgs/kasakame/projects/1). The project is owned by the `kasakame` organization, is public, and is linked to the `kasakame/kasakame` repository. Issues hold the work; the project holds the views and the workflow status.

## Hierarchy

Work follows three levels:

- **Component** - a stable product area. The nine components are `contracts`, `frontend`, `sdk`, `cli`, `backend`, `ci`, `infra`, `docs`, and `maintenance`.
- **Epic** - a workstream inside one component. An epic can stay open indefinitely; close it when the work is finished for good or a follow-up epic exists.
- **Ticket** - a `Task`, `Bug`, or `Feature`. Every ticket belongs to an epic, and every epic belongs to a component.

Components describe work areas; folders describe code layout. The `utils` and `constants` packages are shared support code; their changes belong to the component that consumes them or to `maintenance`. Add a component when a new area needs its own long-running workstream.

## Fields

Issue fields hold the shared metadata. They live on the issue, so they appear in the issue sidebar, work across every project, and support `field.<name>` search. The project uses one custom field, `Status`, for workflow state.

The organization defines these issue fields:

| Field | Values | Purpose |
| --- | --- | --- |
| `Component` | One of the nine components | The area that owns the work |
| `Priority` | `Urgent`, `High`, `Medium`, `Low` | Current importance |
| `Effort` | `High`, `Medium`, `Low` | Relative size of the work |
| `Start date` and `Target date` | Dates | Optional planning dates |

### Component

`Component` names the area that owns the issue. For an epic, it matches the parent component. For a ticket, it matches the parent epic's component. The creation script derives the value from the parent, so the field and the hierarchy always agree.

A ticket can touch several areas. The component still belongs to the owning epic; use the issue body or labels to name the other areas.

### Priority

`Priority` follows the current release:

- `Urgent` blocks the release, funds, or security.
- `High` is current-milestone work.
- `Medium` is planned work outside the current milestone.
- `Low` is cleanup or later.

The old project values map directly: `P1` to `Urgent`, `P2` to `High`, and `P3` to `Low`.

### Effort

`Effort` measures the work in the issue, not its importance:

- `High` covers multi-day work, cross-package changes, and contract or security-sensitive changes.
- `Medium` covers a focused pull request or about a day of work.
- `Low` covers a small fix, documentation, configuration, or a dependency bump.

### Status

`Status` is the project workflow field:

- `Todo` means the work has not started.
- `In Progress` means someone is working on it.
- `Done` means the acceptance criteria are met and the pull request is merged.

An epic is `Done` when all its sub-issues are `Done`.

## Creating an issue

Create an issue only for a change that needs a pull request. Project metadata edits, such as views, fields, and descriptions, happen directly in the project.

### Script

Use the script from the repository root for every new ticket and epic:

```bash
node projects/utils/scripts/create-issue.ts \
  --type Task \
  --parent 52 \
  --priority High \
  --effort Medium \
  --title "Add the thing" \
  --body-file /tmp/body.md
```

For an epic, pass the component as the parent:

```bash
node projects/utils/scripts/create-issue.ts \
  --type Epic \
  --parent 39 \
  --priority High \
  --effort High \
  --title "New workstream" \
  --body-file /tmp/epic.md
```

The script validates the parent type, derives `Component`, sets `Priority` and `Effort`, adds the issue to the project, and verifies the result. It prints the issue URL and a summary line.

### Web UI

Use the Task, Bug, Feature, or Epic form. The form sets the issue type. After the form opens, set `Component`, `Priority`, and `Effort` in the sidebar, then create the issue. Set the parent from the issue's **Sub-issue** menu: an epic goes under a component, and a ticket goes under an epic.

The hygiene workflow adds the `needs-triage` label when `Priority` or `Effort` is missing. The **Needs triage** view lists those issues.

## Views

The project has five views:

| View | Layout | Purpose |
| --- | --- | --- |
| Components | Table | Index of the nine product areas |
| Epics | Table | Workstreams and their progress, grouped by component |
| Board | Board | Open tickets grouped by status |
| Tickets | Table | Open tickets with component, priority, effort, and milestone |
| Needs triage | Table | Issues missing priority or effort |

Add a Roadmap view when active epics have target dates.

## Verification

The creation script verifies each new issue. For an existing issue, check the parent and type with the CLI and check the fields in the issue sidebar:

```bash
gh issue view <number> --repo kasakame/kasakame --json issueType,parent,projectItems
```

The issue must have a type, a parent of the right type, a matching `Component`, a `Priority`, and an `Effort`.

## Maintenance

Keep the hierarchy and the fields aligned:

- Create an epic when a ticket grows into several independent deliverables, then move the remaining scope into child tickets.
- Re-parent tickets when their owning epic changes, and update `Component` to match the new parent.
- Close an epic when all its children are done and no follow-up epic exists.
- Keep the linked issue's fields current before opening a pull request.
- Update this page and the project README together when the workflow changes.
