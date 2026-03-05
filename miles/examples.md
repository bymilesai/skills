# Miles Workflow Examples

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
miles reply "Looks great, approved!"
# Miles generates design directions (streams progress, returns when done)
miles design-directions
# → Show preview URLs to user, let them pick
miles select-design-direction 2
# Miles builds the site (streams progress, returns when done)
miles preview
```

## Agency Automation - Brief-Driven

Agent already has a client brief:

```bash
miles create-site --brief ./client-brief.md "Build site for Portland yoga studio per attached brief"
# Miles skips discovery, generates design directions (streams progress)
miles design-directions
# → Push direction URLs to Notion/Slack for client review
# Client picks design 1
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
miles reply "Yes, that brief looks perfect"
# Miles generates directions, then:
miles select-design-direction 1
# Miles builds the site (streams progress, returns when done)
miles preview
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
