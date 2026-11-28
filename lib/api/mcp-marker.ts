/**
 * Requests the MCP server builds itself and passes to the `/api/v1` handlers
 * (#41). A request is only in this set if our own code put it there, so a
 * caller cannot label its audit rows `mcp` with a header.
 */
const internal = new WeakSet<Request>();

export function markMcpRequest(request: Request): Request {
  internal.add(request);
  return request;
}

export function isMcpRequest(request: Request): boolean {
  return internal.has(request);
}
