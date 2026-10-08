// Control room server. Zero dependencies: everything comes through the `gh` CLI
// you are already logged into, so there is no token to manage. It keeps one
// snapshot of runs and PRs across the repos in your config, refreshes it on a
// timer, and serves the page plus that snapshot as JSON.
//
// `node server.mjs` runs it standalone for a browser; the Electron app imports
// startServer() and points its window at the URL it returns. Both read the same
// config file (see configDir below), so the two never disagree.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

// An app launched from the Dock inherits a bare PATH without Homebrew, so gh
// has to be found explicitly rather than assumed.
function findGh() {
  if (process.env.GH_PATH) return process.env.GH_PATH;
  for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) if (existsSync(p)) return p;
  try {
    return execFileSync("/bin/zsh", ["-lc", "command -v gh"], { encoding: "utf8" }).trim() || "gh";
  } catch {
    return "gh";
  }
}
const GH = findGh();

// Where the config lives: the folder Electron uses as userData for "Control
// Room", so the packaged app and `npm start` share one file, and it sits outside
// the app bundle so editing it never needs a rebuild.
export function configDir() {
  if (process.env.CONTROL_ROOM_HOME) return process.env.CONTROL_ROOM_HOME;
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Control Room");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Control Room");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "Control Room");
}

const RUN_FIELDS =
  "databaseId,name,displayTitle,status,conclusion,event,headBranch,createdAt,startedAt,updatedAt,url,workflowName,attempt";
const PR_FIELDS =
  "number,title,author,headRefName,baseRefName,createdAt,updatedAt,url,isDraft,labels,statusCheckRollup,reviewDecision,additions,deletions,headRefOid";
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

async function gh(...args) {
  const { stdout } = await exec(GH, args, { timeout: 30_000, maxBuffer: 16 << 20 });
  return JSON.parse(stdout);
}

const firstLine = (err) => String(err.stderr || err.message || err).trim().split("\n")[0];

// Is gh installed and logged in? The page shows a setup screen until it is,
// instead of a board full of errors.
async function checkGh() {
  try {
    const { stdout } = await exec(GH, ["api", "user", "--jq", ".login"], { timeout: 15_000 });
    return { status: "ok", login: stdout.trim(), gh: GH };
  } catch (err) {
    if (err.code === "ENOENT") return { status: "missing", gh: GH, message: "The GitHub CLI (gh) is not installed." };
    return { status: "loggedOut", gh: GH, message: firstLine(err) };
  }
}

// Jobs and steps of one run, trimmed to what the page draws.
const trimStep = ({ number, name, status, conclusion, startedAt, completedAt }) =>
  ({ number, name, status, conclusion, startedAt, completedAt });
const trimJob = ({ name, status, conclusion, startedAt, completedAt, url, steps }) =>
  ({ name, status, conclusion, startedAt, completedAt, url, steps: (steps ?? []).map(trimStep) });
async function runJobs(repo, id) {
  const { jobs } = await gh("run", "view", String(id), "--repo", repo, "--json", "jobs");
  return jobs.map(trimJob);
}

// Last lines of the failed step's log, with the job/step prefix and timestamps
// stripped, so a failure can be read without leaving the board.
async function failedLog(repo, id) {
  try {
    const { stdout } = await exec(GH, ["run", "view", String(id), "--repo", repo, "--log-failed"], {
      timeout: 45_000,
      maxBuffer: 64 << 20,
    });
    const lines = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t").slice(2).join("\t").replace(/^\S+Z\s?/, ""));
    return lines.slice(-40).join("\n");
  } catch (err) {
    return firstLine(err);
  }
}

