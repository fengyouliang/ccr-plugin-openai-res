# CCR 插件 · OpenAI Responses 转换器

[English README](./README.md)

该仓库收录了自定义的 Claude Code Router 转换器 `responses-api`，用于将 Claude Code 的请求和流式响应转换为 OpenAI Responses API 兼容格式。如果这个项目对你有帮助，欢迎点个 ⭐️ 支持一下！

## 主要特性

- 保留 Claude Code 的系统指令、元数据以及 `max_tokens` 等上下文参数。
- 将工具定义映射为 Responses API 需要的 `{ type: "function", name, parameters }` 结构，解决工具调用报错问题。
- 支持 `response.output_item.added`、`response.function_call_arguments.delta` 等事件，能够在 Chat Completions 流中正确生成 `tool_calls` 增量。

## 使用方法

1. 将 `.claude-code-router/plugins/responses-api.js` 复制到本地的 Claude Code Router 配置目录（通常是 `~/.claude-code-router/plugins`）。
2. 在 `~/.claude-code-router/config.json` 中的 `transformers` 字段添加：

   ```json
   {
     "path": "~/.claude-code-router/plugins/responses-api.js"
   }
   ```

3. 重启 Claude Code Router，重新发起需要工具调用的请求以验证行为。


## 注意

```json
{
  "API_TIMEOUT_MS": 600000,
  "LOG": true,
  "Providers": [
    {
      "name": "codex-responses",
      "api_base_url": "https://right.codes/codex/v1/responses",
      "api_key": "$RIGHTCODE_CCR_API_KEY",
      "models": ["gpt-5.2"],
      "transformer": {
        "use": ["responses-api"]
      }
    }
  ],
  "transformers": [
    {
      "path": "/home/feng/.claude-code-router/plugins/responses-api.js",
      "options": {"reasoning_effort": "xhigh"}
    }
  ],
  "Router": {
    "default": "codex-responses,gpt-5.2"
  }
}
```
config.json 格式不允许修改，不可以进行格式化如下格式
```json
{
  "API_TIMEOUT_MS": 600000,
  "LOG": true,
  "Providers": [
    {
      "name": "codex-responses",
      "api_base_url": "https://right.codes/codex/v1/responses",
      "api_key": "$RIGHTCODE_CCR_API_KEY",
      "models": [
        "gpt-5.2"
      ],
      "transformer": {
        "use": [
          "responses-api"
        ]
      }
    }
  ],
  "transformers": [
    {
      "path": "/home/feng/.claude-code-router/plugins/responses-api.js",
      "options": {
        "reasoning_effort": "xhigh"
      }
    }
  ],
  "Router": {
    "default": "codex-responses,gpt-5.2"
  }
}
```

## 许可协议

本项目遵循 [MIT License](./LICENSE)。
