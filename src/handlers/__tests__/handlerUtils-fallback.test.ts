jest.mock('../../data-stores/redis', () => ({
  redisClient: null,
  redisReaderClient: null,
}));
jest.mock('../../providers', () => ({
  __esModule: true,
  default: {},
}));

import { shouldStopFallback } from '../handlerUtils';

describe('shouldStopFallback', () => {
  it('continues fallback after a gateway exception response when no status rule stops it', () => {
    const response = new Response(JSON.stringify({ message: 'timeout' }), {
      status: 500,
      headers: {
        'content-type': 'application/json',
        'x-portkey-gateway-exception': 'true',
      },
    });

    expect(shouldStopFallback(response, undefined)).toBe(false);
    expect(shouldStopFallback(response, [500])).toBe(false);
  });

  it('stops fallback for ok responses when no onStatusCodes rule is configured', () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    expect(shouldStopFallback(response, undefined)).toBe(true);
  });

  it('uses configured onStatusCodes as the stop/continue rule', () => {
    const retriable = new Response(JSON.stringify({ error: 'retry' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
    const nonRetriable = new Response(JSON.stringify({ error: 'stop' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

    expect(shouldStopFallback(retriable, [429, 500])).toBe(false);
    expect(shouldStopFallback(nonRetriable, [429, 500])).toBe(true);
  });

  it('continues fallback for configured Anthropic overload responses', () => {
    const overloaded = new Response(
      JSON.stringify({ error: { type: 'overloaded_error' } }),
      {
        status: 529,
        headers: { 'content-type': 'application/json' },
      }
    );

    expect(
      shouldStopFallback(overloaded, [408, 429, 500, 502, 503, 504, 529])
    ).toBe(false);
  });
});
