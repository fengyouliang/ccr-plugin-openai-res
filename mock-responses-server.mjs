import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_LOG_PATH = process.env.MOCK_REQUEST_LOG_PATH || "./mock-responses-requests.log";
const requestLogPath = resolve(process.cwd(), REQUEST_LOG_PATH);
const requestLogReady = ensureDirForFile(requestLogPath);
let requestLogQueue = Promise.resolve();

// 简单内存“状态”，方便 previous_response_id 续写
const responses = new Map();

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function ensureDirForFile(filePath) {
  const dir = dirname(filePath);
  if (!dir || dir === ".") return Promise.resolve();
  return mkdir(dir, { recursive: true });
}

function enqueueRequestLog(entry) {
  const text = `${JSON.stringify(entry, null, 2)}\n\n`;
  requestLogQueue = requestLogQueue
    .then(() => requestLogReady)
    .then(() => appendFile(requestLogPath, text, "utf8"))
    .catch((err) => {
      console.error("Failed to write request log:", err);
    });
  return requestLogQueue;
}

function isProbablyJsonRequest(req) {
  const ct = req.headers["content-type"];
  if (typeof ct !== "string") return false;
  return ct.includes("application/json");
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let done = false;
    const chunks = [];
    let totalBytes = 0;

    function finish(err, value) {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(value);
    }

    req.on("aborted", () => {
      finish(Object.assign(new Error("Request aborted by client"), { code: "REQUEST_ABORTED" }));
    });

    req.on("error", (err) => finish(err));

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        // 主动断开，避免继续读入超大 body
        req.destroy();
        finish(Object.assign(new Error(`Request body too large (>${maxBytes} bytes)`), { code: "BODY_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      finish(null, Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function readJsonBody(req, { maxBytes }) {
  const contentLengthHeader = req.headers["content-length"];
  if (typeof contentLengthHeader === "string") {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw Object.assign(new Error(`Request body too large (Content-Length=${contentLength} > ${maxBytes})`), {
        code: "BODY_TOO_LARGE",
      });
    }
  }

  const raw = await readRequestBody(req, maxBytes);
  if (!raw.trim()) return { json: {}, raw: "" };

  try {
    return { json: JSON.parse(raw), raw };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.code = "INVALID_JSON";
    e.rawBody = raw;
    throw e;
  }
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// 把 input 规范化成 Items（这里只处理 string / array 两种常见情况）
function normalizeInputToItems(input) {
  if (input == null) return [];
  if (typeof input === "string") {
    return [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: input }],
    }];
  }
  if (Array.isArray(input)) return input;
  // 兜底：不认识就包一层
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: JSON.stringify(input) }],
  }];
}

function extractUserText(items) {
  // 只抽最常用的 message/input_text
  const texts = [];
  for (const it of items) {
    if (it?.type === "message" && it.role === "user") {
      for (const c of it.content || []) {
        if (c?.type === "input_text" && typeof c.text === "string") texts.push(c.text);
      }
    }
  }
  return texts.join("\n");
}

function extractFunctionCallOutputs(items) {
  // function_call_output 继续对话时会用到
  const outs = [];
  for (const it of items) {
    if (it?.type === "function_call_output") outs.push(it);
  }
  return outs;
}

// 一个很简单的“决策器”：
// - 如果用户提到 "weather/天气" 且 tools 里有 get_weather，就让模型先 function_call
// - 如果这次输入里带 function_call_output，就生成最终回答
function planResponse({ userText, tools, toolOutputs, previous }) {
  // 有 tool 输出：合成最终回答
  if (toolOutputs.length > 0) {
    const joined = toolOutputs.map(o => o.output ?? "").join("\n");
    return { kind: "final_text", text: `（mock）我已拿到工具结果：\n${joined}` };
  }

  const hasWeatherIntent = /weather|天气/i.test(userText);
  const hasGetWeatherTool = Array.isArray(tools) && tools.some(t => t?.type === "function" && t?.function?.name === "get_weather");

  if (hasWeatherIntent && hasGetWeatherTool) {
    // 这里你也可以更复杂地抽取 location
    const argsObj = { location: "Tokyo" };
    return { kind: "function_call", name: "get_weather", argumentsJson: JSON.stringify(argsObj) };
  }

  // 默认：直接回文本
  return { kind: "final_text", text: `（mock）你刚才说：${userText}` };
}

