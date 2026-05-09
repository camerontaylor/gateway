import { describe, expect, jest, test } from '@jest/globals';

const cache = new Map<string, unknown>();

jest.mock('../cache/cacheService', () => ({
  requestCache: () => ({
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
    }),
  }),
}));

jest.mock('../../apm', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

import { stickySessionManager } from '../stickySessionManager';

const baseHeaders = {
  'x-portkey-api-key': 'validation-key',
};

function context(
  configVersion: string,
  session: string,
  model = 'claude-sonnet'
) {
  return {
    env: {},
    configVersion,
    requestHeaders: baseHeaders,
    metadata: { portkey_session: session },
    params: { model },
  };
}

const hashFields = ['metadata.portkey_session', 'params.model'];

describe('portkey migration sticky session gate', () => {
  test('returns cached target for same session model and config version', async () => {
    const ctx = context(`test-config-${Date.now()}-same`, 'ccz:test-pane');
    const initial = await stickySessionManager.getTargetIndex(ctx, hashFields);
    await stickySessionManager.setTargetIndexByHash(
      ctx.configVersion,
      initial.identifierHash,
      1,
      60,
      {}
    );

    const cached = await stickySessionManager.getTargetIndex(ctx, hashFields);

    expect(cached.targetIndex).toBe(1);
  });

  test('does not reuse cached target when only session changes', async () => {
    const configVersion = `test-config-${Date.now()}-session`;
    const first = context(configVersion, 'ccz:first');
    const second = context(configVersion, 'ccz:second');
    const firstInitial = await stickySessionManager.getTargetIndex(
      first,
      hashFields
    );
    await stickySessionManager.setTargetIndexByHash(
      configVersion,
      firstInitial.identifierHash,
      0,
      60,
      {}
    );

    const secondCached = await stickySessionManager.getTargetIndex(
      second,
      hashFields
    );

    expect(secondCached.targetIndex).toBeNull();
  });

  test('does not reuse cached target when only config version changes', async () => {
    const session = 'ccz:test-pane';
    const original = context(`test-config-${Date.now()}-original`, session);
    const changed = context(`test-config-${Date.now()}-changed`, session);
    const originalInitial = await stickySessionManager.getTargetIndex(
      original,
      hashFields
    );
    await stickySessionManager.setTargetIndexByHash(
      original.configVersion,
      originalInitial.identifierHash,
      1,
      60,
      {}
    );

    const changedCached = await stickySessionManager.getTargetIndex(
      changed,
      hashFields
    );

    expect(changedCached.targetIndex).toBeNull();
  });
});
