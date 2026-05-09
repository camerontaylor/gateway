import {
  parseAnthropicErrorEvent,
  mapAnthropicErrorToHttpStatus,
  maybeTranslateAnthropicInBandError,
  maybeTranslateAnthropicNonStreamingResponse,
  maybeTranslateAnthropicStreamingResponse,
  parseResetTimestampFromMessage,
  computeRetryAfterSeconds,
} from '../messages/anthropicErrorDetect';

function streamResponse(
  chunks: string[],
  contentType = 'text/event-stream'
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

async function readResponseAsText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (let doneReading = false; !doneReading; ) {
    const { done, value } = await reader.read();
    if (done) {
      doneReading = true;
    } else {
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

describe('parseAnthropicErrorEvent', () => {
  it('parses Anthropic native overloaded_error frame', () => {
    const block =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Service overloaded"}}';
    expect(parseAnthropicErrorEvent(block)).toEqual({
      rawType: 'overloaded_error',
      rawCode: undefined,
      message: 'Service overloaded',
      requestId: undefined,
    });
  });

  it('parses Z.AI compat 1310 frame with code field', () => {
    const block =
      'event: error\n' +
      'data: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-05-11 21:02:26"},"request_id":"abc123"}';
    expect(parseAnthropicErrorEvent(block)).toEqual({
      rawType: undefined,
      rawCode: '1310',
      message:
        'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-05-11 21:02:26',
      requestId: 'abc123',
    });
  });

  it('returns null for non-error events', () => {
    const block =
      'event: message_start\ndata: {"type":"message_start","message":{}}';
    expect(parseAnthropicErrorEvent(block)).toBeNull();
  });

  it('returns null when data is not valid JSON', () => {
    const block = 'event: error\ndata: not-json';
    expect(parseAnthropicErrorEvent(block)).toBeNull();
  });

  it('returns null when JSON has no error field', () => {
    const block = 'event: error\ndata: {"hello":"world"}';
    expect(parseAnthropicErrorEvent(block)).toBeNull();
  });
});

describe('mapAnthropicErrorToHttpStatus', () => {
  it('maps Anthropic overloaded_error to 529', () => {
    expect(mapAnthropicErrorToHttpStatus({ rawType: 'overloaded_error' })).toBe(
      529
    );
  });

  it('maps Anthropic rate_limit_error to 429', () => {
    expect(mapAnthropicErrorToHttpStatus({ rawType: 'rate_limit_error' })).toBe(
      429
    );
  });

  it('maps Z.AI 1310 to 429', () => {
    expect(mapAnthropicErrorToHttpStatus({ rawCode: '1310' })).toBe(429);
  });

  it('maps Z.AI 1305 to 529', () => {
    expect(mapAnthropicErrorToHttpStatus({ rawCode: '1305' })).toBe(529);
  });

  it('maps Z.AI 1008 to 429', () => {
    expect(mapAnthropicErrorToHttpStatus({ rawCode: '1008' })).toBe(429);
  });

  it('defaults unknown errors to 500', () => {
    expect(mapAnthropicErrorToHttpStatus({})).toBe(500);
    expect(
      mapAnthropicErrorToHttpStatus({ rawType: 'unknown_error_type' })
    ).toBe(500);
  });
});

describe('maybeTranslateAnthropicStreamingResponse', () => {
  it('translates first-chunk error event into HTTP 5xx response', async () => {
    const response = streamResponse([
      'event: error\n',
      'data: {"error":{"code":"1310","message":"limit"}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const translated = await maybeTranslateAnthropicStreamingResponse(response);
    expect(translated.status).toBe(429);
    const body = await translated.json();
    expect(body).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'limit',
        code: '1310',
      },
    });
  });

  it('translates Anthropic native overloaded_error to 529', async () => {
    const response = streamResponse([
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
    ]);

    const translated = await maybeTranslateAnthropicStreamingResponse(response);
    expect(translated.status).toBe(529);
    const body = (await translated.json()) as { error: { type: string } };
    expect(body.error.type).toBe('overloaded_error');
  });

  it('passes through a healthy stream unchanged', async () => {
    const response = streamResponse([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

    const passed = await maybeTranslateAnthropicStreamingResponse(response);
    expect(passed.status).toBe(200);
    const body = await readResponseAsText(passed);
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('"text":"hi"');
  });

  it('preserves chunk boundaries when first event spans two reads', async () => {
    const response = streamResponse([
      'event: ',
      'message_start\ndata: ',
      '{"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
    ]);

    const passed = await maybeTranslateAnthropicStreamingResponse(response);
    expect(passed.status).toBe(200);
    const body = await readResponseAsText(passed);
    expect(body).toContain('event: message_start');
    expect(body).toContain('"text":"ok"');
  });
});

describe('maybeTranslateAnthropicNonStreamingResponse', () => {
  it('translates buffered Anthropic error envelope at HTTP 200', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'overloaded' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

    const translated =
      await maybeTranslateAnthropicNonStreamingResponse(response);
    expect(translated.status).toBe(529);
    const body = (await translated.json()) as { error: { type: string } };
    expect(body.error.type).toBe('overloaded_error');
  });

  it('translates SSE-formatted error body at HTTP 200', async () => {
    const sseBody =
      'event: error\ndata: {"error":{"code":"1305","message":"overloaded"}}\n\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const translated =
      await maybeTranslateAnthropicNonStreamingResponse(response);
    expect(translated.status).toBe(529);
  });

  it('passes through ordinary success responses unchanged', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'message',
        id: 'msg_1',
        content: [{ type: 'text', text: 'ok' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

    const passed = await maybeTranslateAnthropicNonStreamingResponse(response);
    expect(passed.status).toBe(200);
    const body = (await passed.json()) as { type: string };
    expect(body.type).toBe('message');
  });

  it('does not rewrite responses that already carry an HTTP error status', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'overloaded' },
      }),
      { status: 529, headers: { 'content-type': 'application/json' } }
    );

    const passed = await maybeTranslateAnthropicNonStreamingResponse(response);
    expect(passed.status).toBe(529);
  });
});

