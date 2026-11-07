const https = require("https");

const TOKEN = process.env.PAT_TOKEN;
const DRY_RUN = process.env.DRY_RUN === "true";
const FORCE_SYNC = process.env.FORCE_SYNC === "true";

function parseRepoList(value) {
  return (value || "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

function matchesRepo(entry, repoName, ownerLogin) {
  const parts = entry.split("/");
  const name = (parts.length > 1 ? parts[1] : parts[0]).trim();
  const owner = parts.length > 1 ? parts[0].trim() : null;
  return name === repoName.toLowerCase() && (owner === null || owner === ownerLogin.toLowerCase());
}

const ONLY_LIST = parseRepoList(process.env.ONLY_REPOS);
const EXCLUDE_LIST = parseRepoList(process.env.EXCLUDE_REPOS);

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "User-Agent": "fork-manager-bot",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getAllForks() {
  let page = 1;
  let forks = [];
  while (true) {
    const res = await apiRequest("GET", `/user/repos?type=fork&per_page=100&page=${page}`);
    if (res.status !== 200) throw new Error(`Failed to fetch repos: ${JSON.stringify(res.body)}`);
    const batch = res.body;
    if (!batch.length) break;
    forks = forks.concat(batch);
    if (batch.length < 100) break;
    page++;
  }
  return forks;
}

async function syncFork(owner, repo, defaultBranch) {
  return await apiRequest("POST", `/repos/${owner}/${repo}/merge-upstream`, { branch: defaultBranch });
}

async function getUpstream(fork) {
  let repo = fork;
  if (!repo.parent || !repo.parent.owner || !repo.parent.default_branch) {
    const res = await apiRequest("GET", `/repos/${fork.owner.login}/${fork.name}`);
    if (res.status !== 200) throw new Error(`Failed to fetch repo: HTTP ${res.status} ${res.body?.message || ""}`);
    repo = res.body;
  }
  const parent = repo.parent;
  if (!parent || !parent.owner || !parent.owner.login || !parent.default_branch) {
    throw new Error("No upstream (parent) information available");
  }
  return { owner: parent.owner.login, branch: parent.default_branch };
}

async function compareWithUpstream(ownerLogin, repoName, forkBranch, upstream) {
  const head = `${upstream.owner}:${upstream.branch}`;
  const path = `/repos/${ownerLogin}/${repoName}/compare/${encodeURIComponent(forkBranch)}...${encodeURIComponent(upstream.owner)}:${encodeURIComponent(upstream.branch)}`;
  const res = await apiRequest("GET", path);
  if (res.status !== 200) {
    throw new Error(`compare failed: HTTP ${res.status} ${res.body?.message || ""}`);
  }
  return { status: res.body.status, head };
}

async function findOpenPull(ownerLogin, repoName, forkBranch, head) {
  const path = `/repos/${ownerLogin}/${repoName}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(forkBranch)}&per_page=1`;
  const res = await apiRequest("GET", path);
  if (res.status !== 200) {
    throw new Error(`Failed to list pull requests: HTTP ${res.status} ${res.body?.message || ""} (check "Pull requests: read" on the PAT)`);
  }
  return Array.isArray(res.body) && res.body.length > 0 ? res.body[0] : null;
}

async function createPull(ownerLogin, repoName, forkBranch, head) {
  const title = `[fork-manager] Sync ${forkBranch} from ${head}`;
  const body = [
    `Bring upstream changes from \`${head}\` into \`${forkBranch}\`.`,
    "",
    "The default branch of this fork has its own commits, so fork-manager did not merge automatically.",
    "Review the changes and merge this PR manually, or close it to leave the fork untouched.",
    "",
    "Created automatically by fork-manager.",
  ].join("\n");
  return await apiRequest("POST", `/repos/${ownerLogin}/${repoName}/pulls`, {
    head,
    base: forkBranch,
    title,
    body,
    maintainer_can_modify: false,
  });
}

async function ensurePullRequest(ownerLogin, repoName, forkBranch, head, results, overrideBucket = null) {
  const existing = await findOpenPull(ownerLogin, repoName, forkBranch, head);
  if (existing) {
    console.log(`🔁 [PR EXISTS]   ${ownerLogin}/${repoName} — #${existing.number} ${existing.html_url}`);
    (overrideBucket || results.prExisting).push(repoName);
    return;
  }
  const res = await createPull(ownerLogin, repoName, forkBranch, head);
  if (res.status === 201) {
    console.log(`🔀 [PR CREATED]  ${ownerLogin}/${repoName} — #${res.body.number} ${res.body.html_url}`);
    (overrideBucket || results.prCreated).push(repoName);
  } else if (res.status === 422) {
    const msg = res.body?.message || "PR could not be created";
    if (/already exists/i.test(msg)) {
      const pr = await findOpenPull(ownerLogin, repoName, forkBranch, head);
      if (pr) {
        console.log(`🔁 [PR EXISTS]   ${ownerLogin}/${repoName} — #${pr.number} ${pr.html_url}`);
        (overrideBucket || results.prExisting).push(repoName);
        return;
      }
    }
    console.log(`⏭  [SKIPPED]    ${ownerLogin}/${repoName} — ${msg}`);
    results.skipped.push(repoName);
  } else if (res.status === 403) {
    let hint = 'PAT lacks PR write access: fine-grained needs "Pull requests: Read and Write" + access to this repo; classic needs "repo" scope (regenerate token and update the PAT_TOKEN secret)';
    try {
      const check = await apiRequest("GET", `/repos/${ownerLogin}/${repoName}`);
      if (check.status === 200 && check.body?.permissions?.push === false) {
        hint = 'PAT has no push access to this repo — set Repository access to "All repositories" (or add this repo), then re-run';
      }
    } catch {}
    console.log(`❌ [ERROR]      ${ownerLogin}/${repoName} — HTTP 403: ${res.body?.message || ""} — ${hint}`);
    results.errors.push(repoName);
  } else {
    console.log(`❌ [ERROR]      ${ownerLogin}/${repoName} — HTTP ${res.status}: ${res.body?.message || ""}`);
    results.errors.push(repoName);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!TOKEN) { console.error("❌ PAT_TOKEN not set."); process.exit(1); }

  console.log("╔════════════════════════════════════════╗");
  console.log("║        fork-manager by ModelNorth       ║");
  console.log("╚════════════════════════════════════════╝\n");

  if (DRY_RUN) console.log("🔍 DRY RUN MODE — read-only, no merges and no PRs\n");
  if (FORCE_SYNC) {
    console.log("⚡ LEGACY MODE (force_sync) — direct merge-upstream for every fork; no compare, no PRs");
    console.log(DRY_RUN
      ? "   dry_run takes precedence — this run stays read-only\n"
      : "   GitHub may auto-merge diverged forks; 409 conflicts are reported but not turned into PRs\n");
  }
  if (ONLY_LIST.length > 0) console.log(`🎯 Only syncing: ${ONLY_LIST.join(", ")}\n`);
  if (EXCLUDE_LIST.length > 0) console.log(`🚫 Excluded: ${EXCLUDE_LIST.join(", ")}\n`);
  console.log("Legend: ✅ synced  🔀 PR created  🔁 PR already open  ➖ up to date");
  console.log("        ⏫ ahead only  🛑 unexpected merge  ⚠️  merge conflict  🚧 workflow blocked");
  console.log("        🟣 merged (legacy mode)  ⏭  excluded/skipped  ❌ error\n");

  console.log("📡 Fetching all forks...");
  const allForks = await getAllForks();
  console.log(`📋 Found ${allForks.length} fork(s)\n`);

  let forks = allForks;
  if (ONLY_LIST.length > 0) {
    forks = allForks.filter((fork) =>
      ONLY_LIST.some((entry) => matchesRepo(entry, fork.name, fork.owner.login))
    );
    const unmatched = ONLY_LIST.filter(
      (entry) => !forks.some((fork) => matchesRepo(entry, fork.name, fork.owner.login))
    );
    console.log(`🎯 Matched ${forks.length} specified fork(s)\n`);
    if (unmatched.length > 0) console.log(`⚠️  No matching fork for: ${unmatched.join(", ")}\n`);
  }

  if (forks.length === 0) {
    console.log(ONLY_LIST.length > 0
      ? "ℹ️  No matching forks. Nothing to sync."
      : "ℹ️  No forks found. Nothing to sync.");
    process.exit(0);
  }

  const results = {
    synced: [], upToDate: [], aheadOnly: [], prCreated: [], prExisting: [],
    unexpectedMerges: [], merged: [], conflicts: [], excluded: [], skipped: [], errors: [],
    plannedSync: [], plannedPr: [],
  };

  for (const fork of forks) {
    const { name: repoName, owner: { login: ownerLogin }, default_branch: forkBranch } = fork;
    const repoLabel = `${ownerLogin}/${repoName}`;

    if (EXCLUDE_LIST.some((entry) => matchesRepo(entry, repoName, ownerLogin))) {
      console.log(`⏭  [EXCLUDED]   ${repoLabel}`);
      results.excluded.push(repoName);
      await sleep(300);
      continue;
    }

    if (FORCE_SYNC && !DRY_RUN) {
      try {
        const res = await syncFork(ownerLogin, repoName, forkBranch);
        if (res.status === 200) {
          const msg = res.body.message || "";
          if (/not behind|already/i.test(msg)) {
            console.log(`➖ [UP TO DATE] ${repoLabel} — ${msg}`);
            results.upToDate.push(repoName);
          } else if (/fetched and merged/i.test(msg) || res.body.merge_type === "merge") {
            console.log(`🟣 [MERGED]     ${repoLabel} — ${msg}`);
            results.merged.push(repoName);
          } else {
            console.log(`✅ [SYNCED]     ${repoLabel} — ${msg}`);
            results.synced.push(repoName);
          }
        } else if (res.status === 409) {
          console.log(`⚠️  [CONFLICT]   ${repoLabel} — merge conflict (legacy mode, no PR created)`);
          results.conflicts.push(repoName);
        } else if (res.status === 422) {
          console.log(`⏭  [SKIPPED]    ${repoLabel} — ${res.body?.message || ""}`);
          results.skipped.push(repoName);
        } else {
          console.log(`❌ [ERROR]      ${repoLabel} — HTTP ${res.status}: ${res.body?.message || ""}`);
          results.errors.push(repoName);
        }
      } catch (err) {
        console.log(`❌ [ERROR]      ${repoLabel} — ${err.message}`);
        results.errors.push(repoName);
      }
      await sleep(300);
      continue;
    }

    try {
      const upstream = await getUpstream(fork);
      const head = `${upstream.owner}:${upstream.branch}`;
      const cmp = await compareWithUpstream(ownerLogin, repoName, forkBranch, upstream);

      if (DRY_RUN) {
        if (cmp.status === "ahead") {
          console.log(`🔍 [WOULD SYNC] ${repoLabel} — fast-forward from ${head}`);
          results.plannedSync.push(repoName);
        } else if (cmp.status === "diverged") {
          console.log(`🔍 [WOULD PR]   ${repoLabel} — create pull request from ${head}`);
          results.plannedPr.push(repoName);
        } else {
          console.log(`🔍 [UP TO DATE] ${repoLabel}`);
          results.upToDate.push(repoName);
        }
      } else if (cmp.status === "identical") {
        console.log(`➖ [UP TO DATE] ${repoLabel} — already at ${head}`);
        results.upToDate.push(repoName);
      } else if (cmp.status === "behind") {
        console.log(`⏫ [AHEAD ONLY] ${repoLabel} — fork has own commits, nothing to pull from ${head}`);
        results.aheadOnly.push(repoName);
      } else if (cmp.status === "ahead") {
        const res = await syncFork(ownerLogin, repoName, forkBranch);
        if (res.status === 200) {
          const msg = res.body.message || "";
          const mergeType = res.body.merge_type ||
            (/fetched and merged/i.test(msg) ? "merge" : /fast-forwarded/i.test(msg) ? "fast-forward" : "");
          if (/not behind|already/i.test(msg) || mergeType === "none") {
            console.log(`➖ [UP TO DATE] ${repoLabel} — ${msg}`);
            results.upToDate.push(repoName);
          } else if (mergeType === "merge") {
            console.log(`🛑 [AUTO MERGE] ${repoLabel} — merged despite pre-check: ${msg}`);
            results.unexpectedMerges.push(repoName);
          } else {
            console.log(`✅ [SYNCED]     ${repoLabel} — ${msg}`);
            results.synced.push(repoName);
          }
        } else if (res.status === 409) {
          console.log(`⚠️  [CONFLICT]   ${repoLabel} — merge conflict, falling back to a pull request`);
          await ensurePullRequest(ownerLogin, repoName, forkBranch, head, results, results.conflicts);
        } else if (res.status === 422) {
          const msg = res.body?.message || "";
          if (/workflow/i.test(msg)) {
            console.log(`🚧 [BLOCKED]    ${repoLabel} — PAT cannot push workflow files, falling back to a pull request`);
            await ensurePullRequest(ownerLogin, repoName, forkBranch, head, results);
          } else {
            console.log(`⏭  [SKIPPED]    ${repoLabel} — ${msg}`);
            results.skipped.push(repoName);
          }
        } else {
          console.log(`❌ [ERROR]      ${repoLabel} — HTTP ${res.status}: ${res.body?.message || ""}`);
          results.errors.push(repoName);
        }
      } else if (cmp.status === "diverged") {
        console.log(`🔀 [DIVERGED]   ${repoLabel} — own commits found, no automatic merge (${head})`);
        await ensurePullRequest(ownerLogin, repoName, forkBranch, head, results);
      } else {
        console.log(`⏭  [SKIPPED]    ${repoLabel} — unknown compare status: ${cmp.status}`);
        results.skipped.push(repoName);
      }
    } catch (err) {
      console.log(`❌ [ERROR]      ${repoLabel} — ${err.message}`);
      results.errors.push(repoName);
    }
    await sleep(300);
  }

  console.log("\n╔════════════════════════════════════════╗");
  console.log("║              SYNC SUMMARY               ║");
  console.log("╚════════════════════════════════════════╝");
  if (DRY_RUN) {
    console.log(`🔍 Would sync:          ${results.plannedSync.length}`);
    console.log(`🔍 Would create PR:     ${results.plannedPr.length}`);
    console.log(`➖ Would be unchanged:  ${results.upToDate.length}`);
  } else {
    console.log(`✅ Synced:              ${results.synced.length}`);
    console.log(`🔀 PR created:          ${results.prCreated.length}`);
    console.log(`🔁 PR already open:     ${results.prExisting.length}`);
    console.log(`➖ Up to date:          ${results.upToDate.length}`);
    console.log(`⏫ Ahead (nothing):     ${results.aheadOnly.length}`);
    console.log(`🛑 Unexpected merges:   ${results.unexpectedMerges.length}`);
    console.log(`⚠️  Merge conflicts:     ${results.conflicts.length}`);
    if (FORCE_SYNC) console.log(`🟣 Merged (auto):       ${results.merged.length}`);
  }
  console.log(`⏭  Excluded:            ${results.excluded.length}`);
  console.log(`⏭  API skipped:         ${results.skipped.length}`);
  console.log(`❌ Errors:              ${results.errors.length}`);
  console.log(`─────────────────────────────────────────`);
  console.log(`📦 Total processed:     ${forks.length}`);

  if (results.unexpectedMerges.length > 0) {
    console.log(`\n🛑 Repos GitHub merged automatically despite the pre-check (inspect these):`);
    results.unexpectedMerges.forEach((r) => console.log(`   • ${r}`));
  }
  if (results.conflicts.length > 0) {
    console.log(FORCE_SYNC
      ? `\n⚠️  Repos with a real merge conflict (legacy mode — resolve manually):`
      : `\n⚠️  Repos with a real merge conflict (a PR was created for manual resolution):`);
    results.conflicts.forEach((r) => console.log(`   • ${r}`));
  }
  if (results.skipped.length > 0) {
    console.log(`\n⏭  Repos skipped by the API (no action was taken — inspect these):`);
    results.skipped.forEach((r) => console.log(`   • ${r}`));
  }
  if (results.errors.length > 0) {
    console.log(`\n❌ Failed repos:`);
    results.errors.forEach((r) => console.log(`   • ${r}`));
    process.exit(1);
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