// Details are immutable once a run has finished, so they are fetched once per
// (run, updatedAt) and kept. `v` is the run's updatedAt from the list.
const detailCache = new Map();
function runDetails(repo, id, v) {
  const key = `${repo}#${id}#${v}`;
  if (!detailCache.has(key)) {
    if (detailCache.size > 200) detailCache.delete(detailCache.keys().next().value);
    detailCache.set(
      key,
      (async () => {
        const jobs = await runJobs(repo, id);
        const failed = jobs.some((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
        return { jobs, log: failed ? await failedLog(repo, id) : null };
      })().catch((err) => {
        detailCache.delete(key);
        throw err;
      }),
    );
  }
  return detailCache.get(key);
}

// A PR's preview check only links to the host's own dashboard. The preview
// itself is the environment_url of the GitHub deployment for the head commit,
// which Vercel, Netlify and most hosts publish and which is stable per commit,
// so it is looked up on click and remembered.
const previewCache = new Map();
async function previewUrl(repo, sha) {
  const key = `${repo}#${sha}`;
  if (previewCache.has(key)) return { url: previewCache.get(key) };
  const deployments = await gh("api", `repos/${repo}/deployments?sha=${sha}&per_page=10`);
  const dep = deployments.find((d) => /preview/i.test(d.environment)) ?? deployments[0];
  if (!dep) return { pending: true };
  const statuses = await gh("api", `repos/${repo}/deployments/${dep.id}/statuses?per_page=10`);
  const ok = statuses.find((st) => st.state === "success" && st.environment_url);
  if (ok) {
    previewCache.set(key, ok.environment_url);
    return { url: ok.environment_url };
  }
  if (statuses.some((st) => st.state === "failure" || st.state === "error")) return { failed: true };
  return { pending: true };
}

// "preview": true, or { "paths": [["^feature/(.+)$", "/$1"]], "check": "netlify" }.
// `paths` maps a branch to the page worth opening on its preview (first match
// wins, anything else lands on /). `check` is a regex for the PR check that
// reports the preview build; it defaults to "vercel".
const previewConfig = (p) => (p ? (p === true ? {} : p) : null);
function previewPath(cfg, branch) {
  for (const [pattern, template] of cfg?.paths ?? []) {
    const re = new RegExp(pattern);
    if (re.test(branch)) return branch.replace(re, template);
  }
  return "/";
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

async function fetchRepo({ repo, short, runs: runLimit = 12, prs: prLimit = 30 }) {
  const errors = [];
  const swallow = (source) => (err) => {
    errors.push({ repo, source, message: firstLine(err) });
    return [];
  };
  const [runs, prs] = await Promise.all([
    gh("run", "list", "--repo", repo, "--limit", String(runLimit), "--json", RUN_FIELDS).catch(swallow("runs")),
    gh("pr", "list", "--repo", repo, "--state", "open", "--limit", String(prLimit), "--json", PR_FIELDS).catch(
      swallow("pull requests"),
    ),
  ]);
  await Promise.all(
    runs
      .filter((r) => ACTIVE.has(r.status))
      .map(async (r) => {
        r.jobs = await runJobs(repo, r.databaseId).catch(() => null);
      }),
  );
  const tag = (x) => ({ ...x, repo, short: short ?? repo.split("/")[1] });
  return { runs: runs.map(tag), prs: prs.map(tag), errors };
}

// Repos the logged-in account can reach, most recently pushed first, for the
// picker. Three pages is plenty to pick from; anything else can be typed.
async function availableRepos() {
  const pages = await Promise.all(
    [1, 2, 3].map((page) =>
      gh("api", `user/repos?per_page=100&sort=pushed&page=${page}`).catch((err) => (page === 1 ? Promise.reject(err) : [])),
    ),
  );
  return pages.flat().map((r) => ({ repo: r.full_name, private: r.private, pushedAt: r.pushed_at }));
}

// Binds the preferred port; if something else already has it (usually a
// standalone `npm start`), takes any free one instead of failing.
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });

export async function startServer({
  port = Number(process.env.PORT ?? 4747),
  refreshMs = Number(process.env.REFRESH_MS ?? 20_000),
  dir = configDir(),
} = {}) {
  const configPath = join(dir, "repos.json");

  // First run: seed from a repos.json next to the code if there is one (a
  // personal file, ignored by git), otherwise start empty and let the page ask.
  if (!existsSync(configPath)) {
    await mkdir(dir, { recursive: true });
    const local = join(here, "repos.json");
    if (existsSync(local)) await copyFile(local, configPath);
    else await writeFile(configPath, JSON.stringify({ repos: [] }, null, 2) + "\n");
  }

  // The file is re-read on every refresh, so hand edits (or an agent's) show up
  // within one cycle. A broken file keeps the last good list and says why.
  let config = { repos: [] };
  let configError = null;
  async function loadConfig() {
    try {
      const parsed = JSON.parse(await readFile(configPath, "utf8"));
      if (!Array.isArray(parsed.repos)) throw new Error('expected { "repos": [...] }');
      const bad = parsed.repos.find((r) => !REPO_NAME.test(r?.repo ?? ""));
      if (bad) throw new Error(`"${bad?.repo ?? JSON.stringify(bad)}" is not owner/name`);
      config = parsed;
      configError = null;
    } catch (err) {
      configError = `${configPath}: ${err.message}`;
    }
  }
  async function saveConfig(next) {
    const tmp = `${configPath}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
    await rename(tmp, configPath);
    config = next;
    configError = null;
  }
  const repos = () => config.repos;
  await loadConfig();

  const publicRepos = () =>
    repos().map((r) => {
      const preview = previewConfig(r.preview);
      return {
        repo: r.repo,
        short: r.short ?? r.repo.split("/")[1],
        preview: Boolean(preview),
        previewCheck: preview?.check ?? "vercel",
      };
    });

  const state = {
    viewer: null,
    setup: { status: "checking" },
    configPath,
    repos: publicRepos(),
    refreshEveryMs: refreshMs,
    fetchedAt: null,
    refreshing: false,
    runs: [],
    prs: [],
    errors: [],
  };

  let inFlight = null;
  function refresh() {
    if (inFlight) return inFlight;
    state.refreshing = true;
    inFlight = (async () => {
      await loadConfig();
      state.repos = publicRepos();
      // Until gh works there is nothing to fetch. Check again every cycle so
      // installing it or logging in is picked up without a restart.
      if (state.setup.status !== "ok") {
        state.setup = await checkGh();
        state.viewer = state.setup.login ?? null;
        if (state.setup.status !== "ok") return;
      }
      const parts = await Promise.all(repos().map(fetchRepo));
      state.runs = parts.flatMap((p) => p.runs);
      state.prs = parts.flatMap((p) => p.prs);
      state.errors = parts.flatMap((p) => p.errors);
      if (configError) state.errors.unshift({ repo: "*", source: "config", message: configError });
      state.fetchedAt = new Date().toISOString();
    })()
      .catch((err) => {
        state.errors = [{ repo: "*", source: "refresh", message: firstLine(err) }];
      })
      .finally(() => {
        state.refreshing = false;
        inFlight = null;
      });
    return inFlight;
  }

  refresh();
  const timer = setInterval(refresh, refreshMs);

  const known = (repo) => repos().some((r) => r.repo === repo);
  // Small interstitial for the preview link when there is nothing to redirect to yet.
  const page = (res, code, title, text, retry = false) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8">${retry ? '<meta http-equiv="refresh" content="10">' : ""}<title>${title}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#06090d;color:#eeede4;font:15px/1.5 -apple-system,Helvetica,Arial,sans-serif">
<div style="max-width:32em;padding:24px"><h1 style="font-size:17px;margin:0 0 8px">${title}</h1><p style="margin:0;color:#bea989">${text}</p></div></body>`);
  };
  const json = (res, body, code = 200) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  // The server can re-run workflows and rewrite the config, so only this
  // machine's own page may talk to it: the Host check stops DNS-rebinding
  // pages from reading the board, and requiring a JSON content type on writes
  // forces a CORS preflight that a foreign page cannot pass.
  const localHost = (host) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? "");
  const jsonRequest = (req) => /^application\/json\b/.test(req.headers["content-type"] ?? "");

  const server = createServer(async (req, res) => {
    if (!localHost(req.headers.host)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    const { pathname, searchParams: q } = new URL(req.url, "http://localhost");
    if (req.method === "POST" && !jsonRequest(req)) return json(res, { ok: false, error: "expected JSON" }, 415);
    if (pathname === "/api/state") return json(res, state);
    if (pathname === "/api/refresh") {
      refresh();
      return json(res, { ok: true });
    }
    if (pathname === "/api/repos/available") {
      if (state.setup.status !== "ok") return json(res, { error: "gh is not ready" }, 409);
      try {
        return json(res, { repos: await availableRepos() });
      } catch (err) {
        return json(res, { error: firstLine(err) }, 502);
      }
    }
    // Replaces the tracked list with { repos: ["owner/name", ...] }. Settings a
    // repo already has in the file (short, preview, limits) are kept.
    if (pathname === "/api/repos" && req.method === "POST") {
      let names;
      try {
        names = JSON.parse(await readBody(req)).repos;
      } catch {
        return json(res, { ok: false, error: "bad request" }, 400);
      }
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string" || !REPO_NAME.test(n.trim())))
        return json(res, { ok: false, error: "repos must be owner/name" }, 400);
      // Re-read first: a hand edit since the last refresh must not be lost.
      await loadConfig();
      if (configError) return json(res, { ok: false, error: `Fix the config file first. ${configError}` }, 409);
      const unique = [...new Set(names.map((n) => n.trim()))];
      const next = { ...config, repos: unique.map((n) => repos().find((r) => r.repo === n) ?? { repo: n }) };
      try {
        await saveConfig(next);
      } catch (err) {
        return json(res, { ok: false, error: firstLine(err) }, 500);
      }
      state.repos = publicRepos();
      state.runs = state.runs.filter((r) => known(r.repo));
      state.prs = state.prs.filter((p) => known(p.repo));
      refresh();
      return json(res, { ok: true, repos: state.repos });
    }
    if (pathname === "/api/run") {
      const repo = q.get("repo"), id = q.get("id"), v = q.get("v") ?? "";
      if (!known(repo) || !/^\d+$/.test(id ?? "")) return json(res, { error: "unknown run" }, 400);
      try {
        return json(res, await runDetails(repo, id, v));
      } catch (err) {
        return json(res, { error: firstLine(err) }, 502);
      }
    }
    if (pathname === "/preview") {
      const repo = q.get("repo"), number = Number(q.get("number"));
      const preview = previewConfig(repos().find((r) => r.repo === repo)?.preview);
      const pr = state.prs.find((p) => p.repo === repo && p.number === number);
      if (!preview || !pr) return page(res, 404, "Unknown pull request", "This pull request is not on the board.");
      try {
        const found = await previewUrl(repo, pr.headRefOid);
        if (found.url) {
          res.writeHead(302, { location: found.url.replace(/\/$/, "") + previewPath(preview, pr.headRefName) });
          return res.end();
        }
        if (found.failed) return page(res, 502, "Preview build failed", `The preview for #${number} could not be built. Check the pull request on GitHub.`);
        return page(res, 503, "Preview still building", `The preview for #${number} is not ready yet. This page retries every 10 seconds.`, true);
      } catch (err) {
        return page(res, 502, "Could not resolve the preview", firstLine(err));
      }
    }
    if (pathname === "/api/rerun" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { /* falls through to the check below */ }
      const { repo, id } = body;
      if (!known(repo) || !/^\d+$/.test(String(id))) return json(res, { ok: false, error: "unknown run" }, 400);
      try {
        await exec(GH, ["run", "rerun", String(id), "--repo", repo], { timeout: 30_000 });
        setTimeout(refresh, 2500);
        return json(res, { ok: true });
      } catch (err) {
        return json(res, { ok: false, error: firstLine(err) }, 502);
      }
    }
    if (pathname === "/" || pathname === "/index.html") {
      // Read on every request so edits to the page show up on a plain reload.
      const html = await readFile(join(here, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    res.writeHead(404);
    res.end("not found");
  });

  const bound = await listen(server, port);
  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    configPath,
    repos,
    refreshMs,
    close() {
      clearInterval(timer);
      server.close();
    },
  };
}

// Standalone: `node server.mjs` (or `npm start`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startServer();
  console.log(`control room   ${s.url}`);
  console.log(`config         ${s.configPath}`);
  console.log(`watching       ${s.repos().map((r) => r.repo).join(", ") || "nothing yet; pick repos in the page"}`);
  console.log(`refresh        every ${s.refreshMs / 1000}s through ${GH}`);
}
