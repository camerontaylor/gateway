import {
  getSettings,
  defaultOrganisationDetails,
} from '../../../initializeSettings';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { getValueOrFileContents } from '../../utils/env';

const localConfigSlugPrefix = 'pc-local-';
const localConfigSlugPattern = /^pc-local-(.+)-([a-f0-9]{12})$/;
const sensitiveKeyPattern = /(secret|token|password|authorization)$/i;
const explicitSecretKeys = new Set(['api_key', 'apiKey', 'credentials', 'key']);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const sha256 = (input: string) =>
  createHash('sha256').update(input).digest('hex');

const safeAliasName = (aliasName: string) =>
  aliasName.replace(/[^A-Za-z0-9-]/g, '-');

const stripSecrets = (value: any): any => {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !explicitSecretKeys.has(key) && !sensitiveKeyPattern.test(key)
        )
        .map(([key, nestedValue]) => [key, stripSecrets(nestedValue)])
    );
  }

  return value;
};

const sortObjectKeys = (value: any): any => {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObjectKeys(value[key])])
    );
  }

  return value;
};

const stableStringify = (value: any) =>
  JSON.stringify(sortObjectKeys(stripSecrets(value)));

const readLocalConfigFile = async () => {
  const settingsFile = await readFile('./conf.json', 'utf-8');
  return JSON.parse(settingsFile);
};

export const getLocalConfigVersion = (
  settingsFileJson: Record<string, any>,
  routeNames: string[]
) => {
  const routes = Object.fromEntries(
    routeNames.map((routeName) => {
      const routeConfig = settingsFileJson.routes?.[routeName]?.portkey_config;
      if (!routeConfig) {
        throw new Error(`unknown route: ${routeName}`);
      }
      return [routeName, routeConfig];
    })
  );

  const hash = sha256(`${stableStringify({ routes })}\n`).slice(0, 16);
  return `local-sha256:${hash}`;
};

export const getLocalConfigSlug = (
  aliasName: string,
  settingsFileJson: Record<string, any>,
  routeNames: string[]
) => {
  const version = getLocalConfigVersion(settingsFileJson, routeNames);
  const slugHash = sha256(`${aliasName}:${version}\n`).slice(0, 12);
  return `${localConfigSlugPrefix}${safeAliasName(aliasName)}-${slugHash}`;
};

const getLocalAliasRouteMap = (settingsFileJson: Record<string, any>) => {
  const aliases: Record<string, string[]> = {};
  const configuredAliases = settingsFileJson.local_config?.aliases || {};

  for (const [aliasName, routeNames] of Object.entries(configuredAliases)) {
    if (
      typeof aliasName === 'string' &&
      Array.isArray(routeNames) &&
      routeNames.every((routeName) => typeof routeName === 'string')
    ) {
      aliases[aliasName] = routeNames as string[];
    }
  }

  for (const routeName of Object.keys(settingsFileJson.routes || {})) {
    aliases[routeName] ||= [routeName];
    aliases[`portkey-probe-${routeName}`] = [routeName];
    aliases[`portkey-probe-stream-${routeName}`] = [routeName];
  }

  return aliases;
};

const resolveApiKeyEnv = (value: any): any => {
  if (Array.isArray(value)) {
    return value.map(resolveApiKeyEnv);
  }

  if (value && typeof value === 'object') {
    const resolved = Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        resolveApiKeyEnv(nestedValue),
      ])
    );

    if (typeof resolved.api_key_env === 'string' && !resolved.api_key) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(resolved.api_key_env)) {
        throw new Error(`invalid api_key_env name: ${resolved.api_key_env}`);
      }

      const apiKey = getValueOrFileContents(process.env[resolved.api_key_env]);
      if (!apiKey) {
        throw new Error(`unset api_key_env: ${resolved.api_key_env}`);
      }

      resolved.api_key = apiKey;
    }

    delete resolved.api_key_env;
    return resolved;
  }

  return value;
};

const buildLocalOrganisationConfig = (
  settingsFileJson: Record<string, any>,
  routeNames: string[]
) => {
  const routeConfigs = routeNames.map((routeName) => {
    const routeConfig = settingsFileJson.routes?.[routeName]?.portkey_config;
    if (!routeConfig) {
      throw new Error(`unknown route: ${routeName}`);
    }

    return {
      routeName,
      config: resolveApiKeyEnv(cloneJson(routeConfig)),
    };
  });

  if (routeConfigs.length === 1) {
    return routeConfigs[0].config;
  }

  return {
    strategy: {
      mode: 'conditional',
      conditions: routeConfigs.map(({ routeName }) => ({
        query: { 'params.model': { $eq: routeName } },
        then: routeName,
      })),
      default: routeConfigs[0].routeName,
    },
    targets: routeConfigs.map(({ routeName, config }) => ({
      name: routeName,
      ...config,
    })),
  };
};

export const fetchOrganisationConfigFromSlugFromFile = async (
  configSlug: string
) => {
  const settingsFileJson = await readLocalConfigFile();
  const slugMatch = configSlug.match(localConfigSlugPattern);
  if (!slugMatch) {
    return null;
  }

  const aliasRouteMap = getLocalAliasRouteMap(settingsFileJson);

  for (const [aliasName, routeNames] of Object.entries(aliasRouteMap)) {
    let aliasSlug: string;
    let configVersion: string;
    try {
      configVersion = getLocalConfigVersion(settingsFileJson, routeNames);
      aliasSlug = getLocalConfigSlug(aliasName, settingsFileJson, routeNames);
    } catch {
      continue;
    }

    if (aliasSlug !== configSlug) {
      continue;
    }

    return {
      organisationConfig: buildLocalOrganisationConfig(
        settingsFileJson,
        routeNames
      ),
      configVersion,
    };
  }

  return null;
};

export const fetchOrganisationProviderFromSlugFromFile = async (
  url: string
) => {
  const settings = await getSettings();
  const virtualKeySlug = url.split('/').pop()?.split('?')[0];
  return settings.integrations.find(
    (integration: any) => integration.slug === virtualKeySlug
  );
};

// not supported
// export const fetchOrganisationConfig = async () => {
//   return fetchFromJson('organisationConfig');
// };

// not supported
// export const fetchOrganisationPrompt = async () => {
//   return fetchFromJson('organisationPrompt');
// };

// not supported
// export const fetchOrganisationPromptPartial = async () => {
//   return fetchFromJson('organisationPromptPartial');
// };

// not supported
// export const fetchOrganisationGuardrail = async () => {
//   return fetchFromJson('organisationGuardrail');
// };

export const fetchOrganisationDetailsFromFile = async () => {
  const settings = await getSettings();
  return settings?.organisationDetails ?? defaultOrganisationDetails;
};

export const fetchOrganisationIntegrationsFromFile = async () => {
  const settings = await getSettings();
  return settings?.integrations || [];
};
