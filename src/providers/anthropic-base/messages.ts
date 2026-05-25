import { Params } from '../../types/requestBody';
import { ParameterConfig, ProviderConfig } from '../types';

const unsupportedForwardedContentBlockTypes = new Set(['tool_reference']);

/**
 * Claude Code can persist Anthropic-only transport blocks (for example
 * ToolSearch `tool_reference` blocks) into the conversation history. Several
 * Anthropic-compatible providers reject those blocks before generation, so the
 * gateway removes only the known transport-only block type while preserving all
 * normal text/media/tool blocks.
 */
export const sanitizeAnthropicContentBlocks = (content: unknown): unknown => {
  if (!Array.isArray(content)) {
    return content;
  }

  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') {
      return [block];
    }

    const typedBlock = block as Record<string, unknown>;
    if (
      typeof typedBlock.type === 'string' &&
      unsupportedForwardedContentBlockTypes.has(typedBlock.type)
    ) {
      return [];
    }

    if (Array.isArray(typedBlock.content)) {
      return [
        {
          ...typedBlock,
          content: sanitizeAnthropicContentBlocks(typedBlock.content),
        },
      ];
    }

    return [block];
  });
};

export const sanitizeAnthropicMessages = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) {
    return messages;
  }

  return messages.map((message) => {
    if (!message || typeof message !== 'object') {
      return message;
    }

    const typedMessage = message as Record<string, unknown>;
    if (!Array.isArray(typedMessage.content)) {
      return message;
    }

    return {
      ...typedMessage,
      content: sanitizeAnthropicContentBlocks(typedMessage.content),
    };
  });
};

export const messagesBaseConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  messages: {
    param: 'messages',
    required: true,
    transform: (params: Params) => sanitizeAnthropicMessages(params.messages),
  },
  max_tokens: {
    param: 'max_tokens',
    required: true,
  },
  container: {
    param: 'container',
    required: false,
  },
  mcp_servers: {
    param: 'mcp_servers',
    required: false,
  },
  metadata: {
    param: 'metadata',
    required: false,
  },
  service_tier: {
    param: 'service_tier',
    required: false,
  },
  stop_sequences: {
    param: 'stop_sequences',
    required: false,
  },
  stream: {
    param: 'stream',
    required: false,
  },
  system: {
    param: 'system',
  },
  temperature: {
    param: 'temperature',
    required: false,
  },
  thinking: {
    param: 'thinking',
    required: false,
  },
  tool_choice: {
    param: 'tool_choice',
    required: false,
  },
  tools: {
    param: 'tools',
    required: false,
  },
  top_k: {
    param: 'top_k',
    required: false,
  },
  top_p: {
    param: 'top_p',
    required: false,
  },
  output_config: {
    param: 'output_config',
    required: false,
  },
};

export const getMessagesConfig = ({
  exclude = [],
  defaultValues = {},
  extra = {},
}: {
  exclude?: string[];
  defaultValues?: Record<
    keyof typeof messagesBaseConfig,
    string | number | boolean
  >;
  extra?: ProviderConfig;
}): ProviderConfig => {
  const baseParams = { ...messagesBaseConfig };
  if (defaultValues) {
    Object.keys(defaultValues).forEach((key) => {
      if (!Array.isArray(baseParams[key])) {
        (baseParams[key] as ParameterConfig).default = defaultValues[key];
      }
    });
  }
  exclude.forEach((key) => {
    // not checking if the key exists as if it doesnt, a build failure is expected
    delete baseParams[key];
  });

  return { ...baseParams, ...extra };
};
