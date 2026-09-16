# 远控模型选择与桌面对齐修复

日期：2026-09-16。状态：桌面与服务端代码已修复并完成本地验证，未部署；App 项目需按现有协议接入。无数据库变更，无新增远控字段。

## 1. 变更摘要

- 桌面主进程缓存保留套餐模型 `accessible`，权限变化参与比较及远控模型版本更新。
- 普通套餐模型不再因 `supportsToolCalling` 缺失或 false 被远控目录误禁用；能力值仍如实保留。Kimi K3 专用运行门控不放宽。
- 思考档位仅在模型可用且具有 `lobsterai-options-v1` 请求能力时公布，与桌面选择器规则一致。
- 服务端个人 `GET /api/models/available` 排除 `mediaType` 非空的图片/视频生成模型，与企业目录边界一致；支持图片输入的对话模型保留。
- 套餐、自定义来源以及同名不同提供方的模型引用保持区分；自定义凭据、URL、内部运行器引用不会发布给 App。

## 2. 接口及示例

### 桌面取得套餐目录

`GET /api/models/available`，无请求体。沿用 `Authorization: Bearer <accessToken>` 及现有客户端能力请求头，不增加新认证。

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {"modelId": "chat-model", "modelName": "对话模型", "accessible": true, "supportsToolCalling": null},
    {"modelId": "restricted-model", "modelName": "受限模型", "accessible": false, "restrictionHint": "订阅套餐/购买加油包可用"}
  ]
}
```

示例仅列关键字段，其余现有字段继续兼容。完整对话目录包含无权限模型，并非只返回当前选中模型。没有 `accessible` 的旧响应沿用桌面兼容行为，不能据此绕过实际调用鉴权。

### App 读取目标电脑目录

`GET /api/remote/v1/devices/{deviceId}/models`，无请求体，沿用：

```http
Authorization: Bearer <accessToken>
X-Remote-Device-Credential: <deviceId>.<deviceKey>
X-Remote-Projection-Version: 2
```

响应 `data.items` 中的典型条目：

```json
{
  "modelRef": "opaque-model-ref",
  "version": "2",
  "source": "subscription",
  "displayName": "对话模型",
  "providerLabel": "LobsterAI",
  "available": true,
  "unavailableReason": null,
  "inputCapabilities": {"text": true, "image": false, "toolCalling": false},
  "thinking": {"options": [], "default": null}
}
```

`toolCalling=false` 不会覆盖 `available=true`。无权限条目为 `available=false, unavailableReason=PERMISSION_DENIED`；专用运行门控失败为 `UNSUPPORTED`。自定义条目为 `source=custom`，只有电脑具备必要配置的已启用模型进入目录。

## 3. 前端接入事项

1. 按 `source` 区分套餐/自定义，按 `deviceId + modelRef + version` 保存选择；不能用名字匹配不同提供方。
2. 使用 `available` 控制可选状态；无权限条目置灰，不根据 `toolCalling` 独立禁用普通模型。
3. `thinking.options` 为空时隐藏档位入口，只允许提交实际返回的选项。
4. 收到 `catalog.changed` 且 `resource=models` 后重拉目录。权限或配置变化使旧版本/旧准备失效时，保留草稿、刷新并重新准备，不自动换模型。
5. 继续沿用输入 v2 的模型 `selected / inherit_agent / keep_session` 和准备后提交流程，没有新增发送参数。

## 4. 认证与权限

远控沿用 Bearer、设备凭据、账号/空间及目标电脑访问资格校验。目录表示电脑最近公布的可用性，不是永久调用授权；套餐实际调用继续受服务端当前权限与配额限制。自定义模型使用电脑本地凭据及网络，App 无需、也不应获取模型 API Key 或服务地址。

## 5. 兼容与上线

推荐先上线服务端过滤修复，再更新桌面；服务端无需 DDL 或新增功能开关。旧桌面的工具能力误禁用问题必须通过桌面更新解决，服务端更新不能代替。

桌面周期发布读取本地元数据，并非每轮重新调用套餐接口。更新服务端后，需桌面刷新模型元数据并重新发布，再由 App 刷新目录；上线瞬间不能保证已有缓存同步改变。本次未修改 App 界面，不承诺模型排序、图标或“更多模型”分组完全一致。

验证：桌面模型缓存/目录/输入准备相关 40 项 Vitest 通过，改动文件 ESLint 无警告，Electron 主进程 TypeScript 检查通过；服务端相关 14 项 Mockito 单元测试通过，未运行依赖外部 MySQL/Redis 的测试。
