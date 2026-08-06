# @crm-agent/model-provider

B-02 的百炼模型适配层。它只接收公共契约输入，并只返回经过运行时 Schema 校验的
`AnalysisResult` 或 `ReplyDraft`；原始响应、非法 JSON 和 Schema 不匹配数据不得进入
业务链路。

## 安全边界

- 通过 `createBailianModelProviderFromEnv()` 从服务端环境读取 `DASHSCOPE_API_KEY`。
- 不接受任意 Base URL；默认使用百炼北京兼容端点，配置 `BAILIAN_WORKSPACE_ID` 时只会
  构造固定的 `*.cn-beijing.maas.aliyuncs.com` HTTPS 地址，避免凭据被发送到其他主机。
- 错误只暴露稳定错误码、失败原因、HTTP 状态和可选请求 ID，不包含 API Key、提示词、
  原始供应商响应或堆栈。
- 默认每次调用最多 2 次尝试；超时、429、5xx、网络错误和非法模型输出可有限重试，
  401 等不可恢复的客户端错误不会重试。
- 使用 `response_format: { type: "json_object" }`，且不会设置可能截断 JSON 的
  `max_tokens`。

## 离线验证

`FakeModelProvider` 接收固定的分析和回复响应，构造时及返回前都使用公共 Schema，适合
在没有百炼密钥时运行 B-03、B-04 和编排测试。

```powershell
pnpm test
```

受控真实调用默认跳过。仅在 G0 门禁允许、使用虚构样例且本地已安全配置密钥时执行：

```powershell
$env:B02_RUN_LIVE_MODEL_TEST='1'
pnpm test -- packages/model-provider/src/bailian-model-provider.live.test.ts
```

不得把密钥、真实客户数据或真实供应商响应写入测试、日志、截图或 PR。
