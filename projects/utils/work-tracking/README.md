# Work tracking

This folder holds the reference config and the scripts that create, check, and summarize work-tracking issues. The scripts run with Node 24 type stripping and stay out of the packed `@kasakame/utils` package.

## Files

- `config.json` - stable organization, repository, project, issue-field, status-field, option, and component issue IDs.
- `config.ts` - loads and validates the config.
- `gh.ts` - shared GitHub CLI helpers.
- `create-issue.ts` - creates a ticket or epic, derives `Component`, sets `Priority` and `Effort`, adds the issue to the project, and verifies the result.
- `check-issue.ts` - the check-issue job script; fills a missing or mismatched `Component` and keeps `needs-triage` aligned with `Priority` and `Effort`.
- `show-work-tracking.ts` - validates the config against the live project and prints the component-to-epic tree.
- `epic-automation.ts` - the epic-automation job script; updates the parent epic `Status`.

## Commands

Run these from the repository root:

```bash
node projects/utils/work-tracking/create-issue.ts --help
node projects/utils/work-tracking/check-issue.ts --help
node projects/utils/work-tracking/show-work-tracking.ts
node projects/utils/work-tracking/epic-automation.ts --help
```

The config is the source for field IDs and component issue numbers. Run `show-work-tracking.ts` after a field, option, project, or component change, and update `lastVerified`.

## Automation token

The `work-tracking` workflow's epic job needs a repository secret `PROJECT_TOKEN`, a fine-grained personal access token with:

- Resource owner: `kasakame`
- Repository access: `kasakame/kasakame`
- Repository permissions: Issues read
- Organization permissions: Projects read and write

`GITHUB_TOKEN` handles issue reopen. `PROJECT_TOKEN` handles project reads and `Status` mutations.

The project's built-in `Auto-close issue` workflow closes an issue when its `Status` becomes `Done`, and `Item closed` sets `Status` to `Done` when an issue closes. Keep both enabled: the workflow script sets the epic `Status`, and these workflows close or reopen the loop.

See [`docs/work-tracking.md`](../../../docs/work-tracking.md) for the full workflow.
