import type {
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"

/** Echo supplied request metadata even when the upstream drops it. */
export function withResponsesMetadata(
  response: ResponsesResult,
  metadata: ResponsesPayload["metadata"],
): ResponsesResult {
  return metadata === undefined ? response : { ...response, metadata }
}

/** Apply request metadata to response lifecycle events. */
export function withResponsesStreamMetadata(
  event: ResponseStreamEvent,
  metadata: ResponsesPayload["metadata"],
): ResponseStreamEvent {
  if (metadata === undefined || !("response" in event)) return event
  return {
    ...event,
    response: withResponsesMetadata(event.response, metadata),
  }
}
