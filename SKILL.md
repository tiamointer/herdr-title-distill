---
name: herdr-title-distill
description: "维护 Herdr 的跨 harness 模型驱动智能命名服务：安装、迁移、验证、卸载和排查 OMP、Pi、Claude Code、Codex、Grok、Copilot、Hermes 的 pane/tab 自动标题。服务读取最近已完成的主回合，用 OMP 标题模型提炼 2–10 个可见字符；目标变化即改名，单-pane tab 跟随，multi-pane tab 与手工名称受保护。用户提到 Herdr 智能命名、跨 agent 标题、标题不更新、名称漂移或本服务故障时使用。不要用于普通手工改名或非 Herdr 终端标题管理。"
user-invocable: true
metadata:
  version: "3.1.0"
  status: "beta"
---

# Herdr Title Distill

维护本机 Herdr 跨 harness 智能命名服务。运行时是用户级后台服务；本 skill 负责安装、迁移、验证、卸载和排障。

## Operations

1. 查看状态：`python3 scripts/install.py --status`。
2. 安装或修复：`python3 scripts/install.py`。安装器只接管本项目或旧 `omp-herdr-title-sync` 的已证明所有注册，迁移标题所有权状态；无关同名文件拒绝覆盖。
3. 隔离验证：`python3 scripts/verify.py`。
4. 真实验证：在 Herdr pane 内运行 `python3 scripts/verify.py --live --all-harnesses`。真实启动 OMP、Codex、Grok 各两个目标回合；Pi、Claude Code、Copilot、Hermes 使用确定性 transcript fixture。
5. 卸载：`python3 scripts/install.py --uninstall`。只移除本项目拥有的注册；仍等于最后自动标题的活动标签恢复原值，用户手改标签保持不动。

## Runtime Contract

- launchd 服务每 750 ms 读取 Herdr `agent.list`，在主 agent 从 `working/blocked` 进入 `idle/done`、session 切换或完成 revision 改变时处理。
- OMP、Pi、Claude Code、Codex、Grok、Copilot、Hermes 各自解析真实 transcript；Hermes 直接只读 `~/.hermes/state.db`。未知 harness 仅在已有终端标题时做 best-effort fallback。
- 最近最多六条用户/助手消息交给 OMP 已认证的标题模型；目标长度 2–8、硬上限 10 个可见字符。优先自然中文，只保留不可翻译的产品名、命令名或公认缩写；不截断、不拼关键词。
- 模型返回后重新读取当前 agent 和 transcript fingerprint；session、状态或目标已变化时丢弃过期结果。
- pane 仅在空名、数字名或仍等于上次自动标题时更新；其他名称视为手工名。tab 仅在 `pane_count == 1` 时更新。
- 所有权状态保存在 `~/.config/herdr-title-distill/state/`，按 Herdr terminal ID 分文件；旧 `~/.config/omp-herdr-title-sync/state/` 只作为迁移来源。
- 服务通过 Herdr socket 调用 `agent.list`、`pane.get/rename`、`tab.get/rename`；不修改 Herdr 本体，也不改现有 harness hook。
- daemon 启动时盯住默认 socket 与 `~/.config/herdr/sessions/*/herdr.sock`，每 `HERDR_TITLE_DISTILL_RESCAN_MS`（默认 30000 ms）重扫，新会话自动接管，无需手动激活。
- 每个会话独立 `DistillService`，已处理状态分文件存（`service.json` 为 default，`service.<session>.json` 为命名会话），pane ID 跨会话不通用。
- 日志事件带 `session` 字段；`session-watch-started` 表示该会话已被接管。

## Failure Handling

标题模型失败、超时、返回非法标题，transcript 不完整，或 Herdr 不可用时，保留现状并记录日志；不猜测、不截断。若名称或注册所有权无法证明，默认保护现状。修改提示词、adapter、完成触发、所有权规则或安装路径后，必须重跑隔离验证和 `--live --all-harnesses`。标题不更新时先查 `service.log` 的 `session-watch-started` 与 `title-synced`；命名会话未被接管时等一个重扫周期（默认 30 秒）再确认 `~/.config/herdr/sessions/<名字>/herdr.sock` 存在。
