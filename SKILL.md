---
name: omp-herdr-title-sync
description: "管理本机 OMP → Herdr 的无模型短标题同步器：安装、更新、配置别名、验证、卸载或排查自动 pane/tab 命名。同步器复用 OMP 已有 session title，以确定性规则压缩到 10 个可见字符内；单-pane tab 跟随，multi-pane tab 和手工名称受保护。用户提到 OMP Herdr 标题同步、pane 自动重命名、短标题别名或本同步器故障时使用。不要用于普通手工改名、Claude/Codex hooks、生成新标题的模型调用或其他终端的标题管理。"
user-invocable: true
metadata:
  version: "1.0.0"
  status: "beta"
---

# OMP Herdr Title Sync

维护本机无模型标题同步器。运行时由 OMP 扩展自动执行；本 skill 只负责安装、配置、验证、卸载和排障，不为标题调用模型。

## Operations

1. 查看状态：`python3 scripts/install.py --status`。
2. 安装或修复注册：`python3 scripts/install.py`。安装器只在 `~/.omp/agent/extensions/omp-herdr-title-sync.ts` 创建指向本 skill 的符号链接；遇到同名非本项目文件必须停止，不覆盖。
3. 修改精确别名：编辑 `config/aliases.json` 的 `aliases` 对象。键是 OMP 原始标题，值是期望短标题；值应不超过 10 个可见字符。别名在下一次标题变化时生效。
4. 隔离验证：`python3 scripts/verify.py`。
5. 真实 Herdr 验证：在 Herdr pane 内运行 `python3 scripts/verify.py --live`。验证器创建无焦点临时 tab/pane，结束前关闭它们；测试 OMP 会话不发送 prompt，不调用模型。
6. 卸载运行时扩展：`python3 scripts/install.py --uninstall`。只移除本项目拥有的链接；仍等于最后自动标题的活动标签会恢复原值，已被用户手改的标签保持不动。

## Runtime Contract

- 每 750 ms 在进程内检查一次 `pi.getSessionName()`；只有标题变化时才访问 Herdr socket。
- 标题规则：5 字优先、10 字硬上限；清理动作与样板词，优先选择产品/对象、关键问题和有区分度的任务词；未知长词保留首尾并用中间省略号连接。
- pane：空名、数字名或等于上次自动标题时可更新；其他名称视为手工名。
- tab：仅 `pane_count == 1` 时按同一规则更新；multi-pane tab 永不随后台 pane 跳动。
- 状态保存在本 skill 的 `state/`，按 Herdr terminal ID 分文件，以便跨 OMP 恢复后继续识别自动标题所有权。
- 运行时只使用 Node/Bun 标准库和 Herdr Unix socket；禁止 `claude`、`codex`、网络 API、`fetch` 或子进程模型调用。

## Failure Handling

Herdr 不可用、socket 超时或响应结构不合法时静默跳过并在下一次检查重试，不阻塞 OMP。若手工名、同名扩展冲突或无法确认所有权，默认保护现状，不猜测、不覆盖。修改压缩规则、所有权规则或安装路径后，必须同时重跑隔离验证与 `--live` 验证。
