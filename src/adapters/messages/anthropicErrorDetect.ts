/**
 * Anthropic Messages SSE in-band error detection.
 *
 * The Anthropic Messages streaming protocol delivers mid-flight failures as
 * `event: error` SSE frames inside an HTTP 200 response, e.g.
 *
 *   event: error
 *   data: {"type":"error","error":{"type":"overloaded_error","message":"..."}}
 *
 * Anthropic-compatible custom hosts (Z.AI, MiniMax `/anthropic/v1`, Fireworks
 * via the Anthropic adapter) inherit this convention, occasionally with their
 * own error shape, e.g.
 *
 *   event: error
 *   data: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}
 *
 * The gateway's fallback engine only inspects HTTP status codes, so without
 * translation these in-band errors leak straight through to the client and
 * never trigger the configured fallback chain. This module detects the error
 * frame, maps it to the equivalent HTTP status, and synthesizes a Response
 * the engine can route on.
 */

export interface AnthropicErrorEvent {
  /** Anthropic native error.type (e.g. "overloaded_error") if present. */
  rawType?: string;
  /** Z.AI / MiniMax style numeric/string error.code if present. */
  rawCode?: string | number;
  /** Free-form upstream message, surfaced for client visibility. */
  message?: string;
  /** Upstream request id, when included alongside the error. */
  requestId?: string;
}

/**
 * Maximum bytes scanned for the first SSE block before we give up looking
 * for an error frame and replay the stream as-is. A real Anthropic
 * `message_start` block is well under 4KB; 64KB leaves comfortable headroom
 * for verbose models without exposing the gateway worker to a malicious
 * upstream that streams indefinitely without ever emitting a separator.
 */
const MAX_FIRST_BLOCK_BYTES = 64 * 1024;

/**
 * Maximum length of `error.message` text echoed to the client. Caps any
 * upstream-embedded internal identifiers, stack traces, or credential
 * fragments to a bounded surface.
 */
const MAX_MESSAGE_LEN = 500;

/**
 * Headers worth carrying through from the upstream response onto the
 * synthesized error response. Anything not in this list (cookies, auth
 * headers, gateway control headers, etc.) is dropped to prevent upstream
 * header injection from reaching the client or the next hop.
 */
/**
 * Matches "reset at <timestamp>" / "reset on <timestamp>" / "resets at ..."
 * embedded in upstream error messages. Z.AI's `1310` weekly-limit error puts
 * the reset moment in the message text, e.g. "Your limit will reset at
 * 2026-05-11 21:02:26". We capture the date and time parts and an optional
 * timezone suffix; bare timestamps default to UTC.
 */
const RESET_TIMESTAMP_PATTERN =
  /\breset(?:s|ting)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?/i;

const SAFE_UPSTREAM_HEADERS: ReadonlyArray<string> = [
  'x-request-id',
  'cf-ray',
  'x-amzn-requestid',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
];

// billing_error and Z.AI quota codes are mapped to 429 (not 402) so they
// fall in the same bucket as rate limits in the typical on_status_codes
// configuration `[408, 429, 500, 502, 503, 504, 529]`. The intent is for
// fallback to engage on quota exhaustion just as it does on rate limits.
const ANTHROPIC_TYPE_TO_STATUS: Record<string, number> = {
  overloaded_error: 529,
  rate_limit_error: 429,
  api_error: 500,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  invalid_request_error: 400,
  billing_error: 429,
};

const ZAI_CODE_TO_STATUS: Record<string, number> = {
  '1305': 529,
  '1310': 429,
  '1008': 429,
};

/**
 * Map a detected error frame to the HTTP status the fallback engine will see.
 * Defaults to 500 so unknown errors still trip a generic 5xx fallback rule.
 */
export function mapAnthropicErrorToHttpStatus(
  error: AnthropicErrorEvent
): number {
  if (error.rawType && ANTHROPIC_TYPE_TO_STATUS[error.rawType]) {
    return ANTHROPIC_TYPE_TO_STATUS[error.rawType];
  }
  if (error.rawCode != null) {
    const status = ZAI_CODE_TO_STATUS[String(error.rawCode)];
    if (status) return status;
  }
  return 500;
}

/**
 * Extract an upstream-stated reset time from an error message body.
 * Z.AI's `1310` and similar quota errors embed the reset moment in free
 * text (e.g. "Your limit will reset at 2026-05-11 21:02:26"). Returns the
 * epoch-ms of the reset, or null if no parseable signal is present.
 *
 * Times without an explicit timezone are interpreted as UTC.
 */
