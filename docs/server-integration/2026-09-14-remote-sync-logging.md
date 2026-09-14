# 任务同步日志与请求关联

日期：2026-09-14。变更项目：LobsterAI、lobsterai-server。

## 变更与兼容性

本次为桌面任务同步补充诊断日志，覆盖本地投影、完整快照、增量批次、同步 ACK、失败重试以及服务端校验和提交。同步数据格式、去重规则、任务执行行为、HTTP/WS 地址、登录与设备认证均不变；无 SQL 迁移，无 App、Portal、Admin 必须修改项。

新增可选 HTTP 头 `X-Remote-Request-Id`，仅用于排障关联，不能用来认证、授权或代替 `batchId` / `eventId` / `importId` 去重。

- 桌面每次同步 HTTP 调用生成一个 UUID，通过该头发送。重试可以有新的 requestId，原有业务幂等 ID 保持不变。
- 服务端接受符合 UUID 格式的值；缺失或格式无效时生成 UUID，不因此拒绝旧客户端。
- 服务端响应同名头。远控业务错误和同步请求的通用 500 响应 `data.requestId` 与该请求的日志 ID 一致。
- 新桌面兼容没有该响应头的旧服务：仍记录发送 ID，并在业务错误提供 `data.requestId` 时记录服务端 ID。
- 非同步接口不额外发送该请求头。标准反向代理透传自定义请求/响应头即可，不要求新增 WS 配置。

## 接口与接入方式

以下接口沿用原有请求/响应体和 JWT、设备凭证要求：

| 方法 | 路径（前缀 `/api/remote/v1`） | 日志 operation |
| --- | --- | --- |
| POST | `/sync/batches` | `batch` |
| POST | `/sync/imports` | `import.begin` |
| GET | `/sync/imports/{importId}` | `import.status` |
| PUT | `/sync/imports/{importId}/parts/{partNo}` | `import.part` |
| POST | `/sync/imports/{importId}/commit` | `import.commit` |
| POST | `/sync/imports/{importId}/abort` | `import.abort` |

请求头示例（正文仍使用原同步协议）：

```http
POST /api/remote/v1/sync/batches
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Request-Id: 25f5c3e6-c89d-43b9-9d98-729f5afca220
Content-Type: application/json
```

错误响应示例：

```http
HTTP/1.1 409 Conflict
X-Remote-Request-Id: 25f5c3e6-c89d-43b9-9d98-729f5afca220
```

```json
{
  "code": 47006,
  "message": "Object version has different content",
  "data": {
    "reason": "IDEMPOTENCY_CONFLICT",
    "retryable": false,
    "retryAfterMs": null,
    "reasonDetail": null,
    "requestId": "25f5c3e6-c89d-43b9-9d98-729f5afca220"
  }
}
```

`requestId` 是可选关联能力，App 不需要参与桌面到服务端的同步请求；若展示错误反馈，可沿用并保留响应中的 requestId。

## 日志内容

统一前缀为 `[RemoteSync]`。仅选择协议元数据，不输出任务标题、问答正文、消息块内容、工具参数、附件内容、本地文件路径、Cookie、JWT、设备密钥、完整请求/响应体或带 SQL 参数的原始异常堆栈。

