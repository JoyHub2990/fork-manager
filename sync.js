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
  if (res.status !== 200) throw new Error(`Failed to list pull requests: HTTP ${res.status} ${res.body?.message || ""}`);
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
    console.log(`⏭  [SKIPPED]    ${ownerLogin}/${repoName} — ${res.body?.message || "PR could not be created"}`);
    results.skipped.push(repoName);
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
  if (FORCE_SYNC) console.log("⚡ force_sync is set but has no effect — forks are never force-overwritten\n");
  if (ONLY_LIST.length > 0) console.log(`🎯 Only syncing: ${ONLY_LIST.join(", ")}\n`);
  if (EXCLUDE_LIST.length > 0) console.log(`🚫 Excluded: ${EXCLUDE_LIST.join(", ")}\n`);
  console.log("Legend: ⏩ fast-forward  🔀 PR created  🔁 PR already open  ✅ up to date");
  console.log("        ⏫ ahead only  🛑 unexpected merge  ⚠️  merge conflict  ⏭  skipped  ❌ error\n");

  console.log("📡 Fetching all forks...");
  const allForks = await getAllForks();
  console.log(`✅ Found ${allForks.length} fork(s)\n`);

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
    fastForwarded: [], upToDate: [], aheadOnly: [], prCreated: [], prExisting: [],
    unexpectedMerges: [], conflicts: [], skipped: [], errors: [],
    plannedSync: [], plannedPr: [],
  };

  for (const fork of forks) {
    const { name: repoName, owner: { login: ownerLogin }, default_branch: forkBranch } = fork;
    const repoLabel = `${ownerLogin}/${repoName}`;

    if (EXCLUDE_LIST.some((entry) => matchesRepo(entry, repoName, ownerLogin))) {
      console.log(`⏭  [EXCLUDED]   ${repoLabel}`);
      results.skipped.push(repoName);
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
        console.log(`✅ [UP TO DATE] ${repoLabel} — already at ${head}`);
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
            console.log(`✅ [UP TO DATE] ${repoLabel} — ${msg}`);
            results.upToDate.push(repoName);
          } else if (mergeType === "merge") {
            console.log(`🛑 [AUTO MERGE] ${repoLabel} — merged despite pre-check: ${msg}`);
            results.unexpectedMerges.push(repoName);
          } else {
            console.log(`⏩ [FAST-FORWARD] ${repoLabel} — ${msg}`);
            results.fastForwarded.push(repoName);
          }
        } else if (res.status === 409) {
          console.log(`⚠️  [CONFLICT]   ${repoLabel} — merge conflict, falling back to a pull request`);
          await ensurePullRequest(ownerLogin, repoName, forkBranch, head, results, results.conflicts);
        } else if (res.status === 422) {
          console.log(`⏭  [SKIPPED]    ${repoLabel} — ${res.body?.message || ""}`);
          results.skipped.push(repoName);
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
    console.log(`🔍 Would fast-forward:  ${results.plannedSync.length}`);
    console.log(`🔍 Would create PR:     ${results.plannedPr.length}`);
    console.log(`✅ Would be unchanged:  ${results.upToDate.length}`);
  } else {
    console.log(`⏩ Fast-forwarded:      ${results.fastForwarded.length}`);
    console.log(`🔀 PR created:          ${results.prCreated.length}`);
    console.log(`🔁 PR already open:     ${results.prExisting.length}`);
    console.log(`✅ Up to date:          ${results.upToDate.length}`);
    console.log(`⏫ Ahead (nothing):     ${results.aheadOnly.length}`);
    console.log(`🛑 Unexpected merges:   ${results.unexpectedMerges.length}`);
    console.log(`⚠️  Merge conflicts:     ${results.conflicts.length}`);
  }
  console.log(`⏭  Skipped/excluded:    ${results.skipped.length}`);
  console.log(`❌ Errors:              ${results.errors.length}`);
  console.log(`─────────────────────────────────────────`);
  console.log(`📦 Total processed:     ${forks.length}`);

  if (results.unexpectedMerges.length > 0) {
    console.log(`\n🛑 Repos GitHub merged automatically despite the pre-check (inspect these):`);
    results.unexpectedMerges.forEach((r) => console.log(`   • ${r}`));
  }
  if (results.conflicts.length > 0) {
    console.log(`\n⚠️  Repos with a real merge conflict (a PR was created for manual resolution):`);
    results.conflicts.forEach((r) => console.log(`   • ${r}`));
  }
  if (results.errors.length > 0) {
    console.log(`\n❌ Failed repos:`);
    results.errors.forEach((r) => console.log(`   • ${r}`));
    process.exit(1);
  }
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
