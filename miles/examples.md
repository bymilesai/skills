# Miles Workflow Examples

## Clean Install Check

Use an isolated `MILES_HOME` when testing the skill from a separate environment:

```bash
export MILES_HOME=/tmp/miles-skill-smoke
export MILES_CLI=/path/to/miles/scripts/miles
miles doctor --json
miles whoami --json
```

## Solo User - Interactive Design

User says: "Build me a website for my yoga studio"

```bash
miles create-site "Build a website for a yoga studio"
# Miles asks: "What's the name of your studio?"
# → Ask the user, then:
miles reply "Serenity Flow Yoga in Portland, Oregon"
# Miles asks more questions about services, style...
miles reply "We offer hot yoga, vinyasa, and meditation classes. Modern minimalist style."
# Miles creates a brief and asks for approval
miles preview --json
# Open the active dashboard progress URL in the agent browser.
# Rerun preview --json until connected is true, then approve:
miles reply "Looks great, approved!"
# Miles starts generating design directions with the dashboard visible.
# Miles generates design directions (streams progress, returns when done)
miles design-directions
# → Show preview URLs to user, let them pick
miles preview --json
# Open the returned authenticated url in the agent browser.
# Rerun preview --json until connected is true, then:
miles select-design-direction 2
# Miles builds the site (streams progress, returns when done)
miles preview --json
```

## Verify a Design Direction

```bash
miles design-directions --json
# With the dashboard connected, inspect the visible design canvas in the agent browser.
# Use the JSON metadata for direction numbers, names, statuses, and preview URLs.
# Recommend one direction based on visual hierarchy, brief fit, layout, imagery, and polish.
# Use miles screenshot only if the browser preview is unavailable or the response needs images.
```

## Multi-Page Update

After a site exists, request additional pages or multi-page edits through Miles and verify the resulting state:

```bash
miles reply "Add About and Services pages that match the current design direction."
miles wait
miles status --json
miles screenshot /preview/site-id/index.html --json
```

## Agency Automation - Brief-Driven

Agent already has a client brief:

```bash
miles create-site --brief ./client-brief.md "Build site for Portland yoga studio per attached brief"
# Miles skips discovery, generates design directions (streams progress)
miles design-directions
# → Push direction URLs to Notion/Slack for client review
# Client picks design 1
miles preview --json
# Open the returned authenticated url in the agent browser.
# Rerun preview --json until connected is true, then:
miles select-design-direction 1
# Miles builds the site (streams progress, returns when done)
miles export-theme
```

## Quick Site Generation

When you want Miles to make all decisions:

```bash
miles create-site "Build a modern website for Acme Corp, a B2B SaaS company that sells project management software. Use blue and white colors, professional tone, include pricing page."
# The more detail you provide, the fewer questions Miles asks
# Answer any remaining questions Miles has
miles preview --json
# Open the returned authenticated url in the agent browser.
# Rerun preview --json until connected is true, then approve:
miles reply "Yes, that brief looks perfect"
# Miles generates directions, then:
miles preview --json
# Keep the returned authenticated url open in the agent browser.
# Rerun preview --json until connected is true, then:
miles select-design-direction 1
# Miles builds the site (streams progress, returns when done)
miles preview --json
```

## Checking Progress

```bash
miles status
# [status: streaming]
# [phase: building]
# Note: `create-site`, `reply`, and `select-design-direction` all stream
# progress automatically. Use `miles wait` only if a command was interrupted.
```

## Credit Management

```bash
miles balance
# Credits remaining: 150
# If low: "Top up at: https://bymiles.ai/sites/xxx/settings/billing"
```
