import {
  describe,
  expect,
  jest,
  test,
  beforeEach,
  afterEach,
} from '@jest/globals';
import type { Context } from 'hono';

const mockGetCircuitBreakerStatus = jest.fn<(...args: unknown[]) => unknown>();
const mockRecordCircuitBreakerFailure =
  jest.fn<(...args: unknown[]) => unknown>();
const mockRecordCircuitBreakerSuccess =
  jest.fn<(...args: unknown[]) => unknown>();
const mockSet = jest.fn<(...args: unknown[]) => unknown>();

jest.mock('../../services/cache/cacheService', () => ({
  requestCache: jest.fn(() => ({
    getCircuitBreakerStatus: mockGetCircuitBreakerStatus,
    recordCircuitBreakerFailure: mockRecordCircuitBreakerFailure,
    recordCircuitBreakerSuccess: mockRecordCircuitBreakerSuccess,
    set: mockSet,
  })),
}));

jest.mock('../../apm', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('hono/adapter', () => ({
  env: jest.fn(() => ({})),
}));

import {
  checkCircuitBreakerStatus,
  extractCircuitBreakerConfigs,
  getCircuitBreakerMappedConfig,
  handleCircuitBreakerResponse,
} from '../circuitBreaker';

const cbConfig = {
  failure_threshold: 1,
  cooldown_interval: 60000,
  failure_status_codes: [408, 429, 500, 502, 503, 504, 529],
};

const localProviderConfig = () => ({
  strategy: {
    mode: 'fallback',
    cb_config: cbConfig,
  },
  targets: [
    {
      strategy: { mode: 'loadbalance' },
      targets: [
        {
          provider: 'anthropic',
          custom_host: 'https://api.z.ai/api/anthropic/v1',
          override_params: { model: 'glm-5.1' },
        },
        {
          provider: 'anthropic',
          custom_host: 'https://api.fireworks.ai/inference/v1',
          override_params: { model: 'accounts/fireworks/models/glm-5p1' },
        },
      ],
    },
    {
      provider: 'anthropic',
      custom_host: 'https://api.minimax.io/anthropic/v1',
      override_params: { model: 'MiniMax-M2.7' },
    },
  ],
});

describe('circuitBreaker local provider targets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('extracts circuit breaker entries for provider-only leaf targets', () => {
    const context = extractCircuitBreakerConfigs(
      localProviderConfig(),
      'config-id'
    );

    expect(Object.keys(context.pathStatusMap)).toEqual([
      'config.targets[0].targets[0]',
      'config.targets[0].targets[1]',
      'config.targets[1]',
    ]);
    expect(
      context.pathStatusMap['config.targets[0].targets[0]'].cb_config
    ).toEqual(cbConfig);
  });

  test('keeps virtual-key extraction additive', () => {
    const context = extractCircuitBreakerConfigs(
      {
        strategy: {
          mode: 'fallback',
          cb_config: cbConfig,
        },
        targets: [{ virtual_key: 'vk-slug' }],
      },
      'config-id'
    );

    expect(Object.keys(context.pathStatusMap)).toEqual(['config.targets[0]']);
  });

  test('maps open provider leaves to both snake_case and camelCase fields consumed by fallback dispatch', async () => {
    const now = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    mockGetCircuitBreakerStatus.mockResolvedValue({
      'config.targets[0].targets[0]': {
        failure_count: 1,
        success_count: 0,
        first_failure_time: now - 1000,
      },
    });

    const baseConfig = localProviderConfig();
    const extracted = extractCircuitBreakerConfigs(baseConfig, 'config-id');
    const checked = await checkCircuitBreakerStatus({}, extracted);
    const mapped = getCircuitBreakerMappedConfig(baseConfig, checked!);

    expect(mapped.targets[0].targets[0]).toMatchObject({
      is_open: true,
      isOpen: true,
      cb_config: cbConfig,
      cbConfig: cbConfig,
    });
    expect(mapped.targets[0].targets[1]).toMatchObject({
      is_open: false,
      isOpen: false,
      cb_config: cbConfig,
      cbConfig: cbConfig,
    });
  });

  test('uses numeric Retry-After as the effective cooldown window when recording failures', async () => {
    const now = 2_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await handleCircuitBreakerResponse(
      new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '5' },
      }),
      'config-id',
      cbConfig,
      'config.targets[0]',
      {} as unknown as Context
    );

    expect(mockRecordCircuitBreakerFailure).toHaveBeenCalledWith(
      'config-id',
      'config.targets[0]',
      now - cbConfig.cooldown_interval + 5000
    );
  });
});