export function parseResetTimestampFromMessage(
  message: string | undefined
): number | null {
  if (!message) return null;
  const match = RESET_TIMESTAMP_PATTERN.exec(message);
  if (!match) return null;

  const date = match[1];
  const time = match[2];
  const tz = match[3] ?? 'Z';
  const isoString = `${date}T${time}${tz}`;
  const ms = Date.parse(isoString);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Convert a future epoch-ms into a `Retry-After` numeric-seconds value
 * suitable for handlers that parse via parseInt (e.g. retryHandler.ts:138).
 * Returns null if the reset is in the past or the input is not finite.
 */
export function computeRetryAfterSeconds(
  resetEpochMs: number,
  now: number = Date.now()
): number | null {
  if (!Number.isFinite(resetEpochMs)) return null;
  const deltaMs = resetEpochMs - now;
  if (deltaMs <= 0) return null;
  return Math.ceil(deltaMs / 1000);
}

/**
 * Parse a single SSE block (one `event:`/`data:` group, no trailing `\n\n`)
 * and return the structured error if it represents an Anthropic-protocol
 * `event: error` frame. Returns null otherwise.
 */
export function parseAnthropicErrorEvent(
  block: string
): AnthropicErrorEvent | null {
  if (!block.includes('event: error')) return null;

  let dataPayload: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataPayload = line.slice('data:'.length).trim();
      break;
    }
  }
  if (!dataPayload) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(dataPayload);
  } catch {
    return null;
  }

  const errObj = parsed?.error;
  if (!errObj || typeof errObj !== 'object') return null;

  return {
    rawType: typeof errObj.type === 'string' ? errObj.type : undefined,
    rawCode:
      typeof errObj.code === 'string' || typeof errObj.code === 'number'
        ? errObj.code
        : undefined,
    message: typeof errObj.message === 'string' ? errObj.message : undefined,
    requestId:
      typeof parsed?.request_id === 'string' ? parsed.request_id : undefined,
  };
}

/**
 * Build the JSON body the gateway returns to the fallback engine when an
 * upstream error is detected. The shape mirrors Anthropic's standard
 * non-streaming error envelope so existing consumers keep working when the
 * fallback chain is exhausted.
 */
function buildErrorBody(error: AnthropicErrorEvent): string {
  const message =
    typeof error.message === 'string'
      ? error.message.slice(0, MAX_MESSAGE_LEN)
      : 'Upstream returned an error event';
  return JSON.stringify({
    type: 'error',
    error: {
      type: error.rawType || 'api_error',
      message,
      ...(error.rawCode != null ? { code: error.rawCode } : {}),
      ...(error.requestId ? { request_id: error.requestId } : {}),
    },
  });
}

/**
 * Synthesize the Response handed back to the fallback engine.
 * Headers from the original response are preserved so trace/correlation
 * fields keep flowing.
 */
function synthesizeErrorResponse(
  error: AnthropicErrorEvent,
  originalHeaders: Headers
): Response {
  const status = mapAnthropicErrorToHttpStatus(error);
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const name of SAFE_UPSTREAM_HEADERS) {
    const value = originalHeaders.get(name);
    if (value) headers.set(name, value);
  }
  // Surface upstream-stated reset time as a numeric-seconds Retry-After
  // header. retryHandler.ts:138 parses Retry-After with parseInt(value)*1000,
  // so HTTP-date format would be ignored; numeric seconds is required.
  const resetMs = parseResetTimestampFromMessage(error.message);
  if (resetMs != null) {
    const seconds = computeRetryAfterSeconds(resetMs);
    if (seconds != null && seconds > 0) {
      headers.set('retry-after', String(seconds));
    }
  }
  return new Response(buildErrorBody(error), { status, headers });
}

/**
 * Detect an `event: error` frame inside a non-streaming response body.
 * Anthropic-compatible hosts sometimes return SSE-formatted bodies even for
 * non-streaming requests; we also handle the JSON error envelope they may
 * return as a buffered body.
 */
function detectInBufferedBody(body: string): AnthropicErrorEvent | null {
  // SSE-formatted body: scan blocks for an event: error frame.
  if (body.includes('event: error')) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const error = parseAnthropicErrorEvent(block);
      if (error) return error;
    }
  }

  // Native Anthropic error JSON envelope.
  try {
    const parsed = JSON.parse(body);
    if (
      parsed?.type === 'error' &&
      parsed?.error &&
      typeof parsed.error === 'object'
    ) {
      return {
        rawType:
          typeof parsed.error.type === 'string' ? parsed.error.type : undefined,
        rawCode:
          typeof parsed.error.code === 'string' ||
          typeof parsed.error.code === 'number'
            ? parsed.error.code
            : undefined,
        message:
          typeof parsed.error.message === 'string'
            ? parsed.error.message
            : undefined,
        requestId:
          typeof parsed?.request_id === 'string'
            ? parsed.request_id
            : undefined,
      };
    }
  } catch {
    /* not JSON; ignore */
  }

  return null;
}