- 桌面 `Local projection staged`：本地会话 ID、生成前后 sourceSeq、ACK 水位、是否需要快照、当前 run/controlVersion。`staged` 表示事务内生成，不能单凭该行认定提交成功。
- 桌面 `Request started / succeeded / failed`：操作阶段、requestId、会话/设备/批次/导入 ID、事件数量与类型、序号范围、请求字节数、耗时、HTTP 状态；增量事件还包含索引、对象 ID、run、版本和 ordinal，不含对象内容。
- 桌面 `Snapshot prepared / baseline rebased / will be rebuilt`：快照分片数量、总字节数、固定基线、复用/重建/重新对齐过程。
- 桌面 `Batch / Snapshot acknowledged locally`：只有本地 ACK 事务返回后才输出；区分“服务端已响应”与“本地已经确认”。
- 桌面 `Session synchronization deferred`：关联准入、连接等待、设备不匹配、退避重试原因；相同会话相同等待状态不逐次刷日志。
- 桌面 `Session synchronization failed / Local projection failed / Bridge cycle deferred`：记录受限错误元数据，覆盖接口失败、本地投影失败和在同步前被连接/注册阶段阻断的情况。
- 服务端 `http.received / http.completed / http.rejected`：从安全校验前关联请求 ID，覆盖正文格式/大小限制、HTTP 状态和耗时。
- 服务端 `operation.received / event.validate / operation.completed / operation.failed`：记录服务端基线、具体失败事件的索引、sourceSeq、对象 ID、run/版本/控制版本、返回水位、幂等结果。事件索引从 0 开始。投影冲突会额外记录已有/传入版本、关联 ID、是否已删除，以及固定白名单中的 changedFields 字段名，不输出变化的内容。
- 服务端错误仅输出固定校验说明、错误类型、有限的项目栈位置、SQLState/数据库错误号等；不打印 SQL、绑定参数和任意异常消息。未知校验文案会被隐藏，可按代码位置继续定位。

## 日志位置与开关

桌面已有文件日志级别为 DEBUG，本次诊断默认写入日常日志并包含在“导出日志”结果中。macOS 路径为 `~/Library/Logs/LobsterAI/main-YYYY-MM-DD.log`，沿用既有大小轮转及 7 天清理策略。

服务端默认配置：

```properties
logging.level.com.youdao.lobsterai.remote.RemoteSyncService=DEBUG
logging.level.com.youdao.lobsterai.remote.RemoteSyncRequestFilter=DEBUG
```

服务端详细日志写入进程工作目录的 `log/server.log.YYYY-MM-DD.N`，沿用现有轮转策略。测试环境的 ELK 接收 DEBUG；**线上 ELK 当前仅接收 INFO 及以上，逐事件和批次成功详情需查 Pod 文件日志**。错误 WARN 和快照提交 INFO 可以在现有线上集中日志中查询。本次没有调整日志采集基础设施或全局 DEBUG。

结束详细排查后，可将上述两个类的日志级别改为 INFO；错误 WARN 仍保留。高频事件详情始终使用 DEBUG，空闲无待同步数据时不产生请求日志。

## 排查步骤

1. 从桌面导出日志，按故障会话 `localSessionId` 找到最后一次 `Request started`、错误和本地 ACK。
2. 用相同 `requestId` 查询服务端；新桌面连接旧服务时，同时检查桌面记录的响应 requestId。
3. 对比桌面的 `sourceSeq / ackSourceSeq / firstSourceSeq / lastSourceSeq` 和服务端的 `serverSourceSeq / committedSourceSeq`，确定停在本地生成、网络、服务校验、提交还是 ACK。
4. 若为 47006，结合失败事件的 ID、版本和固定校验说明检查内容/关联冲突；若为 47015，检查 expectedSourceSeq；若为 47025，检查快照基线和 activeImportId。
5. `Request succeeded` 不等于本地 ACK 成功；必须继续检查 `acknowledged locally`。事务内 `staged / event.validate` 也不等于已经持久化。

两端可独立升级；完整关联排查需同时使用包含本改动的桌面和服务端。此次只增加观测能力，不代表已修复之前“第二轮问答同步中断”的未知根因。

## 验证记录

- 原有桌面远控回归测试 81 项通过；新增日志/请求关联测试 19 项通过。
- 桌面本次改动的 TypeScript 文件 ESLint 检查通过，Electron TypeScript 检查通过。
- 服务端 `compileJava compileTestJava --offline` 通过；新增 9 项隔离日志测试只编译，按要求未执行服务端测试。
- 未连接真实账号发起同步、未修改用户任务数据、未部署服务。需要更新两端构建后，故障环境才会产生本次新增诊断。
