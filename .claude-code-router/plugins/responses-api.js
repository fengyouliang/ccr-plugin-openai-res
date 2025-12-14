// ~/.claude-code-router/plugins/responses-api.js
class ResponsesAPITransformer {
  name = "responses-api";

  constructor(options) {
    this.options = options || {};
    this.logger = console;
  }

  // 将 CCR 的 {model, messages, tools, stream...} 转成 /v1/responses
  async transformRequestIn(request, provider) {
    const { model, messages = [], stream } = request;
    const originalMaxTokens = typeof request.max_tokens === "number" ? request.max_tokens : undefined;
    
    const ensureStreamFlag = (target) => {
      if (!target || typeof target !== "object") return;
      try {
        Reflect.defineProperty(target, "stream", {
          value: true,
          writable: true,
          configurable: true,
          enumerable: true
        });
      } catch {
        try {
          target.stream = true;
        } catch {
          // 忽略无法写入的情况，后续仍会通过返回体确保 stream=true
        }
      }
    };

    ensureStreamFlag(request);

    if (this.logger?.debug) {
      this.logger.debug(
        {
          provider: provider?.name,
          beforeStreamFlag: stream,
          afterStreamFlag: request?.stream
        },
        "responses-api: enforce stream flag"
      );
    }

    delete request.temperature;
    delete request.max_tokens;

    const stringify = (value) => {
      if (typeof value === "string") return value;
      if (value === undefined) return "";
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const instructionsParts = [];
    if (Array.isArray(request.system)) {
      for (const sys of request.system) {
        if (!sys) continue;
        if (typeof sys === "string") {
          instructionsParts.push(sys);
        } else if (typeof sys === "object") {
          if (typeof sys.text === "string") instructionsParts.push(sys.text);
          if (Array.isArray(sys.content)) {
            for (const part of sys.content) {
              if (part?.type === "text" && typeof part.text === "string") {
                instructionsParts.push(part.text);
              }
            }
          }
        }
      }
    }

    delete request.system;
    const input = [];

    for (const msg of messages) {
      if (!msg) continue;
      if (msg.role === "system") {
        if (typeof msg.content === "string") {
          instructionsParts.push(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === "text" && typeof part.text === "string") {
              instructionsParts.push(part.text);
            }
          }
        }
        continue;
      }

      const message = JSON.parse(JSON.stringify(msg));

      if (Array.isArray(message.content)) {
        const remaining = [];
        for (const part of message.content) {
          if (!part) continue;
          if (part.type === "tool_use") {
            input.push({
              type: "function_call",
              name: part.name || part.function?.name || part.tool_name || part.id || "tool_call",
              arguments:
                typeof part.input === "string"
                  ? part.input
                  : typeof part.arguments === "string"
                    ? part.arguments
                    : stringify(part.input ?? part.arguments ?? {}),
              call_id: part.id || part.tool_call_id || part.call_id || part.name || part.function?.name || "tool_call"
            });
            continue;
          }
          if (part.type === "tool_result") {
            const outputPayload = part.content ?? part.output ?? part.result ?? part.text ?? "";
            input.push({
              type: "function_call_output",
              call_id: part.tool_use_id || part.id || part.call_id || part.name || "tool_call",
              output:
                Array.isArray(outputPayload) || typeof outputPayload === "string"
                  ? outputPayload
                  : stringify(outputPayload)
            });
            continue;
          }
          const cloned = { ...part };
          if (cloned.type === "text") {
            cloned.type = message.role === "assistant" ? "output_text" : "input_text";
          } else if (cloned.type === "image_url") {
            cloned.type = "input_image";
            cloned.image_url = cloned.image_url?.url || cloned.url || cloned.image_url;
            delete cloned.media_type;
          }
          delete cloned.cache_control;
          remaining.push(cloned);
        }
        message.content = remaining;
      } else if (typeof message.content === "string") {
        message.content = [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content
          }
        ];
      }

      delete message.cache_control;

      if (message.role === "tool") {
        const outputPayload = msg.content ?? msg.output ?? "";
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || msg.id || msg.name || "tool_call",
          output:
            Array.isArray(outputPayload) || typeof outputPayload === "string"
              ? outputPayload
              : stringify(outputPayload)
        });
        continue;
      }

      if (message.role === "assistant") {
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          for (const toolCall of msg.tool_calls) {
            input.push({
              type: "function_call",
              name: toolCall?.function?.name || toolCall?.name || toolCall?.id || "tool_call",
              arguments:
                typeof toolCall?.function?.arguments === "string"
                  ? toolCall.function.arguments
                  : stringify(toolCall?.function?.arguments ?? {}),
              call_id: toolCall?.id || toolCall?.name || toolCall?.function?.name || "tool_call"
            });
          }
          continue;
        }

        if (message.function_call) {
          input.push({
            type: "function_call",
            name: message.function_call?.name || message.name || "tool_call",
            arguments:
              typeof message.function_call?.arguments === "string"
                ? message.function_call.arguments
                : stringify(message.function_call?.arguments ?? {}),
            call_id: message.id || message.function_call?.name || "tool_call"
          });
          continue;
        }

        if (message.tool_call_id) {
          input.push({
            type: "function_call",
            name: message.name || "tool_call",
            arguments: stringify(msg.content ?? {}),
            call_id: message.tool_call_id
          });
          continue;
        }
      }

      if (Array.isArray(message.content) && message.content.length === 0) {
        continue;
      }

      input.push(message);
    }

    if (instructionsParts.length > 0) {
      request.instructions = instructionsParts.join("\n\n");
    }

    request.input = input;
    delete request.messages;

    if (Array.isArray(request.tools)) {
      const webSearchTool = request.tools.find(
        (tool) => tool?.function?.name === "web_search"
      );
      request.tools = request.tools.map((tool) => {
        if (!tool) return tool;
        if (tool.type === "function" && tool.function) {
          const { name, description, parameters, response } = tool.function;
          const normalized = { type: "function" };
          if (name !== undefined) normalized.name = name;
          if (description !== undefined) normalized.description = description;
          if (parameters !== undefined) normalized.parameters = parameters;
          if (response !== undefined) normalized.response = response;
          return normalized;
        }
        return tool;
      });
      if (webSearchTool) {
        const hasPreview = request.tools.some((tool) => tool?.type === "web_search_preview");
        if (!hasPreview) {
          request.tools.push({ type: "web_search_preview" });
        }
      }
    }

    // 组包给 Responses API
    const shouldStream = true;
    if (stream !== true && this.logger?.warn) {
      this.logger.warn(
        {
          provider: provider.name,
          requestedStream: stream
        },
        "responses-api: forcing stream=true for Responses API compatibility"
      );
    }
    const body = {
      model,
      input,
      stream: shouldStream
    };

    if (typeof request.instructions === "string" && request.instructions.trim()) {
      body.instructions = request.instructions;
    }

    if (Array.isArray(request.tools) && request.tools.length > 0) {
      body.tools = request.tools;
    }

    if (request.metadata && typeof request.metadata === "object") {
      body.metadata = request.metadata;
    }

    if (request.response_format !== undefined) {
      body.response_format = request.response_format;
    }

    if (request.tool_choice !== undefined) {
      body.tool_choice = request.tool_choice;
    }

    if (request.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = request.parallel_tool_calls;
    }

    if (request.max_output_tokens !== undefined) {
      body.max_output_tokens = request.max_output_tokens;
    } else if (originalMaxTokens !== undefined) {
      body.max_output_tokens = originalMaxTokens;
    }

    if (request.user !== undefined) {
      body.user = request.user;
    }

    // ===== Fix: sanitize CCR-style reasoning.enabled for Responses API =====
    const flatEnabled = request["reasoning.enabled"];
    const flatEffort = request["reasoning.effort"];

    const enabled =
      (request.reasoning && typeof request.reasoning === "object" && request.reasoning.enabled === true) ||
      flatEnabled === true;

    const effort =
      (request.reasoning && typeof request.reasoning === "object" ? request.reasoning.effort : undefined) ||
      flatEffort;

    delete request["reasoning.enabled"];
    delete request["reasoning.effort"];

    if (request.reasoning && typeof request.reasoning === "object") {
      delete request.reasoning.enabled;
      delete request.reasoning.max_tokens;
    }

    // 从 transformer options 读默认值（来自 config.json）
    const defaultEffort =
      this.options?.reasoning_effort ||
      this.options?.effort ||
      this.options?.reasoning?.effort;

    // request 优先，其次 default
    const finalEffort = (typeof effort === "string" && effort.trim())
      ? effort.trim()
      : (typeof defaultEffort === "string" && defaultEffort.trim())
        ? defaultEffort.trim()
        : undefined;

    if (finalEffort) {
      body.reasoning = { effort: finalEffort };
    } else if (enabled) {
      body.reasoning = { effort: "medium" };
    }
    // ===== End fix =====
    
    if (request.reasoning !== undefined) {
      body.reasoning = request.reasoning;
    }

    if (request.modalities !== undefined) {
      body.modalities = request.modalities;
    }

    // 让 CCR 直接请求你配置的 api_base_url
    const baseUrl = provider.baseUrl || provider.api_base_url;
    if (!baseUrl) {
      throw new Error(`Provider ${provider.name || "<unknown>"} missing baseUrl`);
    }
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/responses")) {
      url.pathname = `${url.pathname.replace(/\/?$/, "")}/responses`;
    }
    if (this.logger?.debug) {
      this.logger.debug(
        {
          provider: provider.name,
          targetUrl: url.toString()
        },
        "responses-api.transformRequestIn"
      );
    } else {
      console.log("responses-api.transformRequestIn", provider.name, url.toString());
    }
    const apiKey = provider.apiKey || provider.api_key;
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };

    return { body, config: { url, headers } };
  }

  // 将 Responses API 的 JSON/流式响应转回 OpenAI Chat Completions 形态
  async transformResponseOut(response) {
    const ct = response.headers.get("Content-Type") || "";

    // 非流式：JSON 直接一次性改造成 chat.completion
    if (ct.includes("application/json")) {
      const j = await response.json();

      // 兼容多种 responses 输出结构：OpenAI Responses 通常在 output[] 中给文本
      const texts = [];
      const outputArray = Array.isArray(j.output) ? j.output : [];
      for (const o of outputArray) {
        if (o && (o.type === "output_text" || o.type === "message")) {
          if (typeof o.text === "string") texts.push(o.text);
          if (Array.isArray(o.content)) {
            texts.push(
              o.content
                .filter((c) => c.type === "output_text" || c.type === "text")
                .map((c) => c.text || "")
                .join("")
            );
          }
        }
      }
      const content = texts.filter(Boolean).join("");

      const res = {
        id: j.id || "",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: j.model || "",
        choices: [
          {
            index: 0,
            finish_reason: (j.status ?? "stop") === "stop" ? "stop" : j.status || "stop",
            message: {
              role: "assistant",
              content
            }
          }
        ],
        usage: j.usage || undefined
      };

      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 流式：把 Responses API 的 SSE 逐段转为 chat.completion.chunk
    if (ct.includes("text/event-stream") || ct.includes("stream")) {
      if (!response.body) return response;

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      const toolCallState = new Map();
      const toolCallOrder = [];
      let hasSentInitialRole = false;

      const registerToolCall = (key, state) => {
        if (!key) return;
        toolCallState.set(key, state);
      };

      const findToolCallState = (key) => {
        if (!key) return undefined;
        return toolCallState.get(key);
      };

      const emitChunk = (controller, chunk) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };

      const createChunk = (evt, delta, finishReason = null) => {
        const sanitizedDelta = {};
        if (delta.role !== undefined) sanitizedDelta.role = delta.role;
        if (delta.content !== undefined) sanitizedDelta.content = delta.content;
        if (delta.tool_calls !== undefined) sanitizedDelta.tool_calls = delta.tool_calls;
        if (delta.annotations !== undefined) sanitizedDelta.annotations = delta.annotations;

        return {
          id: evt?.id || evt?.item_id || evt?.item?.id || evt?.response?.id || "",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: evt?.model || evt?.response?.model || "",
          choices: [
            {
              index: evt?.output_index ?? 0,
              delta: sanitizedDelta,
              finish_reason: finishReason
            }
          ]
        };
      };

      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body.getReader();
          let buffer = "";

          const flushLine = (line) => {
            if (!line.startsWith("data:")) return;
            const payload = line.slice(5).trim();
            if (!payload) return;

            try {
              const evt = JSON.parse(payload);

              if (evt?.type === "response.output_item.added") {
                if (evt.item?.type === "function_call") {
                  const key = evt.item.id || evt.item.call_id || `tool_${toolCallOrder.length}`;
                  const callId = evt.item.call_id || evt.item.id || key;
                  const index = toolCallOrder.length;
                  toolCallOrder.push(key);
                  const state = {
                    callId,
                    index,
                    name: evt.item.name || ""
                  };
                  registerToolCall(key, state);
                  if (evt.item.call_id && evt.item.call_id !== key) {
                    registerToolCall(evt.item.call_id, state);
                  }

                  const delta = {
                    tool_calls: [
                      {
                        index,
                        id: callId,
                        type: "function",
                        function: {
                          name: evt.item.name || "",
                          arguments: ""
                        }
                      }
                    ]
                  };

                  if (!hasSentInitialRole) {
                    delta.role = "assistant";
                    hasSentInitialRole = true;
                  }

                  emitChunk(controller, createChunk(evt, delta, null));
                  return;
                }

                return;
              }

              if (evt?.type === "response.function_call_arguments.delta") {
                const state = findToolCallState(evt.item_id) || findToolCallState(evt.call_id);
                const index = state?.index ?? 0;

                const delta = {
                  tool_calls: [
                    {
                      index,
                      function: {
                        arguments: evt.delta || ""
                      }
                    }
                  ]
                };

                if (!hasSentInitialRole) {
                  delta.role = "assistant";
                  hasSentInitialRole = true;
                }

                emitChunk(controller, createChunk(evt, delta, null));
                return;
              }

              if (evt?.type === "response.function_call_arguments.done") {
                const state = findToolCallState(evt.item_id) || findToolCallState(evt.call_id);
                if (state) {
                  state.finalArguments = evt.arguments;
                }
                return;
              }

              // 常见的 OpenAI Responses 事件：
              // - { type: "response.delta", delta: { content: [ {type:"output_text.delta", text:"..."} ] } }
              // - { type: "response.output_text.delta", text: "..." }（某些兼容端点）
              // - { type: "response.completed" } 结束
              let deltaText = "";
              const appendDelta = (value) => {
                if (typeof value === "string") {
                  deltaText += value;
                } else if (Array.isArray(value)) {
                  for (const item of value) appendDelta(item);
                } else if (value && typeof value === "object") {
                  if (typeof value.text === "string") deltaText += value.text;
                  if (typeof value.delta === "string") deltaText += value.delta;
                  if (Array.isArray(value.content)) {
                    for (const inner of value.content) appendDelta(inner);
                  }
                }
              };

              if (evt?.type === "response.delta" && evt.delta?.content) {
                for (const part of evt.delta.content) {
                  if (
                    part.type === "output_text.delta" ||
                    part.type === "text.delta" ||
                    part.type === "output_text"
                  ) {
                    appendDelta(part.text ?? part.delta ?? part);
                  }
                }
              } else if (
                evt?.type === "response.output_text.delta" ||
                evt?.type === "output_text.delta" ||
                evt?.type === "text.delta"
              ) {
                if (typeof evt.delta === "string") {
                  deltaText += evt.delta;
                } else {
                  appendDelta(evt.text ?? evt.delta);
                }
              }

              // 结束事件：发一个 finish chunk
              if (evt?.type === "response.completed") {
                const done = {
                  id: evt.id || "",
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: evt.model || "",
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason:
                        Array.isArray(evt.response?.output) &&
                        evt.response.output.some((item) => item?.type === "function_call")
                          ? "tool_calls"
                          : "stop"
                    }
                  ]
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));
                return;
              }

              // 正常内容增量
              if (deltaText) {
                const delta = {};
                if (!hasSentInitialRole) {
                  delta.role = "assistant";
                  hasSentInitialRole = true;
                }
                delta.content = deltaText;
                emitChunk(controller, createChunk(evt, delta, null));
              }
            } catch (e) {
              // 忽略无法解析的行，避免中断
            }
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer) flushLine(buffer);
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) flushLine(line);
          }
          controller.close();
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }

    // 其它情况原样返回
    return response;
  }
}

module.exports = ResponsesAPITransformer;
