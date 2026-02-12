# CPA Credential Batch Manager

用于批量检测与清理 CLIProxyAPI 凭证（`auths/*.json`）的开源命令行工具。

---

## 先直接用（推荐）

### 1) 克隆后立刻交互运行（云端 Git 凭证仓库）

```bash
git clone https://github.com/constansino/cliproxyapi-credential-batch-manager.git
cd cliproxyapi-credential-batch-manager

PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/constansino/conscliproxyapi \
  --git-token YOUR_GIT_TOKEN \
  --interactive \
  --report-file ./repo_report.json
```

### 2) 在上面基础上加 Telegram 推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/constansino/conscliproxyapi \
  --git-token YOUR_GIT_TOKEN \
  --interactive \
  --tg-bot-token YOUR_TG_BOT_TOKEN \
  --tg-chat-id YOUR_TG_CHAT_ID \
  --report-file ./repo_report.json
```

### 3) 在上面基础上改成定时巡检（每 30 分钟）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/constansino/conscliproxyapi \
  --git-token YOUR_GIT_TOKEN \
  --schedule-minutes 30 \
  --tg-bot-token YOUR_TG_BOT_TOKEN \
  --tg-chat-id YOUR_TG_CHAT_ID \
  --report-file ./repo_report.json
```

> 说明：
> - `--interactive` 适合人工值守。
> - `--schedule-minutes` 适合自动巡检。
> - 两者不能同时使用。

---

## 菜单交互版（最省心）

不想记参数，直接走菜单：

```bash
PYTHONPATH=src python3 -m cliproxy_credman --menu
```

菜单会逐步让你选择：
- repo / cpa / local 模式
- 是否启用 TG
- 单次运行还是定时运行
- 删除策略（不删 / 交互删 / 固定状态删）

---

## 核心能力

- 批量检测凭证状态（多 provider）
- 检测后交互式选择删除范围
- TG 推送统计摘要
- 分钟级定时巡检
- 支持三种数据来源：
  - Repository Mode（推荐，管理云端 Git 凭证仓库）
  - CPA API Mode（远程管理 CPA 当前加载凭证）
  - Local Directory Mode（本机目录）

---

## 模式说明

### 1) Repository Mode（推荐）
管理 Git 仓库中的凭证文件（适合集中管理“云端凭证仓库”）。

- 输入：`--repo-url` + `--git-token`
- 输出：检测报告；可按状态删除并执行 `git commit` / `git push`

### 2) CPA API Mode
通过 CPA 管理接口远程管理服务器当前加载的凭证。

- 输入：`--cpa-url` + `--management-key`
- 输出：检测报告；可按状态调用 CPA 删除凭证

### 3) Local Directory Mode
直接扫描当前机器目录。

- 输入：`--auth-dir`

---

## 常见命令

### Repository Mode

#### 仅检测

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --report-file ./repo_report.json
```

#### 非交互删除 + 推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --git-token YOUR_GIT_TOKEN \
  --delete-statuses invalidated,deactivated,expired_by_time,unauthorized \
  --git-commit \
  --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com" \
  --report-file ./repo_report.json
```

### CPA API Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --report-file ./cpa_report.json
```

### Local Directory Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./local_report.json
```

---

## 参数

- 输入模式：
  - `--repo-url` / `--repo-branch` / `--git-token` / `--git-token-user`
  - `--cpa-url` / `--management-key`
  - `--auth-dir`
- 执行控制：
  - `--interactive`
  - `--schedule-minutes`
  - `--workers`
  - `--timeout`
- 删除相关：
  - `--delete-statuses`
  - `--dry-run`
  - `--git-commit` / `--git-push`
- 通知：
  - `--tg-bot-token`
  - `--tg-chat-id`
- 输出：
  - `--report-file`

---

## 检测状态

- `active`
- `invalidated`
- `deactivated`
- `expired_by_time`
- `unauthorized`
- `missing_token`
- `check_error`
- `unknown`

---

## 输出报告

JSON 报告关键字段：

- `mode`：`repo` / `cpa` / `local`
- `summary.by_status`
- `results[]`：`file`, `provider`, `status`, `http_status`, `reason`, `detail`

---

## 安全建议

- 不输出完整 token。
- 请勿把 `--git-token`、报告文件提交到仓库。
- 推荐使用环境变量 `GIT_TOKEN` 传递 token。

示例：

```bash
export GIT_TOKEN='YOUR_GIT_TOKEN'
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/constansino/conscliproxyapi \
  --interactive \
  --report-file ./repo_report.json
```

---

## License

MIT
