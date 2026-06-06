# Outcomes and Exit Codes

The truthful-result contract. Its one law: **never default to success.** A turn that printed friendly text can still have done nothing.

## The outcome enum

Servers that support outcomes attach one to every settled turn — in `wait-job` JSON as `outcome`, and in streamed output as `[outcome: …]`:

| Outcome | Meaning | What you do |
|---|---|---|
| `completed` | The turn finished its work | Continue. A `question` may still need relaying. |
| `blocked` | The requested work did NOT happen; `outcomeUnresolved[]` says why | Resolve the blocker (often: ask the user), then retry deliberately. |
| `declined` | The user explicitly said no (e.g. rejected a confirmation) | **Stop.** Do not retry, rephrase, or route around a decline. Mark dependent work moot. |
| `aborted` | The run was stopped (`cancel`, user stop) | Intentional stop. Confirm next steps with the user. |
| `need_connection` | The run needed/lost the browser connection | `connect-browser`, wait for `connected: true`, retry once. |
| `capacity` | Server capacity or an already-running turn | Wait, `wait-job`, or retry later. Never tight-loop. |
| `failed` | The run errored; `outcomeReason`/`error` + recovery steps | Read the recovery guidance; surface the error to the user. |

Older servers send no `outcome` field. Then `status` is your only signal (`failed` is failure; everything else needs your judgment from the message text) — be conservative about claiming success.

## Exit codes (all verbs)

```text
0  completed
1  failed / aborted / unexpected error
2  precondition missing (auth, active site, arguments, server support)
3  need_connection  → connect-browser, wait for connected, retry ONCE
4  blocked or declined → work did not happen; involve the user
5  capacity / already streaming → wait, don't hammer
```

JSON error payloads carry `code` (`need_connection`, `primitive_unsupported`, …) and, for exit 3, `connection: { "kind": "browser-dashboard" }` — the kind tells you which connection to establish (more kinds may appear as Miles learns to target other site types).

## Agent rules

- Branch on exit codes and `outcome`, not on prose or the presence of output.
- Exactly one retry after fixing a `need_connection`; if it fails again, surface it.
- On `declined`: report the decline faithfully to the user/calling workflow. Treating a decline as an obstacle to engineer around is the one unforgivable behavior on this surface.
- On `blocked`: the `outcomeUnresolved[]` items are the to-do list; do not re-fire the same command unchanged.
- On `capacity` from a fired build you own: `wait-job` is the answer, not a duplicate build.
