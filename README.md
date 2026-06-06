# grill-web

`grill-web` is a Pi-only local web companion for refining Pi todos through Grill-Me sessions. It works with the existing file-based `.pi/todos/*.md` format, launches Pi locally, and helps turn rough todo drafts into reviewed implementation-ready todos.

> Public repository: https://github.com/fabianmewes-jm/grill-web

## What it is

- Local-only browser UI for Pi todo refinement
- Built for Pi workflows, not as a general hosted SaaS app
- Reads and updates the same todo files used by the Pi Todo extension / Pi TUI
- Uses Grill-Me sessions to interview, refine, and review todos before implementation

## Requirements

- Pi CLI available as `pi`
- Node.js `>=20`
- `npm`
- `make` (optional, convenient wrapper around npm commands)

## Install

```bash
git clone https://github.com/fabianmewes-jm/grill-web .pi/grill-web
cd .pi/grill-web
make install
cd ../..
pi install -l .pi/grill-web
cd .pi/grill-web
make start
```

The server starts on `127.0.0.1:8787` by default and prints a local URL like:

```txt
http://127.0.0.1:8787/?token=...
```

Open that URL in your browser. The write token in the URL is used for protected actions.

### Auto-open browser

```bash
OPEN_BROWSER=1 make start
```

## npm fallback commands

If you do not use `make`, use the direct npm commands instead:

```bash
cd .pi/grill-web
npm install
cd ../..
pi install -l .pi/grill-web
cd .pi/grill-web
npm start
```

Auto-open with npm:

```bash
cd .pi/grill-web
OPEN_BROWSER=1 npm start
```

Run the smoke test:

```bash
cd .pi/grill-web
npm run smoke
```

## How package resources are loaded

After `pi install -l .pi/grill-web`, Pi loads package resources directly from:

- `.pi/grill-web/extensions`
- `.pi/grill-web/skills`

These resources are **not** copied into `.pi/extensions` or `.pi/skills`. Keep the checkout in place so Pi can continue loading the package-local extension and skill files.

## Credits for bundled Pi resources

The bundled Todo extension (`extensions/todos.ts`) and `grill-me` skill (`skills/grill-me/SKILL.md`) come from Fabian Mewes' local Pi workflow and are included in `grill-web` as package-local Pi resources under the MIT license.

## Parent project gitignore

`.pi/grill-web/` is a nested tool checkout inside the parent project. The parent project should ignore it, for example:

```gitignore
.pi/grill-web/
```

## Creating todos

Release 1 focuses on refining existing todos, not creating them in the web UI.

Create todos by either:

- using Pi's Todo extension / existing Pi todo workflow, or
- asking Pi to create a todo for you

Then use `grill-web` to refine that todo through a Grill-Me session.

## Basic usage

1. Start the server.
2. Open the local browser URL.
3. Review existing todos from your Pi todo directory.
4. Start Grill-Me on a draft todo.
5. Answer the focused questions.
6. Finalize the reviewed rewrite and save it back to the same todo file.

## Configuration

Optional environment variables:

```bash
PORT=3000 npm start
PI_TODO_PATH=/absolute/or/relative/path/to/todos npm start
PI_CODING_AGENT_SESSION_DIR=/absolute/path/to/pi/sessions npm start
OPEN_BROWSER=1 npm start
```

Pi session discovery resolves from:

1. `PI_CODING_AGENT_SESSION_DIR`
2. project `.pi/settings.json` `sessionDir`
3. global `~/.pi/agent/settings.json` `sessionDir`
4. default `~/.pi/agent/sessions`

## Security

- The server binds to `127.0.0.1` only.
- Read access in the local UI is unauthenticated.
- Write actions and Grill-Me actions are protected by the startup token.
- Local todo files and local Pi sessions can be affected by writes and Grill-Me workflows.
- Assigned todos are treated as read-only in the web UI.
- Grill-Me starts with instructions not to implement the todo and not to edit files.

## Roadmap

- Publish through npm / package registries later
- Add create-todo web UI later
- Explore broader non-Pi adapters later

## Agent Quick-Install Prompt

Use this prompt with an agent if you want it to perform the local setup safely:

```
Set up grill-web in this project.

Requirements:
- Hard-check that the `pi` command exists first.
- If `pi` is missing, stop immediately and tell me to install/configure Pi manually before continuing.
- Clone the repo into `.pi/grill-web` using `https://github.com/fabianmewes-jm/grill-web`.
- Ensure the parent project's `.gitignore` contains `.pi/grill-web/` exactly once; add it if missing.
- Run `make install` in `.pi/grill-web`.
- Run `pi install -l .pi/grill-web` from the project root.
- Do not leave the server running.
- At the end, only recommend the next commands: `cd .pi/grill-web && make start` or `cd .pi/grill-web && OPEN_BROWSER=1 make start`.

Abort on missing `pi`; do not try to work around it.
```

## Notes

- This package is intended for local Pi workflows and Release 1 does not include a hosted multi-user deployment model.