describe('safety bounds', () => {
  it('caps the scanned first-block size and replays a long no-separator stream', async () => {
    // 80 KB of bytes with no \n\n separator at all
    const long = 'x'.repeat(80 * 1024);
    const response = streamResponse([long]);
    const passed = await maybeTranslateAnthropicStreamingResponse(response);
    expect(passed.status).toBe(200);
    const body = await readResponseAsText(passed);
    expect(body.length).toBe(80 * 1024);
  });

  it('caps echoed error.message length to 500 chars', async () => {
    const longMsg = 'a'.repeat(2000);
    const response = streamResponse([
      `event: error\ndata: ${JSON.stringify({
        error: { code: '1310', message: longMsg },
      })}\n\n`,
    ]);
    const translated = await maybeTranslateAnthropicStreamingResponse(response);
    const body = (await translated.json()) as { error: { message: string } };
    expect(body.error.message.length).toBe(500);
  });

  it('drops upstream cookies and auth headers from synthesized error', async () => {
    const sseError =
      'event: error\ndata: {"error":{"code":"1310","message":"limit"}}\n\n';
    const encoder = new TextEncoder();
    const upstream = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(sseError));
          c.close();
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'set-cookie': 'session=secret',
          authorization: 'Bearer leaked',
          'x-portkey-config': 'pc-internal',
          'x-request-id': 'req-123',
        },
      }
    );
    const translated = await maybeTranslateAnthropicStreamingResponse(upstream);
    expect(translated.headers.get('set-cookie')).toBeNull();
    expect(translated.headers.get('authorization')).toBeNull();
    expect(translated.headers.get('x-portkey-config')).toBeNull();
    // Allowlisted correlation header is preserved.
    expect(translated.headers.get('x-request-id')).toBe('req-123');
  });
});

describe('maybeTranslateAnthropicInBandError dispatch', () => {
  it('uses streaming detector for text/event-stream content-type', async () => {
    const response = streamResponse([
      'event: error\ndata: {"error":{"code":"1310","message":"limit"}}\n\n',
    ]);
    const translated = await maybeTranslateAnthropicInBandError(response);
    expect(translated.status).toBe(429);
  });

  it('uses non-streaming detector for application/json content-type', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const translated = await maybeTranslateAnthropicInBandError(response);
    expect(translated.status).toBe(429);
  });
});

