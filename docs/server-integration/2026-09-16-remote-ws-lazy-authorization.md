# 远控 WS 按需鉴权接入说明

日期：2026-09-16。状态：服务端改动待发布；不新增客户端功能、数据库迁移或部署基础设施。

## 1. 变更摘要

远控 WS 保留建连时的完整鉴权，移除正常心跳及无会话订阅巡检中的周期性 MySQL 权限查询。业务入站、事件回放查询前和业务消息发送前仍按需复核账号、企业身份、设备及授权，成功结果在当前连接内复用最长 15 秒，心跳不会刷新该校验时间。不新增 Redis 共享权限缓存。

正常 `hello/pong/reconnect.required` 使用连接保活校验。收到访问变更通知时清除目标电脑 read 授权租约；当前设备的 `device.changed/access.changed` 清除连接级校验结果；匹配的 `device.revoked` 直接关闭连接。

## 2. 接口详情

沿用 HTTP Base URL `https://<API_HOST>/api/remote/v1` 和所有既有字段，无新增接口。

申请一次性连接票据：

```http
POST /api/remote/v1/connection-tickets
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
Content-Type: application/json
```

```json
{"protocolVersion":1}
```

成功响应示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "wsUrl": "wss://<API_HOST>/api/remote/v1/ws?ticket=<single-use-ticket>",
    "expiresAt": "2026-09-16T08:01:00.000Z",
    "protocolVersion": 1
  }
}
```

使用返回的 `wsUrl` 建立 WSS，等待 `hello` 后恢复订阅；不得将 access token 或 deviceKey 拼进 URL，不记录完整 ticket URL。既有 `projectionVersion` 协商保持不变，下列示例为基础 v1 字段。

```json
{
  "protocolVersion": 1,
  "type": "hello",
  "connectionId": "conn_01",
  "connectionGeneration": "12",
  "heartbeatIntervalSeconds": 25,
  "heartbeatTimeoutSeconds": 75,
  "revalidateAt": "2026-09-16T08:15:00.000Z",
  "serverTime": "2026-09-16T08:00:00.000Z"
}
```

按服务端下发间隔发送心跳，默认 25 秒；超时默认 75 秒。

```json
{"type":"ping","id":"ping_01"}
```

```json
{"type":"pong","id":"ping_01","serverTime":"2026-09-16T08:00:25.000Z"}
```

连接凭据默认最长 15 分钟，受原凭据有效期约束，以 `revalidateAt` 为准。接近到期时沿用以下通知及 4401 关闭码：

```json
{"type":"reconnect.required","reason":"AUTH_REVALIDATION","retryAfterMs":0}
```

## 3. 前端行动项

无需新增代码或界面。沿用现有心跳、限速重连、ticket 更新和订阅恢复逻辑，并检查以下已有行为：

- `pong` 仅更新连接存活时间；不能据此恢复已撤销的任务访问或启用执行按钮。
- 收到 `reconnect.required` 或直接收到 4401 时，获取有效 access token、重新申请 ticket、恢复订阅；ticket 单次使用，重试重新申请。
- 重连保留 `lastAppliedSeq`、待确认 commandId 和本地 outbox，按原协议补齐，避免重复提交任务。
- 按现有 `access.changed`、`resync.required` 和关闭码处理失效权限及本地缓存。

## 4. 认证要求

HTTP 沿用 JWT Bearer 与设备凭证；WS 使用绑定当前设备、账户及身份的一次性 ticket。个人/企业身份隔离、同账号访问条件、目标电脑 read/control 权限与任务执行授权均不改变。

若撤销通知丢失，账号禁用或注销后的纯空闲连接可能直到下一次业务访问或凭据到期才断开；心跳成功不代表授权仍有效。业务授权租约过期后必须重新复核，失败不得继续发送正文。

## 5. 注意事项与发布顺序

仅需发布服务端，现有 App/桌面协议兼容；新旧 Pod 混跑时旧 Pod 仍可能进行周期性查库，优化效果需全部节点升级后再观察。滚动重启仍按现有机制重连与补齐，本次不改变任务持久化和执行位置。

不新增环境变量、功能开关、DDL 或 MySQL 版本要求。有会话订阅时默认 45 秒的回放校对仍查询数据库；建连与关闭仍记录最近在线时间，认证重连、HTTP 和实际业务访问仍有数据库负载。因此不能宣称 WS 已完全脱离 MySQL，也不能将历史压测结果当作本次优化后的容量结果。