/**
 * For a buffered (non-streaming) Anthropic response: read the body once,
 * detect an in-band error frame or error envelope, and return a translated
 * Response. Status is only rewritten when the upstream returned a success
 * code with an error body — real upstream error statuses are left alone.
 */
export async function maybeTranslateAnthropicNonStreamingResponse(
  response: Response
): Promise<Response> {
  // If upstream already signaled an error at the HTTP layer, leave it
  // untouched: the existing on_status_codes rules already handle it.
  if (!response.ok) return response;

  const contentType = response.headers.get('content-type') || '';
  if (
    !contentType.includes('text/event-stream') &&
    !contentType.includes('application/json')
  ) {
    return response;
  }

  const text = await response.text();
  const error = detectInBufferedBody(text);
  if (!error) {
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    });
  }

  return synthesizeErrorResponse(error, response.headers);
}

/**
 * For a streaming Anthropic response: buffer up to the first complete SSE
 * block. If it's an `event: error` frame, abandon the upstream stream and
 * return a synthesized HTTP 5xx so the fallback engine engages. Otherwise,
 * replay the buffered bytes and stream the rest unchanged.
 *
 * First-chunk-only detection is the contract: once the gateway has begun
 * forwarding successful frames to the client, an in-band error mid-stream
 * is propagated as-is — at that point the HTTP 200 has already been sent
 * and we cannot retroactively redirect the request.
 */
export async function maybeTranslateAnthropicStreamingResponse(
  response: Response
): Promise<Response> {
  if (!response.body) return response;

  // Read the first SSE block via getReader (which locks the upstream body),
  // then either synthesize a fresh error response or pipe the upstream
  // through a TransformStream so the returned Response's body is a regular
  // spec-compliant ReadableStream that Hono / logging middleware can clone
  // and tee freely (returning a custom ReadableStream that internally locks
  // the upstream breaks Response.clone()).
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let scanned = '';
  let scannedBytes = 0;
  let separatorIndex = -1;

  for (let doneReading = false; !doneReading; ) {
    const { done, value } = await reader.read();
    if (done) {
      doneReading = true;
      continue;
    }

    buffered.push(value);
    scannedBytes += value.byteLength;
    scanned += decoder.decode(value, { stream: true });
    separatorIndex = scanned.search(/\r?\n\r?\n/);
    if (separatorIndex >= 0 || scannedBytes >= MAX_FIRST_BLOCK_BYTES) {
      doneReading = true;
    }
  }
  // Flush any held UTF-8 partial bytes so a separator that lands exactly on
  // a multi-byte boundary is still detectable in `scanned`.
  scanned += decoder.decode();
  if (separatorIndex < 0) {
    separatorIndex = scanned.search(/\r?\n\r?\n/);
  }

  const firstBlock =
    separatorIndex >= 0 ? scanned.slice(0, separatorIndex) : scanned;
  const error = parseAnthropicErrorEvent(firstBlock);

  if (error) {
    // Drain the rest of the upstream in the background so the connection
    // can close naturally. Calling reader.cancel() can propagate up through
    // gateway-internal TransformStreams and trigger ERR_INVALID_STATE on
    // their writer.close(); the Anthropic protocol always sends [DONE]
    // shortly after an error frame so the drain finishes promptly.
    void (async () => {
      try {
        for (let doneReading = false; !doneReading; ) {
          const { done } = await reader.read();
          doneReading = done;
        }
      } catch {
        /* ignore drain errors */
      }
    })();
    return synthesizeErrorResponse(error, response.headers);
  }

  // Healthy: pipe buffered bytes + remaining upstream bytes through a
  // TransformStream and return its readable side. This pattern is the same
  // one adaptStreamingResponse uses and produces a body Hono can clone/tee
  // without surfacing the internal reader lock.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  void (async () => {
    try {
      for (const chunk of buffered) {
        await writer.write(chunk);
      }
      for (let doneReading = false; !doneReading; ) {
        const { done, value } = await reader.read();
        if (done) {
          doneReading = true;
        } else {
          await writer.write(value);
        }
      }
    } catch {
      /* ignore upstream errors; finally still closes the writer */
    } finally {
      try {
        await writer.close();
      } catch {
        /* writer may already be closed by stream cancellation */
      }
    }
  })();

  return new Response(readable, {
    status: response.status,
    headers: response.headers,
  });
}

/**
 * Entry point used by `adaptResponse`. Decides streaming vs non-streaming
 * based on the response content-type and dispatches to the right handler.
 */
export async function maybeTranslateAnthropicInBandError(
  response: Response
): Promise<Response> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return maybeTranslateAnthropicStreamingResponse(response);
  }
  return maybeTranslateAnthropicNonStreamingResponse(response);
}