describe('parseResetTimestampFromMessage', () => {
  it("parses Z.AI's exact 1310 message format as UTC", () => {
    const message =
      'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-05-11 21:02:26';
    const ms = parseResetTimestampFromMessage(message);
    expect(ms).toBe(Date.UTC(2026, 4, 11, 21, 2, 26));
  });

  it('parses ISO-with-T variant', () => {
    const ms = parseResetTimestampFromMessage('reset at 2026-05-11T21:02:26');
    expect(ms).toBe(Date.UTC(2026, 4, 11, 21, 2, 26));
  });

  it('honors explicit Z timezone', () => {
    const ms = parseResetTimestampFromMessage('reset at 2026-05-11T21:02:26Z');
    expect(ms).toBe(Date.UTC(2026, 4, 11, 21, 2, 26));
  });

  it('honors explicit +08:00 timezone', () => {
    const ms = parseResetTimestampFromMessage(
      'reset at 2026-05-11 21:02:26+08:00'
    );
    // 21:02:26 +08:00 == 13:02:26 UTC
    expect(ms).toBe(Date.UTC(2026, 4, 11, 13, 2, 26));
  });

  it('returns null when message has no reset-at pattern', () => {
    expect(
      parseResetTimestampFromMessage('overloaded, please retry')
    ).toBeNull();
    expect(parseResetTimestampFromMessage(undefined)).toBeNull();
    expect(parseResetTimestampFromMessage('')).toBeNull();
  });

  it('returns null on shape-matching but non-real dates', () => {
    expect(
      parseResetTimestampFromMessage('reset at 2026-13-99 99:99:99')
    ).toBeNull();
  });
});

describe('computeRetryAfterSeconds', () => {
  it('returns rounded-up seconds when reset is in the future', () => {
    const now = 1_700_000_000_000;
    const reset = now + 1500; // 1.5 seconds in the future
    expect(computeRetryAfterSeconds(reset, now)).toBe(2);
  });

  it('returns null when reset is at or in the past', () => {
    const now = 1_700_000_000_000;
    expect(computeRetryAfterSeconds(now, now)).toBeNull();
    expect(computeRetryAfterSeconds(now - 1000, now)).toBeNull();
  });

  it('returns null on non-finite input', () => {
    expect(computeRetryAfterSeconds(NaN)).toBeNull();
    expect(computeRetryAfterSeconds(Infinity)).toBeNull();
  });
});

describe('synthesized response Retry-After header', () => {
  it('attaches retry-after seconds when error message embeds a reset timestamp', async () => {
    // Build a Z.AI-style error frame whose reset is far enough in the future
    // that the test stays valid for the lifetime of this codebase.
    const farFutureUtc = '2099-01-01 00:00:00';
    const sse =
      'event: error\n' +
      `data: ${JSON.stringify({
        error: {
          code: '1310',
          message: `Weekly/Monthly Limit Exhausted. Your limit will reset at ${farFutureUtc}`,
        },
      })}\n\n`;
    const response = streamResponse([sse]);
    const translated = await maybeTranslateAnthropicStreamingResponse(response);
    expect(translated.status).toBe(429);
    const retryAfter = translated.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThan(0);
  });

  it('does not attach retry-after when the error has no reset timestamp', async () => {
    const sse =
      'event: error\n' +
      'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n';
    const response = streamResponse([sse]);
    const translated = await maybeTranslateAnthropicStreamingResponse(response);
    expect(translated.status).toBe(529);
    expect(translated.headers.get('retry-after')).toBeNull();
  });

  it('attaches retry-after on the non-streaming JSON envelope path too', async () => {
    const response = new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Rate limited. Your limit will reset at 2099-01-01 00:00:00',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const translated =
      await maybeTranslateAnthropicNonStreamingResponse(response);
    expect(translated.status).toBe(429);
    const retryAfter = translated.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
