# 安装说明

本目录区分“已实测的本地开发链接”和“待选择的发布包安装”。发布前不要把任何一条命令
写成已经发布成功。

## 兼容性

| 项目 | 要求 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.2.1`；当前实测为 `0.2.0-rc.2` |
| Node.js | `^22.19.0 || >=24.0.0` |
| DSH 界面 | web profile |
| 运行时网络 | 插件本身不联网；搜索账本关联需要本机搜索 shim 已有账本 |

## 方式一：npm 包（仅发布后）

```powershell
dsh plugin --profile web add dsh-billing-stats@0.1.0
```

该命令要求 npm 包已发布、profile 的包管理器可以解析该名称，并且 DSH 进程使用同一个
`$DSH_HOME`。如果改用 scope，安装名必须与最终 `package.json` 的 `name` 完全一致。

## 方式二：tarball（GitHub Release 或本地产物）

```powershell
dsh plugin --profile web add E:\path\to\dsh-billing-stats-0.1.0.tgz
```

DSH 的 `plugin` 子命令会把 `add ...` 转发给 profile 目录中的 pnpm。发布包不包含
构建步骤，安装后只需重启 DSH；客户端资源由 DSH 从 `dsh.client` 声明加载。

## 方式三：本地开发链接（已实测）

```powershell
dsh plugin --profile web add link:E:/programs/dsh-billing-attribution
```

随后确认 profile 的 `package.json` 同时包含：

```json
{
  "dependencies": {
    "dsh-billing-stats": "link:E:/programs/dsh-billing-attribution"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-billing-stats"
      ]
    }
  }
}
```

## 配置与数据目录

包内 `cordis.patch.yml` 提供可移植默认值：

- `pricingPath`：包内 `pricing/profiles.json`；
- `ledgerPath`：包内 `data/usage-ledger.jsonl`；
- `searchStatePath`：包内 `data/search-state.json`；
- `searchLedgerEnabled: false`，避免引用某台机器的搜索 shim 路径。

包目录通常会在升级时被替换。需要跨升级保留账本和搜索游标时，必须在 profile 的
`cordis.patch.yml` 中把 `ledgerPath`、`searchStatePath` 覆盖到用户可写目录；只有确认
搜索 shim 的 JSONL 路径存在后，才把 `searchLedgerEnabled` 设为 `true` 并配置
`searchLedgerPath`。

`install/dev-patch.snippet.yml` 仅保留本机开发链接的示例路径，不属于发布包默认配置；
普通安装应使用包根目录的 `cordis.patch.yml`。

## 重启与验收

1. 关闭正在运行的 DSH web 进程。
2. 用启动脚本正常启动，确认日志出现 `[billing-stats] active`。
3. 打开 web 会话，执行 `/cost`、`/cost explain`、`/cost profiles`。
4. 发一轮受控请求，确认底部会话金额、每轮金额和展开明细出现。
5. 如启用搜索账本，再验证一条真实搜索记录被归因到正确轮次。

## 回滚

1. 从 profile 的 `package.json` 移除 `dsh-billing-stats` 依赖和 bundle 项。
2. 移除或恢复 profile `cordis.patch.yml` 中的 `billing-attribution` 配置。
3. 在 profile 目录执行包管理器安装/同步，或用安装前备份恢复 `package.json`、
   `pnpm-lock.yaml` 与 patch 文件。
4. 重启 DSH，确认 `/cost` 不再注册且其他插件正常加载。

不要把回滚写成删除用户账本；账本是本地观测数据，应由用户决定保留或归档。
