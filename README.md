# CCR Plugin · OpenAI Responses Transformer

[中文说明](./README_CN.md)

This repository packages a custom transformer for Claude Code Router that translates Claude Code requests to the OpenAI Responses API and adapts streaming responses back into Chat Completions format.

If this plugin saves you time, please consider giving the repo a ⭐️!

## Features

- Preserves system instructions, metadata, and token limits from Claude Code requests.
- Normalizes tool definitions into the `{ type: "function", name, parameters }` schema required by the Responses API.
- Reconstructs streaming `tool_calls` by interpreting `response.output_item.added` and `response.function_call_arguments.delta` events.

## Installation

1. Copy `.claude-code-router/plugins/responses-api.js` into your local Claude Code Router plugins directory, typically `~/.claude-code-router/plugins`.
2. Register the transformer inside `~/.claude-code-router/config.json`:

   ```json
   {
     "transformers": [
       { "path": "~/.claude-code-router/plugins/responses-api.js" }
     ]
   }
   ```

3. Restart Claude Code Router and test any workflow that requires tool execution.

## License

Released under the [MIT License](./LICENSE).
