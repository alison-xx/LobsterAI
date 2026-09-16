# 服务端远控扩展功能默认开启

**2026-09-15 后续存储更新**：用户已明确选择默认复用分享 NOS 网关（share-gateway），不再要求独立 bucket/AK/SK；V93 已于 2026-09-15 在测试库执行并通过全表结构校验，生产库尚未执行，详见[执行记录](../../../lobsterai-server/docs/operations/2026-09-15-test-v93.md)。本说明中的开关默认值仍有效，最新存储/迁移条件见[分享网关接入说明](2026-09-15-remote-nos-share-gateway.md)。

日期：2026-09-15。消费项目：LobsterAI 桌面端；App 可使用同一能力接入说明。

## 1. 变更摘要

服务端把以下 11 个开关的配置默认值和 Java Properties 初始值统一改为 `true`。本次无新增接口、请求/响应字段或认证方式；不需要为这次默认值调整修改客户端协议。服务端基础远控和命令开关原本即默认开启。

配置项均以 `remote-control.` 为前缀；部署环境显式配置 `false` 时仍可关闭。

| 配置项 | 环境变量 | 默认值 |
| --- | --- | --- |
| agent-summary-enabled | REMOTE_AGENT_SUMMARY_ENABLED | true |
| agent-selection-enabled | REMOTE_AGENT_SELECTION_ENABLED | true |
| agent-ownership-claim-enabled | REMOTE_AGENT_OWNERSHIP_CLAIM_ENABLED | true |
| dual-approval-enabled | REMOTE_DUAL_APPROVAL_ENABLED | true |
| input.enabled | REMOTE_INPUT_ENABLED | true |
| input-assets.enabled | REMOTE_INPUT_ASSETS_ENABLED | true |
| files.read-enabled | REMOTE_FILES_READ_ENABLED | true |
| files.input-upload-enabled | REMOTE_FILES_INPUT_UPLOAD_ENABLED | true |
| files.desktop-input-sync-enabled | REMOTE_FILES_DESKTOP_INPUT_SYNC_ENABLED | true |
| files.artifact-publish-enabled | REMOTE_FILES_ARTIFACT_PUBLISH_ENABLED | true |
| files.migration-enabled | REMOTE_FILES_MIGRATION_ENABLED | true |

## 2. 接口信息

已有 HTTP 前缀：`https://<API_HOST>/api/remote/v1`；WS 地址仍使用连接票据接口返回的 `wsUrl`。

| 方法/路径 | 请求 | 用途 |
| --- | --- | --- |
| GET /capabilities | 无 body | 全局开关、协议版本和有效功能 |
| GET /devices?kind=desktop | kind=desktop；无 body | 目标电脑在线状态及协议能力 |
| GET /devices/{deviceId}/input-capabilities | 路径中的目标电脑 ID；无 body | 目标电脑的输入/模型/附件实际可用性和限制 |
| GET /devices/{deviceId}/agents | 目标电脑 ID；无 body | 当前可选 Agent 目录 |
| GET /devices/{deviceId}/models | 目标电脑 ID；无 body | 已发布模型目录 |

能力探测请求示例：

```http
GET /api/remote/v1/capabilities
Authorization: Bearer <accessToken>
```

响应仍使用既有 envelope。以下为文件功能被环境变量显式关闭、基础和输入开关采用新默认值时的字段摘录（不是完整响应）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "enabled": true,
    "protocolVersions": [1],
    "projectionVersions": [1, 2],
    "features": {
      "sessionRead": true,
      "sessionControl": true,
      "remoteApproval": true,
      "textInput": true,
      "modelSelection": true,
      "fileUpload": false,
      "artifactDownload": false,
      "artifactPublish": false,
      "cloudExecution": false
    }
  }
}
```

`capabilities` 数组也应按实际返回读取。模型、Agent、审批能力仍要与目标桌面的能力共同判断；全局 `modelSelection=true` 不代表目标电脑已经发布可用模型目录。文件相关 `false` 可能表示配置开关关闭或存储适配不可用，需结合实际环境判断；默认 share-gateway 不要求另配 NOS 凭据。云端执行尚不支持，没有本次可打开的配置开关。

完整字段、分页、错误和请求示例见服务端文档：[基础接入](../../../lobsterai-server/docs/api/mobile-remote-api.md)、[输入 v2](../../../lobsterai-server/docs/api/mobile-remote-input-v2.md)、[文件同步](../../../lobsterai-server/docs/api/mobile-remote-files-api.md)。

## 3. 客户端接入事项

- 服务端升级后重新查询全局和目标电脑能力；桌面按已实现的能力协商发布 Agent/模型目录并同步数据。不要把新默认值硬编码成 UI 可用状态。
- App 根据目标电脑 input-capabilities 中的 `supported`、`available`、目录和限制开放模型、思考选项和附件入口。旧客户端或未发布目录的电脑继续按原兼容行为处理。
- 双端审批只开放已协商且允许远程处理的类别；匿名任务/Agent 仍需桌面明确关联归属，开关开启不会自动归属或上传全部历史。
- 文件上传、读取、产物同步分别判断实际能力；维持断线核对和既有持久队列，不能因开关变化清空原命令或重跑任务。

## 4. 认证要求

远控仍使用现有账号 JWT Bearer，不用登录 Cookie 代替。除注册与全局能力查询外，设备接口携带 `X-Remote-Device-Credential: <deviceId>.<deviceKey>`，服务端继续验证同账号/空间、目标电脑权限及设备凭证。

协商输入 v2 后使用 `X-Remote-Projection-Version: 2`；文件能力协商通过后使用投影 3。请求 JSON 时带 `Content-Type: application/json`，GET 无 body。长期 token 和设备密钥不得放入 WS URL。

## 5. 生效、迁移和验证

- 新默认值随服务端部署并重启生效；开关调整未修改实际 Pod 环境变量或部署；后续测试库 V93 迁移已执行。测试/生产配置未单独覆盖；若部署仍显式设置 `REMOTE_…=false`，对应能力会继续关闭。
- 本次开关默认值调整没有新增 SQL；后续分享网关接入另有 V93。目标环境仍须具备已有 V88–V92 的兼容结构；已执行迁移不重复执行。生产库未在本次操作。
- 如仍有不兼容旧节点，滚动升级期间通过环境变量显式关闭新增能力，全部节点兼容后解除覆盖。新默认值不改变旧客户端能力协商和已受理命令核对契约。
- 默认已改为 share-gateway，复用现有分享 NOS 上传服务，无需新增独立 bucket/AK/SK；实际读写仍依赖网关及有效存储位置。迁移开关仅用于已上传旧云端资产，不扫描本机历史文件。
- 服务端 `compileJava`、`compileTestJava` 离线编译通过，未运行服务端测试；本接入说明未改桌面代码，无需执行桌面测试。真实环境能力仍以部署后的接口返回为准。
