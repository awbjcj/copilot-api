/** Removes gateway credentials before a URL is logged or forwarded upstream. */
export function withoutGatewayQueryKey(requestUrl: string): URL {
  const url = new URL(requestUrl, "http://localhost")
  if (url.searchParams.has("key")) url.searchParams.delete("key")
  return url
}
