# CPA Credential Batch Manager

用于批量检测与清理 CLIProxyAPI 凭证（`auths/*.json`）的开源命令行工具。

## 模式

### 1) Repository Mode（推荐）
管理 Git 仓库中的凭证文件（适合集中管理“云端凭证仓库”）。

- 输入：`--repo-url`（可选 `--git-key`）
- 输出：检测报告；可按状态删除并执行 `git commit` / `git push`

### 2) CPA API Mode
通过 CPA 管理接口远程管理服务器当前加载的凭证（无需 SSH）。

- 输入：`--cpa-url` + `--management-key`
- 输出：检测报告；可按状态调用 CPA 删除凭证

### 3) Local Directory Mode
直接扫描当前机器目录。

- 输入：`--auth-dir`

---

## 安装与运行

### 1. 克隆项目

```bash
git clone https://github.com/constansino/cliproxyapi-credential-batch-manager.git
cd cliproxyapi-credential-batch-manager
```

### 2. 直接运行（无需安装）

```bash
PYTHONPATH=src python3 -m cliproxy_credman --help
```

### 3. 可选：安装为命令

```bash
python3 -m pip install -e .
cliproxy-credman --help
```

---

## 用法

### A. Repository Mode（推荐）


### A-1. 私有仓库访问（SSH Key）

如果凭证仓库是私有仓库，建议使用 SSH key。

#### 1) 准备 key 文件（示例）

- macOS/Linux 常见路径：`~/.ssh/id_ed25519`
- 确保权限正确：

```bash
chmod 600 ~/.ssh/id_ed25519
```

#### 2) 验证 key 是否可访问仓库

```bash
ssh -T git@github.com
```

如首次连接出现 host 指纹确认，输入 `yes`。

#### 3) 在工具中指定 key

```bash
PYTHONPATH=src python3 -m cliproxy_credman   --repo-url git@github.com:your-org/your-auth-repo.git   --repo-branch master   --git-key ~/.ssh/id_ed25519   --report-file ./repo_report.json
```

> 说明：
> - `--git-key` 会注入 `GIT_SSH_COMMAND`，工具在 `clone/push` 时使用该 key。
> - 如果你使用的是 GitHub Deploy Key，也可直接用同样方式。


#### 仅检测

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url https://github.com/your-org/your-auth-repo.git \
  --repo-branch master \
  --report-file ./repo_report.json
```

私有仓库示例：

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --repo-branch master \
  --git-key ~/.ssh/id_ed25519 \
  --report-file ./repo_report.json
```

#### 删除失效凭证并推送

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --repo-branch master \
  --git-key ~/.ssh/id_ed25519 \
  --delete-statuses invalidated,deactivated,expired_by_time,unauthorized \
  --git-commit \
  --git-push \
  --git-author-name "cred-bot" \
  --git-author-email "cred-bot@example.com" \
  --report-file ./repo_report.json
```

#### Dry-run

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --repo-url git@github.com:your-org/your-auth-repo.git \
  --git-key ~/.ssh/id_ed25519 \
  --delete-statuses invalidated,deactivated \
  --dry-run \
  --report-file ./repo_report_preview.json
```

### B. CPA API Mode

#### 仅检测

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --report-file ./cpa_report.json
```

#### 删除（先 dry-run 再执行）

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --delete-statuses invalidated,deactivated \
  --dry-run \
  --report-file ./cpa_report_preview.json
```

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --cpa-url http://your-cpa-host:8317 \
  --management-key YOUR_MANAGEMENT_KEY \
  --delete-statuses invalidated,deactivated \
  --report-file ./cpa_report.json
```

### C. Local Directory Mode

```bash
PYTHONPATH=src python3 -m cliproxy_credman \
  --auth-dir /data/cli-proxy-api/auths \
  --report-file ./local_report.json
```

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

## 常用参数

- `--repo-url` / `--repo-branch` / `--git-key`
- `--cpa-url` / `--management-key`
- `--auth-dir`
- `--workers`（默认 16）
- `--timeout`（默认 35）
- `--delete-statuses`
- `--dry-run`
- `--git-commit` / `--git-push`
- `--report-file`

---

## 输出报告

JSON 报告关键字段：

- `mode`：`repo` / `cpa` / `local`
- `summary.by_status`
- `results[]`：`file`, `provider`, `status`, `http_status`, `reason`, `detail`

---

## 安全

- 不输出完整 token。
- 请勿提交报告文件或私钥。
- 使用最小权限密钥。

---

## License

MIT
