# 远程回复内容 v4：桌面与 App 接入

日期：2026-09-16。桌面和服务端实现已落地，未部署；V94已在测试库执行并校验，生产尚未执行（[迁移记录](../../../lobsterai-server/docs/operations/2026-09-16-test-v94.md)）；App工程不在工作区，需要按本文和服务端契约继续适配。

## 变更摘要

服务端新增能力 `reply_content_v1`、投影4、`message.delta`、`displayOrdinal` 和版本化正文分片接口。桌面发布正文、显式思考、工具参数／输出／错误、可见通知；旧客户端保留兼容表示。现有 WS 地址、transport protocolVersion=1、任务执行和文件NOS协议不变。

权威文档：

- 服务端 Spec：`../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-16-reply-content-parity.md`。
- App 接入：`../../../lobsterai-server/docs/api/mobile-remote-reply-content-v4.md`。
- 迁移：`../../../lobsterai-server/sql/V94__remote_reply_content.sql`。

从本文件相对链接访问：[Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/feature-2026-09-16-reply-content-parity.md)／[App API](../../../lobsterai-server/docs/api/mobile-remote-reply-content-v4.md)。如果两个仓库不在同级，按上述文件名定位。

## 接口和认证

Base `/api/remote/v1`，继续使用 JWT Bearer、当前账号空间和既有设备身份头，新增 `X-Remote-Projection-Version: 4`。所有读写校验会话归属及设备访问权限。

| 方法 | 路径 | 调用方 |
| --- | --- | --- |
| GET | `/capabilities` | 双端协商 `reply_content_v1` 和projectionVersions包含4 |
| POST | `/connection-tickets` | 原ticket接口，请求包含protocolVersion=1、projectionVersion=4 |
| PUT | `/sessions/{sid}/contents/chunks/{sha256}` | 所属桌面上传UTF-8文本分片 |
| PUT | `/sessions/{sid}/contents/{cid}/versions/{version}` | 所属桌面提交不可变版本清单 |
| GET | `/sessions/{sid}/contents/{cid}/versions/{version}` | App读取已发布正文的元信息 |
| GET | `/sessions/{sid}/contents/{cid}/versions/{version}/chunks?cursor=...` | App按固定版本读取分片 |

上传chunk请求示例：

```json
{"deviceId":"desktop_01","connectionGeneration":"8","mode":"online","text":"分片原文"}
```

响应示例：

```json
{"code":0,"message":"success","data":{"sha256":"<SHA256>","sizeBytes":"12"}}
```

版本上传包含 `messageId/blockId/format/sizeBytes/sha256/chunks`，chunks为完整有序的hash+sizeBytes数组；上传ACK严格校验后才能发布消息引用。详情响应含contentId/version/sizeBytes/sha256/format/messageId/blockId/chunkCount；分片响应含items(index/text/sha256/sizeBytes)和nextCursor，详细示例见App API。

## 桌面侧已接入

- RemoteStore保存完整投影，以稳定blockId组织内容，并仅对纯追加生成delta；不直接转发runtime完整文本作为追加。
- RemoteBridge约300ms调度普通发送，工具开始和终态、审批、任务终态优先唤醒。
- 大正文先上传分片、再清单、最后消息引用；快照先begin创建会话，再上传正文，再parts/commit。
- 账号、空间、设备或服务地址变化时停止旧发布上下文；协议变化要求新快照，重启时也检查持久投影模式。
- 本地metadata与renderer共用合并规则；保留remoteRunId/remoteCommandId归属。
- 配额超限暂停该会话自动重试，已有内容保留；处理后点击现有“重新连接”恢复。

## App action items

1. 协商v4，在HTTP请求及WS ticket中声明版本；文件能力单独判断。
2. 渲染text/markdown/thinking/tool_input/tool_output/notice/error，按displayOrdinal排序，仍关联toolCallId和现有附件／产物块。
3. delta仅在baseRevision及UTF-8 offset匹配时append，否则按messageId和minRevision补详情；不要混合不同版本内容。
4. contentRef固定版本分页读取，每片32KiB、每页4片，校验分片／总hash；显示加载失败、超限和未完整状态。
5. 保留事件seq恢复、身份隔离、权限撤销和退出登录缓存清理；关闭功能不等于删除本地历史。

## 上线与限制

V94须在部署新服务端前执行，兼容MySQL5.7，无外键；测试库已执行。按用户要求，`remote-control.reply-content-enabled=${REMOTE_REPLY_CONTENT_ENABLED:true}` 和Java初始值均默认true，test/prod未覆盖时均自动开启，无需额外启动参数。可用 `REMOTE_REPLY_CONTENT_ENABLED=false` 或 `--remote-control.reply-content-enabled=false` 显式关闭；新旧服务节点混合期间显式关闭，全部升级后解除覆盖。现有远控开关默认值未变。旧App收到同seq的message.ref／兼容块；旧桌面继续旧投影。App UI和真实设备联调尚未完成。

正文16KiB以上外置，单块最多16MiB，正文会话256MiB／账号空间1GiB（分片+清单）；会话5000个清单、账号空间50000个。超限明确提示，原文留在桌面。实际附件、图片、视频等仍用已有NOS协议；任意Markdown中的本地路径不会自动变成手机可访问URL。
