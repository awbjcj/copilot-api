# Gemini clients

The gateway exposes Gemini-compatible generation for the same configured Copilot and external-provider models used by its OpenAI and Anthropic routes. Use `/v1beta/models` to discover model IDs; provider aliases such as `provider/model` are supported. Unknown models return 404 rather than selecting a different model.

## Python SDK

Use the unified `google-genai` SDK (Interactions tested with 2.22.0). Legacy `google-generativeai` and `google-cloud-aiplatform` clients do not support this Interactions endpoint.

```python
import os
from google import genai

client = genai.Client(
    api_key=os.environ["COPILOT_API_KEY"],
    http_options={"base_url": "http://127.0.0.1:4141", "api_version": "v1beta"},
)
response = client.models.generate_content(
    model="gemini-3.8-flash",  # Choose an ID available in your model catalog.
    contents="Explain binary search in one paragraph.",
    config={"thinking_config": {"thinking_level": "LOW", "include_thoughts": False}},
)
print(response.text)

interaction = client.interactions.create(
    model="gemini-3.8-flash",
    input="Explain binary search in one paragraph.",
    store=False,
)
print(interaction.output_text)
```

## Supported operations

| Operation | Behavior |
| --- | --- |
| `GET /v1beta/models` and `/models/{model}` | Shared generative-model catalog and explicit model lookup. |
| `POST /v1beta/models/{model}:generateContent` | Text, inline images, function calls/results, reasoning controls and usage. |
| `POST /v1beta/models/{model}:streamGenerateContent` | SSE text/thought deltas, complete function calls, finish reason and usage. |
| `POST /v1beta/models/{model}:countTokens` | Local estimate for contents or `generateContentRequest`; response includes `x-copilot-api-token-count: estimated`. This is not Google's tokenizer. |
| `POST /v1beta/interactions` | Stateless text/image/function generation and streaming using the current `steps` schema. Explicit `store: false` is required. |

Send the gateway key as `x-goog-api-key` or use the gateway's normal authorization header. Gemini requests use the shared routing, provider configuration and cancellation paths. GPT models that require Responses and Claude models that use Messages are routed accordingly.

Function declarations accept `parameters` or `parametersJsonSchema`. Tool results preserve call IDs, including multiple calls to the same function. Return the complete model content, including opaque thought signatures, with tool results. `allowedFunctionNames` is supported with `ANY`; `VALIDATED` is rejected. SDK snake_case aliases are accepted without renaming fields inside JSON schemas or tool arguments.

Structured output accepts `responseMimeType` plus `responseSchema`/`responseJsonSchema`, or `responseFormat.text`. It is forwarded to the selected provider's native format controls. Copilot models must advertise `structured_outputs`: the tested Gemini Copilot transport ignores these controls, so the gateway rejects them explicitly. GPT and Claude structured output were verified. External-provider support depends on that provider.

`includeThoughts: false` hides reasoning summaries while retaining opaque signatures needed for follow-up calls. Thinking levels and budgets are constrained by the model and transport; unsupported controls return an error instead of being silently discarded.

Gemini 3 and later use `thinkingLevel` (SDK alias: `thinking_level`). The gateway forwards the selected level as upstream Chat Completions `reasoning_effort` or Responses `reasoning.effort`, without a numeric thinking budget. A numeric `thinkingBudget` sent to these models (including external-provider aliases), to models without budget support, or over the Responses transport is converted to a thinking level: `0` → `minimal`, `1`–`1024` → `low`, `1025`–`8192` → `medium`, larger → `high`, and `-1` (dynamic) keeps the model default. If the model does not support that level, the nearest supported level is used, preferring more thinking. Legacy Gemini 2.5 budgets remain available when the model advertises budget support and uses Chat Completions. Omit both controls to use the model's default; do not combine a level and a budget. `maxOutputTokens` separately limits total output and does not set the thinking budget.

## Stateless Interactions

Pass the full history in `input`, using `user_input`, `model_output`, `thought`, `function_call` and `function_result` steps. Include tools, system instructions and generation configuration on every request. Copy returned steps into subsequent history; pair each function result's `call_id` with the returned function call's `id`. Tool requests return `requires_action`.

Streaming emits `interaction.created`, `step.start`, `step.delta`, `step.stop`, and `interaction.completed` events. An upstream failure emits an error rather than a successful completion. Generation may end with an incomplete status when the output token limit is reached.

The gateway does not persist interactions. `store: true`, an omitted `store`, `previous_interaction_id`, background execution, hosted agents, retrieval and deletion are rejected. Hosted search/code execution, remote file references, PDF/audio/video inputs, generated media, safety-setting overrides (an empty `safetySettings` array, as sent by langchain-google-genai, is accepted) and multiple candidates are also unsupported. Availability comes from the gateway's configured model catalog rather than Google's hosted model lifecycle.
