# 手机续聊导致同步中断：run 发布版本修复

日期：2026-09-14。变更范围：LobsterAI 桌面端。服务端、App 接口和数据库结构不变。

## 已确认的故障

本次“沈阳天气？”会话的手机命令已经执行，桌面后续回答也已完成，但增量上传被服务端拒绝：

- 本地会话：`443ad5bb-7fa8-4ed2-aa3b-4accd4fd47ef`。
- 远端会话：`a1ce349f-8391-479b-82c5-49f6ddfa9d53`。
- 日志错误：HTTP 409，`47006 / IDEMPOTENCY_CONFLICT`，`Changing the current run must advance controlVersion`。
- 排查时客户端 `sourceSeq=76`、`ackSourceSeq=30`；服务端 `lastSourceSeq=30`、`controlVersion=3`，整个失败批次已回滚。
- 对应手机 `send_message` 命令状态为 `applied`，说明命令已被桌面执行；这个状态并不保证后续执行结果已同步。

待发队列中的关键顺序：

| sourceSeq | 事件 | run | controlVersion |
| --- | --- | --- | --- |
| 31 | session.upsert | null（手机命令预留，尚未发布） | 4 |
| 32 | run.updated | 上一轮已完成的 run | 4 |
| 33 | session.upsert | 本轮新 run，starting | 4 |

`beginRun()` 为手机命令预留 run 时推进控制版本，暂不公开该 run；原 `markRunDispatched()` 在实际执行时公开 run，却没有再推进控制版本。服务端正确拒绝同一版本切换当前 run，导致批次回滚及后续消息积压。此前仅模拟桌面本地连续两轮问答，没有覆盖手机命令的“先预留、再发布”路径。

## 修复行为

1. 只有 `runPublished=false → true` 的首次发布推进一次 controlVersion。重复发布及旧记录缺失标记时不额外推进。
2. 仅当增量批次返回上述精确错误码和校验说明、且没有进行中的快照时，安排一次定向快照恢复。
3. 恢复时在同一个本地事务中推进控制版本、标记需要快照并生成最新投影。这样即使旧的 null-run 摘要已被单独确认，新快照也有更高控制版本。
4. 原 outbox 的事件内容、eventId、sourceSeq 均不改写。沿用服务端快照基线校验和提交流程，收到提交 ACK 后才清理已覆盖事件。
5. 恢复沿用已有重试间隔。快照失败保留队列，不在每次重试中继续推进控制版本；其他类型的 47006 不自动覆盖。

恢复只同步数据，不重新运行任务、不再次执行已经 applied 的手机命令。账号、设备或环境变化后的迟到错误不会触发恢复。

## 生效与观察

更新并重启桌面客户端、加载此修复后，保持手机连接功能开启，已有失败会话会在重试中自动补同步。无需重新提问、重新授权或手工修改数据库；服务端保留原有控制版本校验。

桌面日志应依次看到：

```text
[RemoteSync] Session synchronization failed
[RemoteSync] Run mapping recovery snapshot scheduled
[RemoteSync] Snapshot prepared
[RemoteSync] Request succeeded
[RemoteSync] Snapshot acknowledged locally
```

最终以 `Snapshot acknowledged locally`、ACK 追平、失败标记清除为准。若快照仍失败，按 requestId 继续查对应错误，不能提前视为恢复成功。详细日志位置及关联方法见 [任务同步日志说明](2026-09-14-remote-sync-logging.md)。

## 验证

- 新增 9 项回归：旧实现 5 项失败，修复后全部通过。
- 覆盖首次发布、重复/旧标记、整批回滚、前半批已 ACK、重复提交失败、其他错误不迁移、账号/设备切换、快照期间新增消息。
- 桌面远控目录 17 个测试文件、201 项测试通过；本次改动文件 ESLint、Electron TypeScript 检查通过。
- 服务端无需改动，未执行服务端测试。排查真实客户端和测试库时仅做只读查询，没有手工清理队列或修改用户任务。
- 当前运行的客户端是否已恢复，需要在加载修复代码后再确认；本次测试通过不代表旧进程已经生效。
