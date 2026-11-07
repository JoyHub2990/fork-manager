# 🔄 fork-manager

> One-tap sync for all your GitHub forks. Built by [ModelNorth](https://modelnorth.com).

Keep every fork in your GitHub account up to date with its upstream — automatically on a schedule, or manually with a single button click.

---

## How It Works

1. GitHub Actions fetches a list of **all your forked repos**
2. For each fork, it reads the parent's default branch and **compares** it with the fork's default branch
3. `identical`, or the fork is simply ahead → nothing to do
4. `ahead` (fork has no own commits) → fast-forward via the `merge-upstream` API
5. `diverged` (fork has its own commits) → **no automatic merge**. A pull request is created instead so you can review and merge manually; an existing open PR is reused
6. A summary using a distinct symbol for each result type is printed at the end

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
  - `Workflows` → Read and Write (optional; allows a fast-forward to include `.github/workflows/*` changes)
  - `Actions` → Read and Write
  - `Metadata` → Read only

### 3. Add the token as a secret

Go to this repo → **Settings → Secrets and variables → Actions → New repository secret**

- Name: `PAT_TOKEN`
- Value: your token from step 2

### 4. You're done

The workflow runs **every day at 09:00 UTC** automatically.

---

## Manual Trigger

Go to **Actions → 🔄 Sync All Forks → Run workflow**

You'll get four options:

| Option | Description |
|--------|-------------|
| `dry_run` | Read-only preview: shows what would be synced or turned into a PR |
| `force_sync` | No effect — kept for compatibility, forks are never force-overwritten |
| `exclude_repos` | Comma-separated list of repo names to skip this run |
| `only_repos` | Comma-separated list of repos to sync (empty = all forks) |

---

## Why Diverged Forks Get a PR

If a fork's default branch has its own commits, GitHub's `merge-upstream` API would silently create a merge commit on that branch. fork-manager never lets that happen:

1. `GET /repos/{owner}/{repo}/compare/{forkBranch}...{upstreamOwner}:{upstreamBranch}` determines the branch relationship
2. Only when the result is `ahead` (no own commits) is `merge-upstream` called
3. When the result is `diverged`, the script skips `merge-upstream` and opens `POST /repos/{owner}/{repo}/pulls` with `head: "upstreamOwner:branch"` and `base: forkBranch`
4. An existing open PR with the same head/base is reused, so repeated runs do not pile up PRs

Your commits are never overwritten and never merged automatically — you decide in the PR.

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
| `⚠️ [CONFLICT]` | Real merge conflict (HTTP 409); a PR is created for manual resolution |
| `🚧 [BLOCKED]` | Fast-forward refused because the PAT cannot push workflow files; falls back to a PR |
| `⏭ [EXCLUDED]` | Explicitly excluded via `exclude_repos` / `PERMANENT_EXCLUDES` |
| `⏭ [SKIPPED]` | API returned 422 or an unknown compare status — no action taken; listed at the end of the log |
| `❌ [ERROR]` | API error |
| `🔍 [WOULD SYNC]` / `[WOULD PR]` | Dry-run preview |

---

## Troubleshooting

### `❌ HTTP 403: Resource not accessible by personal access token` when creating a PR

The token can read the fork but cannot open pull requests on it. Grant **`Pull requests` → Read and Write** (and keep `Contents` → Read and Write). For a classic PAT, make sure the `repo` / `public_repo` scopes are enabled. Fine-grained token permission changes take effect immediately; a classic token must be regenerated and the `PAT_TOKEN` secret updated.

### `⏭ ... refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`

A fast-forward would write `.github/workflows/*` files, which GitHub blocks for tokens without workflow permission. Either grant **`Workflows` → Read and Write** (fine-grained) / the `workflow` scope (classic PAT), or leave it as-is: fork-manager logs `🚧 [BLOCKED]` and opens a pull request instead, which does not push workflow files.

### `❌ HTTP 403` on organization-owned forks

A fine-grained PAT only covers repositories its owner can administer. Forks under other organizations can be returned by `/user/repos` yet still reject writes with 403. Exclude them with `exclude_repos` or `PERMANENT_EXCLUDES`.

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
        ⏭  excluded/skipped  ❌ error

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
📦 Total processed:     47

⏭  Repos skipped by the API (no action was taken — inspect these):
   • no-upstream
```

---

## License

MIT — use freely, contributions welcome.

