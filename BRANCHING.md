# Branching and Parallel Session Contract

本仓库允许多个 Codex session 并行工作，但每个 session 必须使用独立分支和 worktree，
不得把未提交修改长期留在共享的 `main` 工作树。

## 分支约定

- `main`：只用于已验收的发布内容；不接受多个 session 同时修改。
- `codex/<scope>`：一个 session 一个目标一个分支。
- 修复分支示例：`codex/fix-interrupted-unknown-cost`
- 功能分支示例：`codex/account-sync-spend-analysis`
- 实验分支/目录：实验默认只写 `experiments/`；该目录已被 git ignore，不提交实验日志。

## 工作流

1. 开始前执行 `git fetch origin`，从 `origin/main` 创建分支。
2. 在独立 worktree 或明确归属的 worktree 中工作。
3. 一个分支只处理一个主题；不要顺手修改其他 session 的文件。
4. 提交前运行 `npm test` 和 `npm run check`，并执行 `git diff --check`。
5. 用 `feat:`、`fix:`、`docs:` 或 `chore:` 作为提交前缀。
6. 推送分支后创建 PR；不直接改写 `main`，不 force push `main`。
7. 实验报告写入 `experiments/<experiment-name>/`，不把密钥、Cookie、Authorization
   头或原始凭据写入任何文件。

## 当前 session 分工

| 主题 | 分支/worktree | 边界 |
|---|---|---|
| 中断后金额未知的 bug 修复 | `codex/fix-interrupted-unknown-cost` | 只改该修复涉及的 Host/UI/测试文件 |
| 账户同步与花费分析 | `codex/account-sync-spend-analysis` | 生产分支，账户适配器、分类与文档 |
| 高频轮询精度实验 | 只写 `experiments/account-sync-probe/` | 不改生产代码，不提交实验日志 |

发生文件重叠时，先停止提交，由各 session 在 PR 中按主题拆分，禁止用覆盖式
checkout 或强制推送解决冲突。
