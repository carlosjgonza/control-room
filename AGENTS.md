# Notes for coding agents

Control room is a small local dashboard for GitHub Actions runs and open pull requests. The user will most often ask you to change **which repos it watches** or **where a PR's Preview button leads**. Both are a config edit; neither needs a code change or a rebuild.

## The config file

```
~/Library/Application Support/Control Room/repos.json
```

(`$CONTROL_ROOM_HOME/repos.json` if that variable is set; `~/.config/Control Room/` on Linux.) The running app re-reads it every 20 seconds, so a saved edit shows up on its own. Do not edit `repos.json` in the repo checkout: it only seeds the real file on first launch and is ignored by git.

Shape (full reference in README.md, "Config"):

```json
{
  "repos": [
    { "repo": "owner/name", "short": "chip label", "runs": 12, "prs": 30,
      "preview": { "check": "vercel", "paths": [["^branch-regex/(.+)$", "/path/$1"]] } }
  ]
}
```

- `repo` is required and must be `owner/name`. Everything else is optional.
- `preview` turns on the Preview button. `paths` maps the PR's head branch to a path on the preview deployment: JavaScript regex plus `String.replace` template, first match wins, no match lands on `/`. Remember to escape backslashes in JSON (`"\\d+"`).
- `preview.check` is a case-insensitive regex for the PR check that reports the preview build (Vercel's commit status is named `Vercel`; for other hosts read the names from `gh pr checks <number> --repo owner/name`). It only drives the ready/building/failed state of the button; the URL itself comes from GitHub's deployments API.

## Before and after editing

1. Read the current file and keep entries and keys you were not asked to change.
2. Check the repo exists and the user can read it: `gh repo view owner/name --json nameWithOwner`.
3. For a preview mapping, check the host publishes GitHub deployments: `gh api "repos/owner/name/deployments?per_page=3" --jq '.[].environment'`. An empty list means the Preview button will wait forever; say so instead of adding it.
4. Write valid JSON (2-space indent), then validate it: `node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$HOME/Library/Application Support/Control Room/repos.json"`.
5. To test a `paths` rule, run the regex against a real branch from `gh pr list --repo owner/name --json headRefName`.

## Code layout

- `server.mjs`: zero-dependency Node server; all GitHub access goes through `gh`. Exposes `/api/state`, `/api/repos` (POST, rewrites the config), `/api/repos/available`, `/api/run`, `/api/rerun`, `/preview`.
- `index.html`: the whole page, no build step; read on every request.
- `electron/main.js`: desktop shell that starts the server with the Electron userData folder as the config dir.

Code changes to the desktop app need `npm run install:app` to rebuild; changes to `index.html` show up on reload in `npm start` and `npm run app`.
