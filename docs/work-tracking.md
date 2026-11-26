# Work tracking

KasaKame tracks work in the [KasaKame project](https://github.com/orgs/kasakame/projects/1). The project is owned by the `kasakame` organization, is public, and is linked to the `kasakame/kasakame` repository. Issues hold the work; the project holds the views and the workflow status.

The project README is the source of truth for the hierarchy, field definitions, views, and read recipes. Read it with:

```bash
gh project view 1 --owner kasakame --format json --jq .readme
```

The read recipes cover components, epics, field filters, missing metadata, text search, and combined GraphQL reads. This page covers the creation workflow, automation, verification, and maintenance.

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

The `check-issue` workflow fills a missing or mismatched `Component` from the parent and adds `needs-triage` when the type, parent, `Component`, `Priority`, or `Effort` is missing. The **Needs triage** view lists those issues.

## Automation

The `check-issue` workflow runs when an issue is opened, edited, retyped, or has a field changed. It runs `projects/utils/scripts/check-issue.ts`, which fills `Component` from the parent chain and keeps the `needs-triage` label in sync. It skips closed issues and `Component` issues.

Run it manually for one issue with:

```bash
gh workflow run check-issue.yml -f issue_number=<number>
```

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
