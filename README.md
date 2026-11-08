# 🔄 fork-manager

**Language / 语言**: English · [切换到简体中文](README.zh-CN.md)

> One-tap sync for all your GitHub forks. Built by [ModelNorth](https://modelnorth.com). Maintained by [lucienlmy](https://github.com/lucienlmy).

Keep every fork in your GitHub account up to date with its upstream — automatically on a schedule, or manually with a single button click.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Setup](#setup)
- [Scheduled Runs](#scheduled-runs)
- [Manual Trigger](#manual-trigger)
- [SYNC_ALL_BRANCHES Variable](#sync_all_branches-variable)
- [Why Diverged Forks Get a PR](#why-diverged-forks-get-a-pr)
- [Legacy Sync Mode (`force_sync`)](#legacy-sync-mode-force_sync)
- [Log Symbols](#log-symbols)
- [Default Branch vs Extra Branches](#default-branch-vs-extra-branches)
- [Troubleshooting](#troubleshooting)
- [Organization-Owned Forks](#organization-owned-forks)
- [Only Syncing Specific Repos](#only-syncing-specific-repos)
- [Excluding Repos Permanently](#excluding-repos-permanently)
- [Output Example](#output-example)
- [License](#license)

---

## How It Works

1. GitHub Actions fetches a list of **all your forked repos**
2. For each fork, it builds the branches to process: the default branch pair, plus any extra branch that exists under the **same name** in both the fork and its upstream
3. Each branch is **compared** with its upstream counterpart using the same rules
4. `identical`, or the fork is simply ahead → nothing to do
5. `ahead` (fork has no own commits) → fast-forward via the `merge-upstream` API
6. `diverged` (fork has its own commits) → **no automatic merge**. A pull request is created instead so you can review and merge manually; an existing open PR is reused
7. A summary using a distinct symbol for each result type is printed at the end

Everything runs server-side on GitHub — no local cloning, no git commands on your machine.

---

## Setup

### 1. Fork or clone this repo

### 2. Create a Personal Access Token (PAT)

Go to **GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens**

- Name: `fork-manager-token`
- Repository access: **All repositories**
- Permissions:
  - `Contents` → Read and Write
  - `Pull requests` → Read and Write (needed to create PRs for diverged forks)
  - `Issues` → Read and Write (optional; needed to add the `merge-conflict` label to conflicting PRs)
  - `Workflows` → Read and Write (optional; allows a fast-forward to include `.github/workflows/*` changes)
  - `Actions` → Read and Write
  - `Metadata` → Read only

### 3. Add the token as a secret

Go to this repo → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `PAT_TOKEN`
- Value: your token from step 2

If you also have forks under an organization, add a second fine-grained token for that owner as another secret — see [Organization-Owned Forks](#organization-owned-forks).

### 4. You're done

The workflow runs **every day at 09:00 UTC (17:00 Beijing time)** automatically — see [Scheduled Runs](#scheduled-runs).

Extra-branch sync is enabled by default. To switch back to default-branch-only, see [SYNC_ALL_BRANCHES Variable](#sync_all_branches-variable).

---

## Scheduled Runs

The schedule lives in `.github/workflows/sync-forks.yml`:

```yaml
on:
  schedule:
    - cron: "0 9 * * *"
```

- `0 9 * * *` = **09:00 UTC every day**, weekends included. GitHub always interprets cron in UTC, not your account timezone, so for UTC+8 that is **17:00 Beijing time**.
- GitHub executes the workflow file on the repository's **default branch**. Push workflow changes to that branch before they take effect.
- This is the earliest trigger time, not an exact guarantee: scheduled jobs are queued during peak load and commonly start a few minutes late, occasionally much later.
- On a `schedule` event all `workflow_dispatch` inputs are empty. `dry_run` and `force_sync` resolve to `false`, `only_repos` / `exclude_repos` are empty, so the run performs real writes over all forks using the normal PR flow.
- GitHub may disable the schedule after 60 days of repository inactivity; re-enable it from the Actions page if runs stop appearing.
- To change the hour you must edit the `cron` line — `on:` cannot read `vars.*` or `inputs.*`. A fixed high-frequency cron plus a runtime gate and a repository variable is the alternative if you want the hour configurable from the web UI.

---

## Manual Trigger

Go to **Actions → 🔄 Sync All Forks → Run workflow**

You'll get four options:

| Option | Description |
|--------|-------------|
| `dry_run` | Read-only preview: shows what would be synced or turned into a PR |
| `force_sync` | Legacy mode: skip compare and PRs, call `merge-upstream` directly for every fork — GitHub may auto-merge diverged forks. Unchecked (default) uses the PR flow |
| `exclude_repos` | Comma-separated list of repo names to skip this run |
| `only_repos` | Comma-separated list of repos to sync (empty = all forks) |

Things to know about manual runs:

- The **Use workflow from** dropdown chooses which branch's `sync-forks.yml` **and** `sync.js` are executed. Use the default branch, or a branch that already contains the latest changes — an older branch without the `SYNC_ALL_BRANCHES` env line ignores the variable and always enables extra branches.
- Repository variables are repository-wide and shared by all branches; you never set them per branch.
- `SYNC_ALL_BRANCHES` applies to manual runs exactly as it does to scheduled runs, because `vars.*` is evaluated at job start for every trigger type. See [SYNC_ALL_BRANCHES Variable](#sync_all_branches-variable).
- There is no per-run override for it: the four inputs above are the only manual options. Changing the variable affects every later run, so restore it afterwards if you only wanted a one-off test.
- `only_repos` filters by **repository**, not by branch. With one repo selected, all its matching extra branches are still processed when the switch is on; there is no "run only branch `dev`" option.
- Recommended first test: put one repo in `only_repos` and check `dry_run`. Nothing is written; confirm the `Extra branches: enabled/disabled` line at the top of the log and the `📦 Branches processed` count at the end.

---

## SYNC_ALL_BRANCHES Variable

This optional repository variable controls whether extra (non-default) branches are synced. It is **enabled by default**; setting it to `false` falls back to default-branch-only. See [Default Branch vs Extra Branches](#default-branch-vs-extra-branches) for what the two types mean.

### Where to set it

Set it on **the repository that runs the workflow** (this `fork-manager` repo), not on each of your forks — `vars.*` reads the configuration of the repo where the job runs.

1. Open the `fork-manager` repo → **Settings** (the repository tab, not your personal settings).
2. Left sidebar → **Secrets and variables → Actions**.
3. Select the **Variables** tab (not `Secrets`).
4. Click **New repository variable**.
5. Name `SYNC_ALL_BRANCHES`, Value `false` → **Add variable**.

You need admin/settings permission on the repo. An organization-level variable of the same name also works, but a repository-level value takes precedence.

### How the Variable Works

```yaml
SYNC_ALL_BRANCHES: ${{ vars.SYNC_ALL_BRANCHES || 'true' }}
```

- Evaluated at job start for **both** scheduled and manual runs; it is not a `workflow_dispatch` input.
- If the variable does not exist, `|| 'true'` keeps extra-branch sync enabled.
- Only the exact lowercase string `false` disables it. `FALSE`, `False`, or an empty value leave it enabled.
- The script reads it as `process.env.SYNC_ALL_BRANCHES !== "false"`.

| Value | Behaviour |
|-------|-----------|
| not set / `true` / anything else | Default branch + every same-name extra branch |
| `false` | Default branch only |

### Verifying and reverting

- Takes effect on the **next run** — no YAML edit, no push, no redeploy.
- The top of the log prints `Extra branches: enabled (same-name branches only)` or `Extra branches: disabled (default branch only)`.
- The summary prints `📦 Repos processed` and `📦 Branches processed`; with the switch off, at most one branch is counted per repo.
- To re-enable: set the value to `true`, or simply delete the variable.

---

## Why Diverged Forks Get a PR

If a fork's default branch has its own commits, GitHub's `merge-upstream` API would silently create a merge commit on that branch. fork-manager never lets that happen:

1. `GET /repos/{owner}/{repo}/compare/{forkBranch}...{upstreamOwner}:{upstreamBranch}` determines the branch relationship
2. Only when the result is `ahead` (no own commits) is `merge-upstream` called
3. When the result is `diverged`, the script skips `merge-upstream` and opens `POST /repos/{owner}/{repo}/pulls` with `head: "upstreamOwner:branch"` and `base: forkBranch`
4. An existing open PR with the same head/base is reused, so repeated runs do not pile up PRs

Your commits are never overwritten and never merged automatically — you decide in the PR.

After a PR is created (or an existing one is reused), fork-manager polls `GET /repos/{owner}/{repo}/pulls/{number}` for `mergeable`. A PR with `mergeable: false` / `mergeable_state: "dirty"` is logged as `💥 [PR CONFLICT]`, listed at the end of the run, and tagged `merge-conflict` when the PAT allows it. GitHub computes `mergeable` asynchronously, so it is checked up to 3 times (2s apart); if it stays `unknown`, no conflict is reported.

---

## Legacy Sync Mode (`force_sync`)

Checking `force_sync` restores the behaviour from before the PR flow existed:

1. No `compare` call and no pull requests — every fork goes straight to `POST /repos/{owner}/{repo}/merge-upstream`
2. GitHub decides: fast-forward, `Successfully fetched and merged ...` (a real merge commit on a diverged fork), or HTTP 409
3. 409 is reported as `⚠️ [CONFLICT]` but **no PR is created**; 422 is `⏭ [SKIPPED]`
4. A merge performed this way is logged as `🟣 [MERGED]` and counted under `Merged (auto)`

Despite the name, this mode never force-overwrites or discards your commits — it only removes the pre-check that stops GitHub from auto-merging. `dry_run` takes precedence if both are checked.

---

## Log Symbols

| Symbol | Meaning |
|--------|---------|
| `✅ [SYNCED]` | No own commits; branch was fast-forwarded |
| `🔀 [PR CREATED]` | Diverged fork; a pull request was opened, no automatic merge |
| `🔁 [PR EXISTS]` | Diverged fork; an existing open PR was reused |
| `➖ [UP TO DATE]` | Already identical to upstream |
| `⏫ [AHEAD ONLY]` | Fork has own commits but upstream has nothing new to pull |
| `🛑 [AUTO MERGE]` | Unexpected: GitHub merged despite the pre-check — inspect manually |
| `🟣 [MERGED]` | Legacy mode: GitHub auto-merged upstream changes into a diverged fork |
| `💥 [PR CONFLICT]` | PR created/reused but `mergeable: false` — resolve manually; `merge-conflict` label added when the PAT allows it |
| `⚠️ [CONFLICT]` | Real merge conflict (HTTP 409); a PR is created for manual resolution |
| `🚧 [BLOCKED]` | Fast-forward refused because the PAT cannot push workflow files; falls back to a PR |
| `⏭ [EXCLUDED]` | Explicitly excluded via `exclude_repos` / `PERMANENT_EXCLUDES` |
| `⏭ [SKIPPED]` | API returned 422 or an unknown compare status — no action taken; listed at the end of the log |
| `❌ [ERROR]` | API error |
| `🔍 [WOULD SYNC]` / `[WOULD PR]` | Dry-run preview |

Extra branches are shown as `owner/repo@branch`; the default branch keeps `owner/repo`.

---

## Default Branch vs Extra Branches

Each fork has one **default branch** (the primary branch, taken from `fork.default_branch`) and potentially several **extra branches** (all other branches, i.e. secondary branches). Both go through the same sync logic, but they are discovered differently.

| | Default branch (primary) | Extra branches (secondary) |
|---|---|---|
| How it is selected | Always included, one per fork | Exact **same-name** match in both the fork's and the upstream's branch lists |
| Name must match upstream | No — fork `main` ↔ upstream `enhanced` is fine | Yes — `dev` ↔ `dev` only; no mapping, no guessing |
| Exists on only one side | Still processed using `parent.default_branch` | Ignored — fork-only and upstream-only branches are skipped; upstream-only branches are never created in the fork |
| Log label | `owner/repo` | `owner/repo@branch` |
| Sync rules | compare → fast-forward, PR, or skip | **Identical** to the default branch |
| `SYNC_ALL_BRANCHES=false` | Still synced | All skipped |

Other details:

- Branches with no common ancestor are skipped instead of being reported as errors.
- Every extra branch follows the same rules as the default branch: clean fast-forwards are synced (no PR), diverged branches get a PR, conflicting PRs are tagged.
- If `merge-upstream` rejects an extra branch, the script falls back to creating a PR instead of skipping it.
- Enabling extra branches adds two branch-list calls per repo, plus a compare (and possibly PR calls) for every matched branch; requests are throttled, so a full run takes longer. Set `SYNC_ALL_BRANCHES=false` to fall back to default-branch-only — see [SYNC_ALL_BRANCHES Variable](#sync_all_branches-variable).

---

## Troubleshooting

### `❌ HTTP 403: Resource not accessible by personal access token` when creating a PR

The token can read the fork but cannot open pull requests on it. Grant **`Pull requests` → Read and Write** (and keep `Contents` → Read and Write). For a classic PAT, make sure the `repo` / `public_repo` scopes are enabled. Fine-grained token permission changes take effect immediately; a classic token must be regenerated and the `PAT_TOKEN` secret updated.

### `⏭ ... refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`

A fast-forward would write `.github/workflows/*` files, which GitHub blocks for tokens without workflow permission. Either grant **`Workflows` → Read and Write** (fine-grained) / the `workflow` scope (classic PAT), or leave it as-is: fork-manager logs `🚧 [BLOCKED]` and opens a pull request instead, which does not push workflow files.

### `❌ HTTP 403` on organization-owned forks

A fine-grained PAT is tied to a single resource owner. Forks under another owner can be returned by `/user/repos` yet still reject writes with 403. Add an owner-specific token (see [Organization-Owned Forks](#organization-owned-forks)), use a classic PAT (broader access), or exclude them with `exclude_repos` / `PERMANENT_EXCLUDES`.

---

## Organization-Owned Forks

A fine-grained PAT can only access resources owned by the **one** Resource owner selected when it was created. If your forks live under several owners (for example `lucienlmy` and the `JoyHub2990` organization), forks under the other owner appear in `/user/repos` but every write fails with `HTTP 403: Resource not accessible by personal access token`. The fix is one extra token per owner: the script picks the token by the fork's owner, so no repository has to be moved and the workflow stays where it is.

### 1. Create a second fine-grained token

Go to **GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens → Generate new token**:

- Resource owner: select the **organization** (e.g. `JoyHub2990`)
- Repository access: `All repositories` (of that organization), or `Only select repositories`
- Permissions: the same set as the main token — `Contents` RW, `Pull requests` RW, `Issues` RW (for the `merge-conflict` label), `Actions` RW, `Workflows` RW, `Metadata` RO
- Set an expiration

If you own the organization the approval is granted automatically; otherwise an organization admin must approve the request. If the organization blocks fine-grained tokens, allow them in its personal access token policy.

### 2. Store it as a secret

In this repo → **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `PAT_TOKEN_ORG`
- Value: the organization token

The workflow already passes it as an env var and ships a default mapping:

```yaml
PAT_TOKEN_ORG: ${{ secrets.PAT_TOKEN_ORG }}
OWNER_TOKENS: ${{ vars.OWNER_TOKENS || '{"JoyHub2990":"PAT_TOKEN_ORG"}' }}
```

`OWNER_TOKENS` is a JSON object mapping an owner name to the **name of the env var holding its token** — never the token value itself, so it is safe to keep in a repository variable. Matching is case-insensitive. Owners not listed use `PAT_TOKEN`.

### 3. Verify

The run log prints `🔑 Owner-specific tokens: joyhub2990` at startup. Forks under that owner then use the organization token for `getUpstream`, compare, `merge-upstream`, PRs and labels; every other fork keeps using `PAT_TOKEN`. The fork list (`/user/repos`) is always fetched with the main token, and reading a public upstream works with either token because fine-grained tokens include read-only access to all public repositories.

### Adding more owners

Add another secret as an env var in `.github/workflows/sync-forks.yml` (e.g. `PAT_TOKEN_ORG2: ${{ secrets.PAT_TOKEN_ORG2 }}`), then set the repository variable `OWNER_TOKENS` to override the default:

```
{"JoyHub2990":"PAT_TOKEN_ORG","GlossMod":"PAT_TOKEN_ORG2"}
```

Missing or invalid configuration only prints a warning — the run falls back to `PAT_TOKEN` instead of failing.

---

## Only Syncing Specific Repos

Fill `only_repos` to sync just the forks you name, instead of all of them:

```
langchain,my-org/private-fork,my-fork
```

- `repo-name` matches a fork with that name under any owner; `owner/repo-name` matches exactly.
- Leave it empty to sync every fork (default, including scheduled runs).
- `exclude_repos` and `PERMANENT_EXCLUDES` still take priority, so permanently excluded repos are never synced even if listed here.
- Names with no matching fork are reported in the log as `No matching fork for: ...`.

---

## Excluding Repos Permanently

Some forks you've heavily modified (e.g. a white-labeled product) should never be auto-synced.

Edit the `PERMANENT_EXCLUDES` line in `.github/workflows/sync-forks.yml`:

```yaml
PERMANENT_EXCLUDES: "repo-name-1,repo-name-2"
```

These will be skipped on every run, both scheduled and manual.

---

## Output Example

```
╔════════════════════════════════════════╗
║        fork-manager by ModelNorth       ║
╚════════════════════════════════════════╝

Legend: ✅ synced  🔀 PR created  🔁 PR already open  ➖ up to date
        ⏫ ahead only  🛑 unexpected merge  ⚠️  merge conflict  🚧 workflow blocked
        🟣 merged (legacy mode)  💥 conflicting PR  ⏭  excluded/skipped  ❌ error

📡 Fetching all forks...
📋 Found 47 fork(s)

✅ [SYNCED] yourname/langchain — Successfully fetched and fast-forwarded from upstream langchain-ai:main.
➖ [UP TO DATE] yourname/repo-name-1 — already at upstream-owner:main
⏫ [AHEAD ONLY] yourname/repo-name-2 — fork has own commits, nothing to pull
🔀 [DIVERGED]   yourname/YimMenuV2 — own commits found, no automatic merge (YimMenu:enhanced)
🔀 [PR CREATED]  yourname/YimMenuV2 — #12 https://github.com/yourname/YimMenuV2/pull/12
🔁 [PR EXISTS]   yourname/custom-fork — #3 https://github.com/yourname/custom-fork/pull/3
⏭  [EXCLUDED]   yourname/repo-name
⏭  [SKIPPED]    yourname/no-upstream — Validation Failed

╔════════════════════════════════════════╗
║              SYNC SUMMARY               ║
╚════════════════════════════════════════╝
✅ Synced:              12
🔀 PR created:          1
🔁 PR already open:     1
➖ Up to date:         30
⏫ Ahead (nothing):     1
🛑 Unexpected merges:   0
⚠️  Merge conflicts:     0
⏭  Excluded:            1
⏭  API skipped:         1
❌ Errors:              0
─────────────────────────────────────────
📦 Repos processed:     47
📦 Branches processed:  47

⏭  Branches skipped by the API (no action was taken — inspect these):
   • no-upstream
```

---

## License

MIT — use freely, contributions welcome.

