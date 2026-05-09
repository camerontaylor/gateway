import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('../../utils/fetch', () => ({
  externalServiceFetch: jest.fn(() => {
    throw new Error('externalServiceFetch should not run in local mode');
  }),
  internalServiceFetch: jest.fn(() => {
    throw new Error('internalServiceFetch should not run in local mode');
  }),
}));

jest.mock('../cache/cacheService', () => ({
  requestCache: () => ({
    get: jest.fn(() => {
      throw new Error('requestCache.get should not run in local mode');
    }),
    set: jest.fn(),
  }),
}));

const baselineEnv = { ...process.env };
const baselineCwd = process.cwd();
let tempConfigDir: string | null = null;

describe('albus local mode auth', () => {
  beforeEach(() => {
    process.env = {
      ...baselineEnv,
      FETCH_SETTINGS_FROM_FILE: 'true',
      PORTKEY_LOCAL_API_KEY: 'local-test-key',
    };
    jest.resetModules();
  });

  afterEach(() => {
    process.env = baselineEnv;
  });

  test('rejects mismatched local api keys without calling albus', async () => {
    const { fetchApiKeyDetails } = await import('../albus');

    await expect(fetchApiKeyDetails({}, 'wrong-key')).resolves.toBeNull();
  });

  test('returns local api key details for the configured local token', async () => {
    const { fetchApiKeyDetails } = await import('../albus');

    const details = await fetchApiKeyDetails({}, 'local-test-key');

    expect(details).not.toBeNull();
    expect(details?.organisation_details?.organisation_id).toBe(
      '00000000-0000-0000-0000-000000000000'
    );
    expect(details?.api_key_details?.key).toBe('local-test-key');
    expect(details?.api_key_details?.scopes).toContain('completions.write');
  });
});

describe('albus local mode config slugs', () => {
  beforeEach(async () => {
    tempConfigDir = await mkdtemp(join(tmpdir(), 'portkey-local-config-'));
    process.chdir(tempConfigDir);
    process.env = {
      ...baselineEnv,
      FETCH_SETTINGS_FROM_FILE: 'true',
      PORTKEY_LOCAL_API_KEY: 'local-test-key',
      OPENROUTER_API_KEY: 'openrouter-test-key',
      FIREWORKS_API_KEY: 'fireworks-test-key',
    };
    jest.resetModules();
  });

  afterEach(async () => {
    process.chdir(baselineCwd);
    process.env = baselineEnv;
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = null;
    }
  });

  test('resolves single-route local config slugs and hydrates api_key_env', async () => {
    const settingsFileJson = {
      routes: {
        'fleet-haiku': {
          portkey_config: {
            provider: 'openrouter',
            api_key_env: 'OPENROUTER_API_KEY',
            override_params: {
              model: 'openai/gpt-oss-120b',
              provider: {
                only: ['Cerebras'],
                allow_fallbacks: false,
              },
            },
          },
        },
      },
      local_config: {
        aliases: {
          'portkey-probe-fleet-haiku': ['fleet-haiku'],
        },
      },
    };
    await writeFile('conf.json', JSON.stringify(settingsFileJson));

    const { getLocalConfigSlug, getLocalConfigVersion } = await import(
      '../albus/configFile'
    );
    expect(getLocalConfigVersion(settingsFileJson, ['fleet-haiku'])).toBe(
      'local-sha256:98320800e018dece'
    );
    const configSlug = getLocalConfigSlug(
      'portkey-probe-fleet-haiku',
      settingsFileJson,
      ['fleet-haiku']
    );
    expect(configSlug).toBe('pc-local-portkey-probe-fleet-haiku-295e215bf7bc');
    const { fetchOrganisationConfig } = await import('../albus');

    const configDetails = await fetchOrganisationConfig(
      {},
      'local-test-key',
      'local-org',
      { id: 'local-workspace' } as any,
      configSlug
    );

    expect(configDetails).not.toBeNull();
    expect(configDetails?.configVersion).toMatch(/^local-sha256:[a-f0-9]{16}$/);
    expect(configDetails?.organisationConfig).toMatchObject({
      provider: 'openrouter',
      api_key: 'openrouter-test-key',
      override_params: {
        model: 'openai/gpt-oss-120b',
        provider: {
          only: ['Cerebras'],
          allow_fallbacks: false,
        },
      },
    });
    expect(configDetails?.organisationConfig.api_key_env).toBeUndefined();
  });

  test('resolves multi-route aliases as a conditional router by params.model', async () => {
    const settingsFileJson = {
      routes: {
        'fleet-opus': {
          portkey_config: {
            provider: 'anthropic',
            api_key_env: 'FIREWORKS_API_KEY',
            override_params: {
              model: 'accounts/fireworks/models/kimi-k2p6',
            },
          },
        },
        'fleet-haiku': {
          portkey_config: {
            provider: 'openrouter',
            api_key_env: 'OPENROUTER_API_KEY',
            override_params: {
              model: 'openai/gpt-oss-120b',
            },
          },
        },
      },
      local_config: {
        aliases: {
          ccfw: ['fleet-opus', 'fleet-haiku'],
        },
      },
    };
    await writeFile('conf.json', JSON.stringify(settingsFileJson));

    const { getLocalConfigSlug, getLocalConfigVersion } = await import(
      '../albus/configFile'
    );
    expect(
      getLocalConfigVersion(settingsFileJson, ['fleet-opus', 'fleet-haiku'])
    ).toBe('local-sha256:447758dd249eace8');
    const configSlug = getLocalConfigSlug('ccfw', settingsFileJson, [
      'fleet-opus',
      'fleet-haiku',
    ]);
    expect(configSlug).toBe('pc-local-ccfw-f40af7c03075');
    const { fetchOrganisationConfig } = await import('../albus');

    const configDetails = await fetchOrganisationConfig(
      {},
      'local-test-key',
      'local-org',
      { id: 'local-workspace' } as any,
      configSlug
    );

    expect(configDetails?.organisationConfig.strategy).toEqual({
      mode: 'conditional',
      conditions: [
        {
          query: { 'params.model': { $eq: 'fleet-opus' } },
          then: 'fleet-opus',
        },
        {
          query: { 'params.model': { $eq: 'fleet-haiku' } },
          then: 'fleet-haiku',
        },
      ],
      default: 'fleet-opus',
    });
    expect(configDetails?.organisationConfig.targets).toEqual([
      expect.objectContaining({
        name: 'fleet-opus',
        api_key: 'fireworks-test-key',
      }),
      expect.objectContaining({
        name: 'fleet-haiku',
        api_key: 'openrouter-test-key',
      }),
    ]);
  });
});