function buildMessageItem(text) {
  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function buildFunctionCallItem({ name, argumentsJson }) {
  // function_call 的 arguments 通常是 string（便于流式 delta 拼接）
  return {
    id: `fc_${randomUUID().replaceAll("-", "")}`,
    type: "function_call",
    call_id: `call_${randomUUID().replaceAll("-", "")}`,
    name,
    arguments: "", // 流式时会用 delta 填充；非流式直接给全量也行
  };
}

async function handleResponsesApi(req, res) {
  const requestStartedAt = new Date().toISOString();

  let body;
  let rawBody = "";
  try {
    // 兼容 curl/SDK：即使没写 content-type，也尽量按 JSON 解析
    // 若你希望更严格，可以改成：if (!isProbablyJsonRequest(req)) 415
    const parsed = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
    body = parsed.json ?? {};
    rawBody = parsed.raw ?? "";
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const errorEntry = {
      timestamp: requestStartedAt,
      method: req.method,
      url: req.url,
      remoteAddress: req.socket?.remoteAddress,
      remotePort: req.socket?.remotePort,
      headers: req.headers,
      rawBody: typeof e.rawBody === "string" ? e.rawBody : undefined,
      error: { message: e.message, code: e.code },
    };
    void enqueueRequestLog(errorEntry);

    if (e.code === "BODY_TOO_LARGE") {
      return jsonResponse(res, 413, { error: { message: e.message, code: e.code } });
    }
    if (e.code === "INVALID_JSON") {
      return jsonResponse(res, 400, { error: { message: e.message, code: e.code } });
    }
    return jsonResponse(res, 500, { error: { message: e.message ?? "Internal error" } });
  }

  // 打印请求的所有参数（以及 headers，方便排查 SDK/代理行为）
  console.log("============================================================");
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log("[headers]");
  console.log(JSON.stringify(req.headers, null, 2));
  console.log("[body]");
  console.log(JSON.stringify(body, null, 2));

  const requestEntry = {
    timestamp: requestStartedAt,
    method: req.method,
    url: req.url,
    remoteAddress: req.socket?.remoteAddress,
    remotePort: req.socket?.remotePort,
    headers: req.headers,
    rawBody,
    body,
  };
  void enqueueRequestLog(requestEntry);

  const {
    model = "mock-model",
    stream = false,
    tools = [],
    tool_choice,
    input,
    previous_response_id,
  } = body;

  const created_at = nowUnix();
  const id = `resp_${randomUUID().replaceAll("-", "")}`;

  const inputItems = normalizeInputToItems(input);
  const userText = extractUserText(inputItems);
  const toolOutputs = extractFunctionCallOutputs(inputItems);
  const previous = previous_response_id ? responses.get(previous_response_id) : null;

  const plan = planResponse({ userText, tools, toolOutputs, previous });

  // ===== 非流式：直接一次性返回 =====
  if (!stream) {
    let output = [];
    if (plan.kind === "final_text") {
      output.push(buildMessageItem(plan.text));
    } else {
      const fc = buildFunctionCallItem({ name: plan.name, argumentsJson: plan.argumentsJson });
      fc.arguments = plan.argumentsJson;
      output.push(fc);
    }

    const responseObj = {
      id,
      object: "response",
      created_at,
      model,
      status: "completed",
      // 注意：Responses API 的核心是 output items（SDK 会自己聚合 output_text）
      output,
    };

    responses.set(id, { request: body, response: responseObj });
    return jsonResponse(res, 200, responseObj);
  }

  // ===== 流式：SSE 事件流 =====
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  let seq = 0;

  // response.created 
  sseWrite(res, {
    type: "response.created",
    sequence_number: seq++,
    response: { id, object: "response", created_at, model, status: "in_progress", output: [] },
  });

  if (plan.kind === "final_text") {
    const msg = buildMessageItem("");
    const output_index = 0;

    // output_item.added
    sseWrite(res, {
      type: "response.output_item.added",
      sequence_number: seq++,
      output_index,
      item: msg,
    });

    // 按块吐 delta
    const full = plan.text;
    for (const chunk of full.match(/.{1,8}/g) || []) {
      sseWrite(res, {
        type: "response.output_text.delta",
        sequence_number: seq++,
        output_index,
        // 这里 item_id 对齐 message item id
        item_id: msg.id,
        delta: chunk,
      });
      msg.content[0].text += chunk;
      await sleep(15);
    }

    // output_text.done
    sseWrite(res, {
      type: "response.output_text.done",
      sequence_number: seq++,
      output_index,
      item_id: msg.id,
      text: msg.content[0].text,
    });

    // output_item.done
    sseWrite(res, {
      type: "response.output_item.done",
      sequence_number: seq++,
      output_index,
      item: msg,
    });

    const finalResponse = {
      id,
      object: "response",
      created_at,
      model,
      status: "completed",
      output: [msg],
    };
    responses.set(id, { request: body, response: finalResponse });

    // response.completed 
    sseWrite(res, { type: "response.completed", sequence_number: seq++, response: finalResponse });
    return res.end();
  }

  // plan.kind === "function_call"
  const fc = buildFunctionCallItem({ name: plan.name, argumentsJson: plan.argumentsJson });
  const output_index = 0;

  // output_item.added：先把 function_call item 挂出来
  sseWrite(res, {
    type: "response.output_item.added",
    sequence_number: seq++,
    output_index,
    item: fc,
  });

  // function_call_arguments.delta / done 
  for (const chunk of plan.argumentsJson.match(/.{1,10}/g) || []) {
    sseWrite(res, {
      type: "response.function_call_arguments.delta",
      sequence_number: seq++,
      output_index,
      item_id: fc.id,
      delta: chunk,
    });
    fc.arguments += chunk;
    await sleep(15);
  }

  sseWrite(res, {
    type: "response.function_call_arguments.done",
    sequence_number: seq++,
    output_index,
    item_id: fc.id,
    arguments: fc.arguments,
  });

  sseWrite(res, {
    type: "response.output_item.done",
    sequence_number: seq++,
    output_index,
    item: fc,
  });

  const finalResponse = {
    id,
    object: "response",
    created_at,
    model,
    status: "completed",
    output: [fc],
  };
  responses.set(id, { request: body, response: finalResponse });

  sseWrite(res, { type: "response.completed", sequence_number: seq++, response: finalResponse });
  return res.end();
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      return await handleResponsesApi(req, res);
    }

    if (url.pathname === "/healthz") {
      return jsonResponse(res, 200, { ok: true, ts: Date.now() });
    }

    return jsonResponse(res, 404, { error: { message: "Not found" } });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return jsonResponse(res, 500, { error: { message: e.message ?? "Internal error" } });
  }
});

server.listen(8787, "127.0.0.1", () => {
  console.log("Mock Responses API listening on http://127.0.0.1:8787 (POST /v1/responses)");
  console.log(`Request log file: ${requestLogPath}`);
});
