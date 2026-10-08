# Control room

One square page that shows which GitHub Actions are running and which pull requests are open across the repos you pick. It reads everything through the [`gh` CLI](https://cli.github.com) you are already logged into, so there is no token to set up, and it sees whatever that account can see.

It runs as a macOS desktop app with its own Dock icon, or as a page in any browser.

## Install

You need Node 20 or newer and the GitHub CLI:

```sh
brew install gh
gh auth login
```

Then build the app and copy it into /Applications:

```sh
git clone https://github.com/daviduzago/control-room.git
cd control-room
npm install          # pulls Electron
npm run install:app  # builds "Control Room.app" and copies it into /Applications
```

Open it from Launchpad or Spotlight, then right-click its Dock icon and choose Options > Keep in Dock. The window remembers its size and position, so park it on a second screen once. Rows open in your default browser. Closing the window keeps the app running; Cmd+Q quits.

The build is unsigned. Built on your own machine, macOS opens it without complaint; a copy built elsewhere and sent over would be stopped by Gatekeeper, so each person builds their own.

## First launch

1. If `gh` is missing or logged out, the app says which command to run and checks again on its own.
2. With nothing configured yet, it opens the repo picker: search the repos your account can reach, or type any `owner/name`, then Save.
3. Change the list any time with the **repos** button in the header.

Everything else (preview links, chip labels, how many runs to fetch) lives in the config file below.

## Config

One file, outside the app, so editing it never needs a rebuild:

```
~/Library/Application Support/Control Room/repos.json
```

The app re-reads it on every refresh (every 20 seconds), so saved edits show up without restarting. If the file stops being valid JSON, the board keeps the last good list and shows the error at the bottom.

```json
{
  "repos": [
    { "repo": "cli/cli", "short": "gh-cli" },
    {
      "repo": "your-org/your-site",
      "short": "site",
      "runs": 20,
      "prs": 50,
      "preview": {
        "check": "vercel",
        "paths": [["^docs/(.+)$", "/docs/$1"]]
      }
    }
  ]
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `repo` | `owner/name`, required | |
| `short` | label on the chip | the repo name |
| `runs` | recent workflow runs to fetch | 12 |
| `prs` | open pull requests to fetch | 30 |
| `preview` | adds a **Preview** button to that repo's PRs; `true` or an object | off |
| `preview.check` | case-insensitive regex for the PR check that reports the preview build; only drives whether the button reads ready, building or failed | `vercel` |
| `preview.paths` | `[regex, replacement]` pairs matched against the PR's branch; the first match picks the page to open on the preview (`$1` etc. are capture groups) | lands on `/` |

The preview URL itself comes from GitHub's deployments API: the deployment for the PR's head commit. Vercel and Netlify publish these; for another host, check with `gh api "repos/OWNER/NAME/deployments?per_page=3"`. While the build is still running the button shows an ellipsis and the link waits for it.

`repos.example.json` holds the example above. If a `repos.json` sits next to the code on first launch, it seeds the config (handy when setting up a second machine); it is ignored by git.

### Configuring it with an agent

`AGENTS.md` tells coding agents where the config is and how to check an edit, so you can ask one to "watch my-org/api and open previews of `docs/*` branches on my-org/web at /docs/<name>" and have it edit the file.

## Browser version

```sh
npm start          # http://127.0.0.1:4747
```

Same page, same config file. `PORT=5000 npm start` picks another port; `REFRESH_MS=30000` slows the polling; `CONTROL_ROOM_HOME=/some/dir` uses a different config folder; `GH_PATH=/path/to/gh` if gh is not in Homebrew's usual places. If the desktop app already holds port 4747, the other one takes a free port.

Chrome can open it as a bare window with no tabs or address bar:

```sh
open -na "Google Chrome" --args --app=http://127.0.0.1:4747 --window-size=760,760
```

The layout goes to two columns above 700px wide and stacks below that, so any roughly square window works.

## What it shows

- **Strip**: running, queued, failed in the last hour, open PRs, awaiting review.
- **Actions**: active runs first, with a live elapsed timer and a dot-per-step progress line showing which step is running. Then recent runs with outcome, when they finished and how long they took. A failure from the last hour gets a red rail on the left.
- **Click a run** to expand it: every job and step with its duration, and for a failed run the last 40 lines of the failing step's log. From there you can open it on GitHub or **re-run** it (two clicks, to stop accidents). A re-run replays the same commit, so it only helps with flaky or upstream failures, not with a fix that has since merged.
- **Open pull requests**: newest activity first, with the checks rollup and the review decision. Drafts are dimmed; labels show as chips.

Click a pull request to open it on GitHub. Press `r` or click the freshness pill to refresh now. The tab title and favicon carry the state (red if something failed recently, teal while something runs) so it reads even when the window is behind another.

## Hacking on it

`npm run app` runs the desktop app unpackaged. The server (`server.mjs`) has no dependencies and serves `index.html`, which is read on every request, so page edits show up on a reload. The icon is drawn in `build/icon.svg`; `npm run icon` re-renders the .icns with only macOS tools.

## Cadence and limits

The server asks `gh` every 20 seconds; the page asks the server every 10 seconds and ticks its timers locally. Each refresh is two `gh` calls per repo plus one per active run, against GitHub's 5,000 requests an hour. Ten repos is comfortable; at 40 or more, raise `REFRESH_MS`.

The server listens only on 127.0.0.1 and answers only requests addressed to it there, since it can re-run workflows as you.
