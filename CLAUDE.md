# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库概览
- 当前仓库此前未提供 CLAUDE/Cursor/Copilot 规则，请以此文件为准。
- 项目由两个入口组成：
  - **Python CLI**（[src/cliproxy_credman/](src/cliproxy_credman/)）：批量克隆/扫描/删除 `auths/*.json`，支持 repo、本地目录、CPA API 三种来源。`[src/cliproxy_credman/cli.py](src/cliproxy_credman/cli.py)` 定义全部参数、菜单/交互模式、报告输出与 git 处理。
  - **Next.js Web**（[web/](web/)）：App Router + React 19，用同一业务逻辑实现 zip 上传检查、GitHub 仓库导入/删除。核心组件在 `[web/app/page.tsx](web/app/page.tsx)`，后端 API 位于 `[web/app/api/*](web/app/api/)`，业务工具集中在 `[web/lib/checker.ts](web/lib/checker.ts)`。
- 统一报告结构：`summary.by_status/by_provider` + `results[]`（文件、provider、status、detail）+ `git.push_error`。CLI `--report-file` 与 Web UI 展示一致，调试时可互相印证。

## Python CLI 常用命令
运行 CLI 前请使用 Python ≥3.9，并设置 `PYTHONPATH=src`（或 `pip install -e .`）。Git 访问 token 优先放在环境变量 `GIT_TOKEN` 中，命令行通过 `--git-token "$GIT_TOKEN"` 传入。

- 仓库模式（并发 200、Codex 探活、交互删除、自动提交推送）：
  ```bash
  PYTHONPATH=src python3 -m cliproxy_credman \
    --repo-url https://github.com/your-org/your-auth-repo \
    --git-token "$GIT_TOKEN" \
    --workers 200 \
    --codex-model gpt-5 \
    --codex-usage-limit-only \
    --interactive \
    --git-commit \
    --git-push \
    --report-file ./report.json
  ```
- Windows PowerShell 需先 `Set-Location <repo>`、`$env:PYTHONPATH="src"`，再执行与上方相同的 `python -m cliproxy_credman ...`。
- 本地目录仅做 usage-limit 检查：
  ```bash
  PYTHONPATH=src python3 -m cliproxy_credman \
    --auth-dir /data/cli-proxy-api/auths \
    --workers 200 \
    --codex-model gpt-5 \
    --codex-usage-limit-only \
    --report-file ./usage_limit_report.json
  ```
- 非交互删除指定状态（repo 模式）：
  ```bash
  PYTHONPATH=src python3 -m cliproxy_credman \
    --repo-url https://github.com/your-org/your-auth-repo \
    --git-token "$GIT_TOKEN" \
    --workers 200 \
    --codex-model gpt-5 \
    --codex-usage-limit-only \
    --delete-statuses usage_limited \
    --git-commit \
    --git-push \
    --report-file ./cleanup_report.json
  ```
- 菜单模式（TUI）：`PYTHONPATH=src python3 -m cliproxy_credman --menu`。

### CLI 参数/流程速记
- 互斥数据源：`--auth-dir`、`--repo-url`、`--cpa-url + --management-key`。`prepare_auth_dir()` 会自动克隆 repo，`--auth-subdir` 默认 `auths`。
- 执行控制：`--workers` (200 默认)、`--timeout` (35s)、`--schedule-minutes`、`--codex-model`、`--codex-usage-limit-only`、`--interactive`。
- 删除阶段：`--delete-statuses`（逗号分隔）、`--dry-run`、`--git-commit`、`--git-push`、`--git-author-*`。git 推送失败会自动尝试多种 fallback，最终错误写入 `report.git.push_error`。
- 通知/输出：`--report-file`、`--tg-bot-token`、`--tg-chat-id`。
- 菜单交互：总览页输入序号进详情；详情页用 `空格+序号` 多选，`a` 全选，`n` 清空，`x` 删除，`b` 返回，`q` 退出。

## Web 前端命令
在 `[web/](web/)` 目录执行以下脚本（见 `[web/package.json](web/package.json)`）：

```bash
cd web
npm install        # 首次安装依赖
npm run dev        # 本地开发 (Next.js)
npm run build      # 生成构建产物
npm run start      # 生产模式运行
npx vercel --prod  # Vercel 一键部署（需登录）
```

- 默认使用 Node 18+/npm，React 19 + Next 16。`next.config.ts` 启用 `reactStrictMode`。
- 主界面在 `[web/app/page.tsx](web/app/page.tsx)`，负责 zip 上传、状态筛选、导出清理 zip、GitHub 操作（检查/导入/删除）。
- API 端点位于 `[web/app/api/check](web/app/api/check)`、`[web/app/api/github/*](web/app/api/github)`，依赖 `[web/lib/checker.ts](web/lib/checker.ts)` 内的 GitHub trees/zipball 调用与压缩逻辑。环境变量（GitHub token、超时、并发限制）通过 Next.js route handler 读取。

## 工作流与注意事项
- CLI 运行前务必设置 `PYTHONPATH=src`，否则无法导入包。`GIT_TOKEN` 不要写进仓库，可在 shell 中 `export GIT_TOKEN=...`。
- Codex 探针参数（`--workers`、`--timeout`、`--codex-model`、`--codex-usage-limit-only`）同时影响 CLI 与 Web 侧逻辑，调整时保持一致以便比对结果。
- 报告 `summary.by_status` 中的状态值来源于 `[src/cliproxy_credman/cli.py](src/cliproxy_credman/cli.py)` 的状态判断（例如 `usage_limited`、`active`、`invalidated` 等）。在 Web UI 做过滤/导出时请复用同一集合，避免拼写不一致。
- GitHub 大仓库导入时，如命中 API 速率限制，请参考 `[web/lib/checker.ts](web/lib/checker.ts)` 中的 `GITHUB_TIMEOUT_MS`、`MAX_ZIP_SIZE` 约束，必要时增加退避或缩小批次。

## 验证与调试
- **CLI**：运行 README 示例命令，确认 `report.json` 生成并包含 `summary.by_status` 与 `results[]`。若启用删除，检查 `git status`/`git log` 是否包含自动提交，确保 `report.git.push_error` 为空。
- **Web**：`cd web && npm run dev` 后在浏览器上传 `auths.zip`，确认状态分布、筛选、清理 zip 导出均可用；如需 GitHub 流程，准备有效 token 并在 `.env.local` 中配置。
- **CPA API**：若使用 `--cpa-url`，确保管理端点可访问且 `management-key` 正确；`cpa_fetch_auth_files` 会校验返回 JSON，调试时可打印 `payload`。
- 常见问题：`--auth-dir` 与 `--repo-url` 不能同时传；`--git-token` 仅支持 https URL；`auths` 子目录缺失会直接抛错。