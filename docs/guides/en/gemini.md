# Gemini models through the shared APIs

The native Google `/v1beta` generation, streaming, model discovery, token-counting,
and Interactions endpoints have been retired. Use the same Responses or Messages
protocol supported by upstream copilot-api. A Gemini model ID does not imply a
Google-native HTTP endpoint. Discover available model IDs with `GET /v1/models`.

For LangChain clients:

```python
from langchain_openai import ChatOpenAI

model = ChatOpenAI(
    model="gemini-3.5-flash",  # Must be available to the configured account.
    base_url="http://127.0.0.1:4141/v1",
    api_key="NONE",  # Or your configured gateway key.
    use_responses_api=True,
    store=False,
    include=["reasoning.encrypted_content"],
    reasoning={"effort": "medium"},
)
```

Use bearer authentication or `x-api-key`; Google `x-goog-api-key` and query-key
authentication are retired. Keep the complete returned AIMessage through each
tool turn and checkpoint, including all ordered encrypted reasoning items.
Do not flatten summaries or extract only the first signature.

The shared Responses-to-Messages adapter supports inline base64 PNG/JPEG/GIF/WebP
images and PDF files. Send Responses `input_image` with a data URL, or `input_file`
with a PDF data URL and filename. Native Google upload handles, file URIs, audio,
video, and Google Interactions are not supported by this adapter. Direct Google
clients should continue using Google's service. Structured-output enforcement
and accepted effort values depend on the selected upstream model; the Messages
adapter maps `minimal` to `low`. A transport accepting a schema does not prove
that the model enforces it.

Responses `output_tokens` already includes reasoning. Do not add
`output_tokens_details.reasoning_tokens` again. Input totals include cache reads;
subtract those only when pricing ordinary input separately. The Messages adapter
combines ordinary/cache input into this normalized total. A zero reasoning detail
means that the adapter has no separate reasoning breakdown, not that no thinking
occurred. Removed `countTokens` estimates are not billing measurements; use
returned usage and label local pre-request estimates explicitly.
