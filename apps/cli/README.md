# brio

The command line for [Brio](https://brio-orchestrator.vercel.app), the multi-agent orchestrator. Give Brio one goal: it plans the work, hands each piece to the agent best at it across every vendor, has another vendor check the result, and learns who wins.

The CLI talks to your own Brio server. Brio is self-hosted; a free 1 GB server is enough ([deploy on a cloud server](https://github.com/Ivan825/brio_/blob/main/docs/DEPLOY_CLOUD.md)).

## Install

Node 22 or newer.

```bash
npm install -g brio-orchestrator     # then: brio --help
# or without installing:
npx brio-orchestrator --help
```

## Use

```bash
brio login --url https://your-brio.example      # approve the code in your browser
brio run "Add a health endpoint, with tests" --watch
brio missions
brio board <mission>                            # the live board in your terminal
brio plan <mission> --gate api.health           # edit the plan; edits make a new version
brio approve                                    # what waits for you: plans, pull requests
```

| Command | What it does |
|---|---|
| `brio login` / `logout` / `whoami` | Sign in with the device flow; the session is yours, so you can approve plans and pull requests |
| `brio workspace [use <slug>]` | List workspaces, or pick one |
| `brio run "<goal>"` | Start a mission: `--project`, `--priority`, `--budget`, `--crew`/`--agent`, `--template`, `--issue`, `--file`, `--quick`, `--watch` |
| `brio plan <mission>` | Show the plan, or edit it: `--pin`, `--remove`, `--gate`, `--after`, `--mode`, `--move` |
| `brio board <mission>` | Follow the live board (`--once` prints it once) |
| `brio approve` | Approve or `--deny` what waits for you |
| `brio runner register` / `start` / `status` | Make this machine a runner: tasks on projects that live here run here, in Docker sandboxes (or, with your consent, `--host`) under your own CLI sign-ins |
| `brio mcp` | Brio's MCP tools over stdio for local MCP clients (`BRIO_URL`, `BRIO_TOKEN`) |

## Links

- Website and docs: <https://brio-orchestrator.vercel.app>
- Getting started: <https://brio-orchestrator.vercel.app/docs/getting-started>
- Source: <https://github.com/Ivan825/brio_> (AGPL-3.0)
