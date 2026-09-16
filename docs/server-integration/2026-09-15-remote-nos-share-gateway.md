# 远控文件复用现有分享 NOS 网关

日期：2026-09-15。消费项目：LobsterAI 桌面端；手机 App 沿用既有文件 API。

## 1. 变更摘要

按用户要求，远控输入附件和产物上传复用服务端已有 `NosUploadService`：`https://luna-nos.youdao.com/backend/upload`，沿用 `product=lobsterai`。默认配置 `remote-control.files.nos.active-profile=share-gateway`，provider 仍为 `nos`。不需要新增 bucket、endpoint、AK/SK 或客户端存储配置，11 项远控开关仍默认开启，显式 false 覆盖保留。

服务器记录可信网关上传响应的位置，按分片主键 CAS 保存。原 object_key 和分片标识不变，重启或命中其他 Pod 后仍可读取；旧 TOS/直连 NOS 对象继续按自身 provider/profile 路由。原 `remote-files` 凭据配置仅供已有直连历史兼容。CAS 只保护已收到并登记的位置；网关上传成功但响应丢失、或 URL 落库前进程崩溃仍可能产生未登记孤儿。网关没有幂等查询协议，不承诺上传 exactly-once 或自动查回这些对象。

## 2. 接口信息

客户端接口、请求/响应字段、投影与 WS 协议均未改变。以下路径以 `/api/remote/v1` 为前缀：

| 方法/路径 | 请求 | 结果 |
| --- | --- | --- |
| GET /capabilities | 无 body，Bearer | 全局功能及协议能力 |
| GET /devices/{deviceId}/input-capabilities | 目标电脑 ID、设备凭证；无 body | 目标电脑实际输入/附件能力和限制 |
| PUT /input-assets/{assetId}/parts/{partNo} | 既有分片字节及摘要 headers | 原分片回执，不返回原始 NOS URL |
| POST /input-assets/{assetId}/complete | 原全文件 sha256 | 原资产状态和元信息 |
| GET /input-assets/{assetId}/content | 原 preparation 或历史会话/消息上下文 | 鉴权后的二进制内容 |
| GET /sessions/{sessionId}/artifacts/{artifactId}/versions/{version}/content | 原会话/产物/版本 ID | 鉴权后的产物内容 |

能力探测仍为：

```http
GET /api/remote/v1/capabilities
Authorization: Bearer <accessToken>
```

文件能力有效时的响应字段摘录如下；此示例不代表环境已部署或网关真实读写已验证：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "features": {
      "fileUpload": true,
      "artifactDownload": true,
      "artifactPublish": true
    }
  }
}
```

完整契约与原示例见[文件接入文档](../../../lobsterai-server/docs/api/mobile-remote-files-api.md)和[输入 v2](../../../lobsterai-server/docs/api/mobile-remote-input-v2.md)。服务端存储位置不作为 App/桌面的配置或 API 参数。

## 3. 客户端接入事项

本次无需桌面或 App 增加接口字段、NOS 地址或密钥。继续按全局和目标电脑实际 capabilities 决定入口，保留分片重试、摘要、准备、历史引用及断线恢复流程。文件传输仍走原服务端 HTTPS，WS 仅同步状态，不直接连接分享上传网关或读取原始 NOS URL。

分享网关不可达、内容已失效或服务器返回可恢复错误时，保留原队列并核对，不将其视为模型执行失败，也不因存储切换重新执行任务。

## 4. 认证与存储边界

应用文件 API 仍使用账号 JWT Bearer、`X-Remote-Device-Credential` 和原任务/消息/准备上下文。服务端检查同账号、同空间及 grant 后读取并返回内容；原始 URL 仅保存在服务端数据库，不下发客户端，不接受客户端自带地址。

服务端读取可信上传返回的 HTTPS `*.nosdn.127.net` 地址。底层存储、URL 访问及保留语义按用户要求沿用现有分享网关：不再要求独立私有 bucket，也不声称原始 NOS URL 具备账号鉴权或长期保留已独立验证。应用 API 的权限校验与原始 URL 的访问性质不能混为一谈。

## 5. 数据库、发布与清理

- 新增 [V93__remote_nos_share_gateway.sql](../../../lobsterai-server/sql/V93__remote_nos_share_gateway.sql)：仅为 `remote_input_asset_parts` 添加可空 `gateway_url VARCHAR(2048)`，MySQL 5.7 兼容、无外键。测试库已于 2026-09-15 执行并通过全表结构校验，生产库尚未执行；详见[测试库 V93 执行记录](../../../lobsterai-server/docs/operations/2026-09-15-test-v93.md)。不回改已执行的 V88–V92。
- 目标环境先应用 V93（测试库已完成，不重复执行）；滚动期间将 `REMOTE_FILES_INPUT_UPLOAD_ENABLED=false`、`REMOTE_FILES_ARTIFACT_PUBLISH_ENABLED=false`、`REMOTE_FILES_MIGRATION_ENABLED=false`，暂停三项新写入（桌面输入也受 input-upload 控制）。全部4个Pod更新为兼容版本后恢复true；无需新增基础设施，不能回滚到不识别share-gateway的旧代码。本次未部署或重启实际服务，也没有上传用户文件。
- 新写入及迁移目标为 share-gateway。旧文件继续按记录中的源 provider/profile 读取，逐片/整文件校验后再切换；原 assetId、版本和引用保留。
- 删除复用 `html_share_nos_delete_files` 待清理记录。`pending` 不表示物理删除，既有清理流程实际标为 `deleted` 后才确认完成并释放额度。未处理时继续保留占用；全部待删分片均入队，资产按 `updated_at,id` 轮转，避免常驻前50条阻塞后续清理。`cleanup.queued` 表示等待物理确认，不是成功。本次未新增物理删除 worker 或分享网关 DELETE API。

本轮服务端 `compileJava`、`compileTestJava` 均通过，未执行服务端测试；此前文件Spec §17测试记录属于旧实现，不能视为share-gateway测试已运行。本次未改桌面代码。

详细实现和最新存储边界见[文件 Spec §18](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-15-remote-file-sync-nos.md#18-2026-09-15-复用现有文件分享-nos-网关)。
