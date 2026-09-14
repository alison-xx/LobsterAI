# 手机新建任务事务边界修复

## 问题与证据

手机新建“哈尔滨天气如何”时显示：

`Session writes require runSessionTransaction for the outer transaction`

桌面本地 inbox 中，命令 `41382877-2300-4e6f-b616-270d8c698edb` 已记录为 `rejected`，错误码 `47019 / COMMAND_INVALID`，`localSessionId=null`。对应服务端会话 ID 为 `77ffafdd-a2de-4a62-be00-3a8b04a607d8`。错误发生在创建本地会话之前，执行器尚未启动。

## 原因与修改

远控领取命令及断线恢复时，在 `RemoteStore.transaction` 内调用 `SessionCommandService.prepare()`；新建任务进一步调用 `CoworkStore.createSession()`。会话投影通知要求最外层事务通过 `CoworkStore.runSessionTransaction()`，以确保界面更新通知发生在数据库真正提交之后。因此当前路径被事务校验拒绝。

`RemoteBridge` 增加必需的 `runSessionTransaction` 依赖，由主进程注入 `CoworkStore.runSessionTransaction`，正常领取和恢复准备两处都使用该入口。会话、用户归属、服务端映射、run 及 inbox 保持同一事务提交；任一步失败全部回滚，提交后才发送会话变化通知。原有事务校验继续保留。

## 接入与恢复

- 仅桌面端需要更新并重启以加载修复。
- 服务端、手机端接口、认证方式和响应结构均无变更，不需要数据库迁移。
- 已经 `rejected` 的命令仍是终态，不会自动重新执行。更新桌面端后，用户可在手机重新发送保留的草稿，作为一次新的提交使用新的 `commandId`。
- 请求超时、尚未明确结果时，仍应查询或重试原 `commandId`；不能因网络重试生成新命令。
- 服务端保留的新会话占位不代表任务已经执行。修复不重置旧命令状态，也不修改用户本地数据。

## 验证范围

回归使用真实内存 SQLite、`CoworkStore`、`SessionCommandService` 和 `RemoteBridge`，覆盖正常新建、提交后通知、失败回滚、重复命令去重，以及丢失领取记录后的恢复路径。

验证结果：新增 4 项回归在旧代码全部失败（复现同一事务报错），修复后全部通过。远控、CoworkStore、会话投影事务及主进程远控启动共 21 个测试文件、281 项测试通过；所有本次修改的 TypeScript 文件 ESLint 通过，Electron TypeScript 检查通过。未操作真实任务或重启正在运行的客户端，手机实机恢复需更新后验证。
