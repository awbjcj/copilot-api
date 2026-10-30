import type { ConsolaInstance } from "consola"

import { debugJsonAsync } from "~/lib/logger"
import { ImageJsonValueReader } from "~/lib/image-json-value"
import { state } from "~/lib/state"
import {
  createJsonByteSource,
  jsonByteStream,
  StreamingJsonReader,
} from "~/lib/streaming-json"

function redactImageBase64(value: unknown, key = ""): unknown {
  if (["b64_json", "base64", "image_base64"].includes(key))
    return "[image base64 omitted]"
  if (typeof value === "string") {
    return /^data:image\/[^,]+;base64,/iu.test(value) ?
        "[image base64 omitted]"
      : value
  }
  if (Array.isArray(value))
    return value.map((item: unknown) => redactImageBase64(item))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]: [string, unknown]) => [
        field,
        redactImageBase64(item, field),
      ]),
    )
  }
  return value
}

async function editRequestBody(request: Request): Promise<unknown> {
  try {
    const cloned = request.clone()
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const fields: Array<{ name: string; value: unknown }> = []
      for (const [name, value] of await cloned.formData()) {
        fields.push({
          name,
          value:
            typeof value === "string" ?
              redactImageBase64(value, name)
            : {
                filename: value.name,
                mime_type: value.type,
                size: value.size,
              },
        })
      }
      return fields
    }
    return redactImageBase64(await cloned.json())
  } catch {
    return "[unavailable JSON body]"
  }
}

export async function logImageEditRequest(
  logger: ConsolaInstance,
  label: string,
  request: Request,
  extra: Record<string, unknown> = {},
  debug: typeof debugJsonAsync = debugJsonAsync,
): Promise<Request> {
  if (!state.verbose) return request
  if (!request.headers.get("content-type")?.includes("multipart/form-data"))
    return logImageJsonRequest(logger, label, request, extra, debug)
  await debug(logger, label, async () => ({
    contentType: request.headers.get("content-type"),
    contentLength: request.headers.get("content-length"),
    ...extra,
    body: await editRequestBody(request),
  }))
  return request
}

/** Observes the same chunks sent upstream; debug logging never tees JSON bodies. */
function logImageJsonRequest(
  logger: ConsolaInstance,
  label: string,
  request: Request,
  extra: Record<string, unknown>,
  debug: typeof debugJsonAsync,
): Request {
  const value = new ImageJsonValueReader()
  const parser = new StreamingJsonReader()
  const input = createJsonByteSource(
    request.body as ReadableStream<Uint8Array> | null,
    request.signal,
  )
  let valid = true
  async function* observe(): AsyncGenerator<Uint8Array, void, unknown> {
    for await (const chunk of input.bytes) {
      if (valid) {
        try {
          await value.read(parser.read(chunk))
        } catch {
          valid = false
        }
      }
      yield chunk
    }
    if (valid) {
      try {
        await value.read(parser.read())
      } catch {
        valid = false
      }
    }
    await debug(logger, label, () =>
      Promise.resolve({
        contentType: request.headers.get("content-type"),
        contentLength: request.headers.get("content-length"),
        ...extra,
        body:
          valid ? redactImageBase64(value.value) : "[unavailable JSON body]",
      }),
    )
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    body: jsonByteStream(observe(), (reason) => input.cancel(reason)),
    duplex: "half",
  } as RequestInit)
}
