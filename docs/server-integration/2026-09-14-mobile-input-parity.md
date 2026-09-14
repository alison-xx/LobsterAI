# 手机远控任务输入 v2：服务端接入说明

日期：2026-09-14。配套 server/desktop 实现；桌面主动上传新附件的自动调度尚待明确授权后接线，其他主链路已实现。未执行测试/线上迁移或发布。手机 App 项目未提供，App团队按下列协议接入。Portal/Admin 无必需改动。

## 变更摘要

支持同账号/空间下选择在线电脑和可用 Agent 新建任务，手机可选桌面已配置的订阅/自定义对话模型、思考选项，并上传图片/文件。续聊固定原 Agent、原电脑和原 cwd；新建使用所选 Agent 默认 cwd。自定义模型凭据/地址/Headers只留电脑。

新增安全模型目录、私有附件资产、持久输入准备；正式命令继续复用 `/api/remote/v1/commands`。先完成准备再开启原60秒命令启动期限，准备不运行任务。

## 完整契约

- [App 输入 v2 接入文档](../../../lobsterai-server/docs/api/mobile-remote-input-v2.md)：精确字段、JSON示例、Headers、错误、恢复。
- [输入 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-14-mobile-input-parity.md)：产品范围、双端一致性、固定目录和附件策略。
- [既有远控文档](../../../lobsterai-server/docs/api/mobile-remote-api.md)：注册、访问资格、WSS、水位和命令基础协议。

## 接口和认证

Base URL=`/api/remote/v1`。所有请求使用 `Authorization: Bearer <accessToken>` 和 `X-Remote-Device-Credential: <deviceId>.<deviceKey>`；服务端派生owner/scope。读取v2元数据使用 `X-Remote-Projection-Version: 2`，WSS票据增加 `projectionVersion:2`。

| API | 行为 |
| --- | --- |
| GET /devices/{id}/input-capabilities | 获取当前电脑能力、有效限制、模型和purpose可用状态 |
| GET /devices/{id}/models | 获取安全模型目录 |
| POST /devices/{id}/models/publish | 桌面发布publicationId/expectedCatalogVersion/connectionGeneration/items |
| POST /devices/{id}/input-assets | 手机草稿或桌面本人会话附件申请资产 |
| PUT /input-assets/{id}/parts/{partNo} | 原始字节分片，Content-Length、X-Content-SHA256，类型application/octet-stream |
| POST /input-assets/{id}/complete | 全文件校验；body为sha256 |
| GET /input-assets/{id}、/content | 状态和私有内容；历史需sessionId+messageId，准备需preparationId+claim Headers |
| POST /devices/{id}/input-preparations | 手机固定Agent/模型/附件及版本创建准备 |
| GET /input-preparations/{id}、POST /input-preparations/{id}/cancel | 手机查询/取消 |
| GET /devices/{id}/input-preparations | 桌面按cursor恢复未完成记录 |
| POST /devices/{id}/input-preparations/claim | 桌面领取，connectionGeneration、limit |
| POST /input-preparations/{id}/renew、/result | 当前claim证明续租/报告ready或failed |
| POST /commands | inputSchemaVersion=2，payload只引用inputPreparationId/inputDigest |

JSON响应仍为 `{code:0,message:"success",data:{...}}`；文件/content为二进制200/206。大字节数/版本均字符串。

模型目录例：

```json
{"modelRef":"opaque_ref","version":"1","source":"custom","displayName":"我的模型","providerLabel":"自定义服务","available":true,"unavailableReason":null,"inputCapabilities":{"text":true,"image":false,"toolCalling":true},"thinking":{"options":[],"default":null}}
```

正式新建命令例（先取得ready收据）：

```json
{"commandId":"33333333-3333-4333-8333-333333333333","type":"create_session","deviceId":"desktop_id","inputSchemaVersion":2,"expiresAt":"<服务端当前时间+最多60秒>","payload":{"inputPreparationId":"22222222-2222-4222-8222-222222222222","inputDigest":"<ready收据摘要>"}}
```

续聊顶层再带sessionId、expectedControlVersion、expectedInputVersion。App不能提交resolvedInput、cwd等执行字段。

## 桌面接线要求

1. 只有协商了input_schema_v2/model_selection_v1才发布模型目录；匿名Agent不进入新建列表。Agent.defaultInput是可选安全摘要，v2 GET agents用于目录对账。
2. 本机保存不透明modelRef及版本映射。目录变化包括凭据/路由变化，密钥不能序列化到HTTP/日志；目录最多200项，展示名最长120字符，thinking.default无值显式null以匹配服务端归一化。
3. 准备请求解析默认模型/cwd，下载至受控缓存并校验hash/size/文件身份。safe resolvedInput使用服务端资产元数据，不能trim文本或改写文件名。readyExpiresAt由服务端生成，不放result请求。
4. claim证明包含claimId/token/generation/statusVersion；令牌只为当前准备/电脑有效。重连重新领取/核对，原待提交准备不会自动变成任务。
5. 正式命令的requestHash针对实际execution_request（含resolvedInput）；服务端另外保存App原bodyHash做幂等。保持本地inbox/journal，模型应用未知时持续阻止重复派发。
6. 手机附件用既有图片视觉、文件和媒体输入路径；桌面显式选择的新附件异步上传已有独立传输组件，自动调度尚被审批阻止；待授权接线后，原消息同步后才绑定云端资产。旧历史和匿名任务不自动上传。
7. v2消息携带inputModel/attachment，已应用的模型变更提升inputVersion并真实同步。旧reader由服务端转文字占位，不能修改规范事件hash。

## App行动项

新增在线电脑/Agent/订阅及自定义模型/思考选择器，接系统文件/相机/相册。使用服务器实际能力和图片预算，HEIC需明确转换。实现upload→prepare→command；本地持久保存全部ID和原请求；后台/重启/取消清除自动提交资格，恢复仅查询。使用同一WSS的目录/准备/会话通知，历史下载携带sessionId/messageId。

## 迁移、开关和兼容

- 先执行V90和V91，MySQL5.7兼容、无外键；不能重写V88/V89。
- 全部服务节点升级后，确认既有commands/agent-summary/agent-selection开关，再启用 `REMOTE_INPUT_ENABLED`。新输入默认false，旧v1和远控主开关保持既有行为。
- 附件另需 `REMOTE_INPUT_ASSETS_ENABLED=true`、独立私有bucket及TOS/S3配置。可复用现有火山凭据，但不复用公开分享bucket；ACL、policy及匿名读取检查失败时附件不可用。无新增网关。
- 默认分片4MiB、100MiB/文件、200MiB/次、10个、4路本节点传输；图片另受base64帧预算限制。Nginx需允许实际分片大小与超时；WSS地址不变。
- 关闭新能力停止新准备/受理；原命令核对、任务状态与有权历史读取仍按持久事实恢复。回退旧二进制前处理未执行/未知命令，不清空去重记录。
- 本轮只进行本地编译、mock/契约测试；真实对象存储、四节点重启、App及运行器端到端仍需测试环境联调。
