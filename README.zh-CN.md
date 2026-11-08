# 🔄 fork-manager

**语言 / Language**: 简体中文 · [切换到 English](README.md)

> 一键同步你 GitHub 账号下的所有 fork 仓库。由 [ModelNorth](https://modelnorth.com) 构建，由 [lucienlmy](https://github.com/lucienlmy) 维护。

让每个 fork 都与它的上游保持同步 —— 既可以定时自动运行，也可以点一下按钮手动运行。

---

## 目录

- [工作原理](#工作原理)
- [安装配置](#安装配置)
- [定时运行](#定时运行)
- [手动运行](#手动运行)
- [分支同步开关](#分支同步开关)
- [为什么分叉仓库要建拉取请求](#为什么分叉仓库要建拉取请求)
- [旧版强制同步模式](#旧版强制同步模式)
- [日志符号](#日志符号)
- [默认分支与额外分支](#默认分支与额外分支)
- [故障排查](#故障排查)
- [组织仓库同步](#组织仓库同步)
- [只同步指定仓库](#只同步指定仓库)
- [永久排除仓库](#永久排除仓库)
- [输出示例](#输出示例)
- [许可证](#许可证)

---

## 工作原理

1. GitHub Actions 拉取**你账号下所有 fork 仓库**的列表
2. 对每个 fork 构建待处理的分支：默认分支对，以及在 fork 和上游中**同名**的所有额外分支
3. 每个分支都用同一套规则与上游对应分支**比较**
4. `identical`，或 fork 仅领先于上游 → 无需处理
5. `ahead`（fork 没有自己的提交）→ 通过 `merge-upstream` API 快进
6. `diverged`（fork 有自己的提交）→ **不自动合并**，改为创建拉取请求供你审阅后手动合并；已存在的开放 PR 会被复用
7. 结尾输出汇总，每种结果用不同符号标识

全部在 GitHub 服务端运行 —— 无需本地克隆，也不需要在你机器上执行 git 命令。

---

## 安装配置

### 1. 复刻或克隆本仓库

### 2. 创建个人访问令牌（PAT）

进入 **GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens**

- 名称：`fork-manager-token`
- 仓库访问权限：**All repositories**
- 权限：
  - `Contents` → Read and Write
  - `Pull requests` → Read and Write（为分叉的仓库创建 PR 所需）
  - `Issues` → Read and Write（可选；用于给冲突 PR 添加 `merge-conflict` 标签）
  - `Workflows` → Read and Write（可选；允许快进时包含 `.github/workflows/*` 改动）
  - `Actions` → Read and Write
  - `Metadata` → Read only

### 3. 把令牌添加为 Secret

进入本仓库 → **Settings → Secrets and variables → Actions → New repository secret**

- Name：`PAT_TOKEN`
- Value：第 2 步得到的令牌

如果组织下也有 fork，需要再建一个以该组织为 Resource owner 的细粒度令牌，并添加为另一个 secret —— 参见[组织仓库同步](#组织仓库同步)。

### 4. 完成

工作流会在**每天 UTC 09:00（北京时间 17:00）**自动运行 —— 详见[定时运行](#定时运行)。

额外分支同步默认开启。若想退回只同步默认分支，参见[分支同步开关](#分支同步开关)。

---

## 定时运行

定时配置位于 `.github/workflows/sync-forks.yml`：

```yaml
on:
  schedule:
    - cron: "0 9 * * *"
```

- `0 9 * * *` 表示**每天 UTC 09:00**，包含周末。GitHub 始终按 UTC 解释 cron，不跟随账号时区，因此 UTC+8 对应**北京时间 17:00**。
- GitHub 执行的是仓库**默认分支**上的工作流文件。修改工作流后需推送到该分支才会生效。
- 这是最早触发时间，并非精确保证：高峰期定时任务会排队，通常晚几分钟启动，偶尔更久。
- 在 `schedule` 事件下，所有 `workflow_dispatch` 输入都为空：`dry_run` 和 `force_sync` 均为 `false`，`only_repos` / `exclude_repos` 为空，因此该次运行会对全部 fork 执行真实写操作，并走常规 PR 流程。
- 仓库连续 60 天无活动时，GitHub 可能停用定时任务；若不再出现运行记录，可在 Actions 页面重新启用。
- 要改时间只能修改 `cron` 行 —— `on:` 中无法读取 `vars.*` 或 `inputs.*`。如果希望在网页端调整时间，替代方案是「固定高频 cron + 运行时门控 + 仓库变量」。

---

## 手动运行

进入 **Actions → 🔄 Sync All Forks → Run workflow**

有四个选项：

| 选项 | 说明 |
|------|------|
| `dry_run` | 只读预览：显示哪些仓库会被同步或转为 PR，不做任何改动 |
| `force_sync` | 旧模式：跳过比较和 PR，直接对每个 fork 调用 `merge-upstream` —— GitHub 可能自动合并已分叉的仓库。不勾选（默认）则走 PR 流程 |
| `exclude_repos` | 本次运行要跳过的仓库名，逗号分隔 |
| `only_repos` | 只同步这些仓库，逗号分隔（留空 = 全部 fork） |

手动运行的注意事项：

- **Use workflow from** 下拉框决定执行**哪个分支上的** `sync-forks.yml` **和** `sync.js`。请使用默认分支，或已包含最新改动的分支 —— 旧分支若没有 `SYNC_ALL_BRANCHES` 这行 env 配置，会忽略该变量并始终开启额外分支。
- 仓库变量是仓库级的，所有分支共用，不需要按分支分别设置。
- `SYNC_ALL_BRANCHES` 对手动运行和定时运行同样生效，因为 `vars.*` 在作业启动时求值，与触发方式无关。参见[分支同步开关](#分支同步开关)。
- 没有针对单次运行的覆盖选项：上面四个输入就是全部手动选项。修改变量会影响之后所有运行，若只是临时测试，测完记得改回来。
- `only_repos` 按**仓库**过滤，不按分支过滤。即使只选了一个仓库，开关开启时它的所有匹配的额外分支仍会被处理；没有「只跑 `dev` 分支」的选项。
- 建议的首次测试：`only_repos` 填一个仓库并勾选 `dry_run`。不会产生任何写入；通过日志开头的 `Extra branches: enabled/disabled` 行和结尾的 `📦 Branches processed` 数量确认开关是否生效。

---

## 分支同步开关

`SYNC_ALL_BRANCHES` 是可选的仓库变量，用于控制是否同步额外（非默认）分支。**默认开启**；设为 `false` 即退回只同步默认分支。两类分支的含义见[默认分支与额外分支](#默认分支与额外分支)。

### 在哪里设置

要设在**运行工作流的那个仓库**（即本 `fork-manager` 仓库），而不是每个 fork 仓库上 —— `vars.*` 读取的是作业所在仓库的配置。

1. 打开 `fork-manager` 仓库 → **Settings**（仓库的标签页，不是个人设置）。
2. 左侧栏 → **Secrets and variables → Actions**。
3. 选择 **Variables** 标签页（不是 `Secrets`）。
4. 点击 **New repository variable**。
5. Name 填 `SYNC_ALL_BRANCHES`，Value 填 `false` → **Add variable**。

需要该仓库的管理 / 设置权限。组织级同名变量也可用，但仓库级的值优先。

### 变量如何生效

```yaml
SYNC_ALL_BRANCHES: ${{ vars.SYNC_ALL_BRANCHES || 'true' }}
```

- 在作业启动时求值，对**定时和手动**运行都生效；它不是 `workflow_dispatch` 输入。
- 变量不存在时，`|| 'true'` 使额外分支同步保持开启。
- 只有精确的小写字符串 `false` 能关闭它。`FALSE`、`False` 或空值都视为开启。
- 脚本中的判断为 `process.env.SYNC_ALL_BRANCHES !== "false"`。

| 取值 | 行为 |
|------|------|
| 未设置 / `true` / 其它值 | 默认分支 + 所有同名额外分支 |
| `false` | 仅默认分支 |

### 验证与恢复

- **下一次运行**即生效 —— 无需改 YAML、无需推送、无需重新部署。
- 日志开头会打印 `Extra branches: enabled (same-name branches only)` 或 `Extra branches: disabled (default branch only)`。
- 汇总里会打印 `📦 Repos processed` 和 `📦 Branches processed`；开关关闭时，每个仓库最多计入一个分支。
- 恢复开启：把值改成 `true`，或直接删除该变量。

---

## 为什么分叉仓库要建拉取请求

如果 fork 的默认分支上有自己的提交，GitHub 的 `merge-upstream` API 会在该分支上悄悄生成合并提交。fork-manager 不允许这种情况发生：

1. `GET /repos/{owner}/{repo}/compare/{forkBranch}...{upstreamOwner}:{upstreamBranch}` 判断分支关系
2. 只有结果为 `ahead`（没有自己的提交）时才调用 `merge-upstream`
3. 结果为 `diverged` 时，脚本跳过 `merge-upstream`，改用 `POST /repos/{owner}/{repo}/pulls`，其中 `head: "upstreamOwner:branch"`、`base: forkBranch`
4. 复用 head/base 相同的已开放 PR，避免重复运行堆积 PR

你的提交永远不会被覆盖，也不会被自动合并 —— 由你在 PR 中决定。

PR 创建（或复用已有 PR）后，fork-manager 会轮询 `GET /repos/{owner}/{repo}/pulls/{number}` 读取 `mergeable`。`mergeable: false` / `mergeable_state: "dirty"` 的 PR 会记为 `💥 [PR CONFLICT]`，在运行结尾列出，并在 PAT 权限允许时打上 `merge-conflict` 标签。GitHub 异步计算 `mergeable`，因此最多检查 3 次（间隔 2 秒）；若始终为 `unknown`，则不报告冲突。

---

## 旧版强制同步模式

勾选 `force_sync` 会恢复到 PR 流程出现之前的行为：

1. 不调用 `compare`、不创建 PR —— 每个 fork 直接走 `POST /repos/{owner}/{repo}/merge-upstream`
2. 由 GitHub 决定：快进、`Successfully fetched and merged ...`（在已分叉的 fork 上生成真实合并提交），或 HTTP 409
3. 409 记为 `⚠️ [CONFLICT]`，但**不创建 PR**；422 记为 `⏭ [SKIPPED]`
4. 以这种方式完成的合并记为 `🟣 [MERGED]`，计入 `Merged (auto)`

虽然名字叫「强制」，这个模式并不会强制覆盖或丢弃你的提交 —— 它只是移除了阻止 GitHub 自动合并的预检查。两个选项同时勾选时，`dry_run` 优先。

---

## 日志符号

| 符号 | 含义 |
|------|------|
| `✅ [SYNCED]` | 没有自己的提交；分支已快进 |
| `🔀 [PR CREATED]` | 已分叉；创建了拉取请求，未自动合并 |
| `🔁 [PR EXISTS]` | 已分叉；复用了已存在的开放 PR |
| `➖ [UP TO DATE]` | 与上游完全一致 |
| `⏫ [AHEAD ONLY]` | fork 有自己的提交，但上游没有新内容可拉 |
| `🛑 [AUTO MERGE]` | 异常：预检查后 GitHub 仍然执行了合并 —— 请手动检查 |
| `🟣 [MERGED]` | 旧模式：GitHub 把上游改动自动合并进了已分叉的 fork |
| `💥 [PR CONFLICT]` | PR 已创建/复用但 `mergeable: false` —— 需手动解决；PAT 权限允许时会加 `merge-conflict` 标签 |
| `⚠️ [CONFLICT]` | 真实合并冲突（HTTP 409）；会创建 PR 供手动解决 |
| `🚧 [BLOCKED]` | PAT 无法推送工作流文件导致快进被拒；回退为创建 PR |
| `⏭ [EXCLUDED]` | 被 `exclude_repos` / `PERMANENT_EXCLUDES` 明确排除 |
| `⏭ [SKIPPED]` | API 返回 422 或未知的 compare 状态 —— 未执行任何操作；会在日志结尾列出 |
| `❌ [ERROR]` | API 错误 |
| `🔍 [WOULD SYNC]` / `[WOULD PR]` | 干跑预览 |

额外分支显示为 `owner/repo@branch`；默认分支仍显示 `owner/repo`。

---

## 默认分支与额外分支

每个 fork 有一个**默认分支**（主分支，取自 `fork.default_branch`），以及可能有若干个**额外分支**（其余所有分支，也称副分支）。两者走完全相同的同步逻辑，但发现方式不同。

| | 默认分支（主分支） | 额外分支（副分支） |
|---|---|---|
| 如何选取 | 始终包含，每个 fork 一个 | 在 fork 与上游的分支列表中取**精确同名**的分支 |
| 是否要求与上游同名 | 否 —— fork 的 `main` ↔ 上游 `enhanced` 也可以 | 是 —— 只处理 `dev` ↔ `dev`；不做映射、不猜测 |
| 只存在于一侧 | 仍会处理，使用 `parent.default_branch` | 忽略 —— fork 独有和上游独有的分支都跳过；上游独有的分支不会在 fork 中自动创建 |
| 日志标识 | `owner/repo` | `owner/repo@branch` |
| 同步规则 | compare → 快进 / 建 PR / 跳过 | 与默认分支**完全相同** |
| `SYNC_ALL_BRANCHES=false` | 仍然同步 | 全部跳过 |

其它细节：

- 没有共同祖先的分支会被跳过，而不是记为错误。
- 每个额外分支都遵循与默认分支相同的规则：能干净快进的直接同步（不建 PR），分叉的建 PR，冲突 PR 打标签。
- 若 `merge-upstream` 拒绝某个额外分支，脚本会回退为创建 PR，而不是跳过。
- 开启额外分支会给每个仓库增加两次分支列表调用，并为每个匹配的分支增加一次 compare（以及可能的 PR 调用）；请求有限流，因此全量运行耗时更长。设置 `SYNC_ALL_BRANCHES=false` 可退回只同步默认分支 —— 参见[分支同步开关](#分支同步开关)。

---

## 故障排查

### 创建 PR 时出现 `❌ HTTP 403: Resource not accessible by personal access token`

令牌能读取该 fork，但无权在其上创建 PR。请授予 **`Pull requests` → Read and Write**（并保持 `Contents` → Read and Write）。经典 PAT 需确保启用 `repo` / `public_repo` scope。细粒度令牌的权限变更立即生效；经典令牌需要重新生成并更新 `PAT_TOKEN` secret。

### `⏭ ... refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`

快进会写入 `.github/workflows/*` 文件，GitHub 会阻止没有工作流权限的令牌。可以授予 **`Workflows` → Read and Write**（细粒度）/ `workflow` scope（经典 PAT）；也可以保持现状：fork-manager 会记录 `🚧 [BLOCKED]` 并改为创建 PR，这不会推送工作流文件。

### 组织所属 fork 上出现 `❌ HTTP 403`

细粒度 PAT 只能绑定一个 Resource owner。其他 owner 下的 fork 可能出现在 `/user/repos` 结果里，但写入时仍返回 403。可以添加一个按 owner 生效的令牌（参见[组织仓库同步](#组织仓库同步)）、改用权限面更大的 classic PAT，或用 `exclude_repos` / `PERMANENT_EXCLUDES` 排除它们。

---

## 组织仓库同步

细粒度 PAT 只能访问创建时选定的**那一个** Resource owner 名下的资源。如果你的 fork 分散在多个 owner 下（例如个人账号 `lucienlmy` 和组织 `JoyHub2990`），另一个 owner 下的 fork 会出现在 `/user/repos` 里，但每次写入都会报 `HTTP 403: Resource not accessible by personal access token`。解决办法是给每个 owner 各配一个令牌：脚本按 fork 的 owner 自动选择，不需要搬迁任何仓库，workflow 也留在原处。

### 1. 创建第二个细粒度令牌

进入 **GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens → Generate new token**：

- Resource owner：选**那个组织**（例如 `JoyHub2990`）
- Repository access：`All repositories`（该组织下全部）或 `Only select repositories`
- 权限与主令牌相同：`Contents` RW、`Pull requests` RW、`Issues` RW（用于 `merge-conflict` 标签）、`Actions` RW、`Workflows` RW、`Metadata` RO
- 设置过期时间

如果你是该组织的 owner，审批会自动通过；否则需要组织管理员批准。若组织禁用了细粒度令牌，需在组织的 personal access token 策略里放行。

### 2. 添加为 Secret

在本仓库 → **Settings → Secrets and variables → Actions → New repository secret**：

- Name：`PAT_TOKEN_ORG`
- Value：组织令牌

workflow 已经把它作为环境变量传入，并带有一个默认映射：

```yaml
PAT_TOKEN_ORG: ${{ secrets.PAT_TOKEN_ORG }}
OWNER_TOKENS: ${{ vars.OWNER_TOKENS || '{"JoyHub2990":"PAT_TOKEN_ORG"}' }}
```

`OWNER_TOKENS` 是一个 JSON 对象，把 owner 名映射到**存放令牌的环境变量名**，而不是令牌值本身，因此可以安全地放在 Repository variable 里。匹配不区分大小写；未列出的 owner 使用 `PAT_TOKEN`。

### 3. 验证

运行日志开头会打印 `🔑 Owner-specific tokens: joyhub2990`。该 owner 下的 fork 随后会用组织令牌执行 `getUpstream`、compare、`merge-upstream`、PR 和标签操作；其余 fork 仍用 `PAT_TOKEN`。fork 列表（`/user/repos`）始终用主令牌获取；读取公开上游仓库用哪个令牌都可以，因为细粒度令牌自带对所有公开仓库的只读权限。

### 添加更多 owner

在 `.github/workflows/sync-forks.yml` 的 env 里再加一行（例如 `PAT_TOKEN_ORG2: ${{ secrets.PAT_TOKEN_ORG2 }}`），然后设置 Repository variable `OWNER_TOKENS` 覆盖默认值：

```
{"JoyHub2990":"PAT_TOKEN_ORG","GlossMod":"PAT_TOKEN_ORG2"}
```

配置缺失或 JSON 写错只会打印警告，运行会回退到 `PAT_TOKEN`，不会中断。

---

## 只同步指定仓库

在 `only_repos` 中填写要同步的 fork，而不是全部：

```
langchain,my-org/private-fork,my-fork
```

- `repo-name` 匹配任意拥有者下同名的 fork；`owner/repo-name` 精确匹配。
- 留空则同步所有 fork（默认，定时运行也是如此）。
- `exclude_repos` 和 `PERMANENT_EXCLUDES` 优先级更高，因此被永久排除的仓库即使列在这里也不会同步。
- 没有匹配到 fork 的名称会在日志中记为 `No matching fork for: ...`。

---

## 永久排除仓库

某些被大幅修改过的 fork（例如做了贴牌改造的产品）永远不应自动同步。

编辑 `.github/workflows/sync-forks.yml` 中的 `PERMANENT_EXCLUDES` 行：

```yaml
PERMANENT_EXCLUDES: "repo-name-1,repo-name-2"
```

这些仓库在每次运行中都会被跳过，定时和手动运行都一样。

---

## 输出示例

以下为程序原始输出，保持英文原样：

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

## 许可证

MIT —— 可自由使用，欢迎贡献。
