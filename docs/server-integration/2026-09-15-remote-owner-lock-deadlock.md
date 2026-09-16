# 手机远控 claim 死锁修复接入说明

日期：2026-09-15。服务端：`lobsterai-server`。消费项目：LobsterAI 桌面端；App 接口保持兼容。

## 变更摘要

服务端修复同账号并发领取命令、领取输入准备时的 MySQL 死锁。日志中 17:14:24.851 的 `input-preparations/claim`，以及 17:14:26.071、17:14:26.257 的 `commands/claim` 均在 `RemoteDeviceMapper.lockOwner` 报错。

原 `INSERT IGNORE → SELECT FOR UPDATE` 会让已有 owner 行上的并发事务从共享锁升级到排他锁时互相等待。新逻辑使用 MySQL 5.7 支持的 `ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)`，在初始化阶段直接获取主键行排他锁；文件额度和每日流量初始化的同类 SQL 也一起修正。重复分支不重置计数，业务不依赖初始化语句的 affectedRows。[MySQL 5.7 官方锁说明](https://docs.oracle.com/cd/E17952_01/mysql-5.7-en/innodb-locks-set.html)

这是服务端内部事务修复，无新增接口、请求字段、响应字段或认证方式，不要求修改桌面端或 App 协议。

## 接口信息

以下是现有桌面领取接口，路径中的 `deviceId` 必须为当前桌面设备：

```http
POST /api/remote/v1/devices/{deviceId}/commands/claim
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
Content-Type: application/json

{"connectionGeneration":"12","limit":5}
```

```http
POST /api/remote/v1/devices/{deviceId}/input-preparations/claim
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
Content-Type: application/json

{"connectionGeneration":"12","limit":5}
```

`connectionGeneration` 使用当前 WS 连接获得的实际代次，不能固定为示例值。命令 claim 的 `limit` 默认 10、最多 20；输入准备 claim 默认 5、范围 1–10。无待领取工作时，两者均可返回：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [],
    "serverTime": "2026-09-15T09:20:00Z"
  }
}
```

有工作时沿用已有 `items` 结构及 claim 凭证、租约、版本规则，本次未新增字段。完整协议见[远控 API](../../../lobsterai-server/docs/api/mobile-remote-api.md)和[输入 v2 API](../../../lobsterai-server/docs/api/mobile-remote-input-v2.md)。

## 客户端接入事项

- 不需要因本次修复修改请求格式、UI 或能力协商，也不需要升级 App 才能使用修复。
- 失败时继续既有有间隔的 claim 轮询；WS 断开后恢复连接，使用新连接代次核对已有工作。不要保留旧代次继续领取。
- 对已经提交或可能执行过的命令，继续使用原 commandId 和已有核对流程。不要因为 claim 返回错误而生成新 commandId、重建任务或绕过租约直接执行，以免重复执行。
- 已有输入准备继续沿用原 preparationId 进行查询、恢复和租约核对，不把失败的领取请求当成新的用户意图。

## 认证要求

保持 JWT Bearer 和设备凭证认证，不改成登录 Cookie。两个 claim 接口仅允许当前桌面设备领取自己在同账号、同空间下的工作，并校验设备状态和当前连接代次；本次不放宽任何授权检查。

## 发布、兼容性与验证

- 只需部署修复后的服务端，所有 Pod 都应更新。滚动发布期间旧 Pod 仍可能执行旧 SQL，完成全部更新后再观察错误是否消失。
- 无新增开关、参数、DDL 或索引，不需要 V94，也无需重跑 V88–V93；既有环境配置不变。
- `compileJava`、`compileTestJava` 均返回 `BUILD SUCCESSFUL`，`git diff --check` 通过。新增 SQL 契约测试检查生成 SQL、参数绑定及 WRITE 路由；仅编译测试源码，没有运行测试，不证明真实数据库锁竞争已经验证通过。
- 按用户要求未执行服务端测试；本次没有真实 MySQL 并发复现、数据库写入或部署。

排障依据和修复范围见[服务端记录](../../../lobsterai-server/docs/operations/2026-09-15-remote-owner-lock-deadlock.md)。
