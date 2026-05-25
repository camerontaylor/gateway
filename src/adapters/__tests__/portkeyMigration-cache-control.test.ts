import { describe, expect, test } from '@jest/globals';
import { AnthropicChatCompleteConfig } from '../../providers/anthropic/chatComplete';
import { AnthropicMessagesConfig } from '../../providers/anthropic/messages';
import { transformUsingProviderConfig } from './testUtils';

describe('portkey migration Anthropic cache_control preservation', () => {
  test('preserves cache_control on system content blocks', () => {
    const result = transformUsingProviderConfig(AnthropicChatCompleteConfig, {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'cache this system prompt',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'hello' },
      ],
    } as any);

    expect(result.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('preserves cache_control on user text content blocks', () => {
    const result = transformUsingProviderConfig(AnthropicChatCompleteConfig, {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cache this user block',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    } as any);

    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  test('preserves cache_control on tool definitions', () => {
    const result = transformUsingProviderConfig(AnthropicChatCompleteConfig, {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [
        {
          type: 'function',
          cache_control: { type: 'ephemeral' },
          function: {
            name: 'lookup',
            description: 'Lookup data',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    } as any);

    expect(result.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('preserves cache_control on assistant tool calls', () => {
    const result = transformUsingProviderConfig(AnthropicChatCompleteConfig, {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'toolu_validation',
              cache_control: { type: 'ephemeral' },
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
      ],
    } as any);

    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  test('preserves cache_control on image content blocks', () => {
    const result = transformUsingProviderConfig(AnthropicChatCompleteConfig, {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,dmFsaWRhdGlvbg==' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    } as any);

    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  test('removes ToolSearch tool_reference blocks from native Messages requests', () => {
    const result = transformUsingProviderConfig(AnthropicMessagesConfig, {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_reference',
              tool_name: 'mcp__plugin_engram_engram__mem_save',
            },
            { type: 'text', text: 'Continue.' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_toolsearch',
              content: [
                {
                  type: 'tool_reference',
                  tool_name: 'mcp__plugin_engram_engram__mem_save',
                },
                { type: 'text', text: 'loaded' },
              ],
            },
          ],
        },
      ],
    } as any);

    expect(JSON.stringify(result.messages)).not.toContain('tool_reference');
    expect(result.messages[0].content).toEqual([
      { type: 'text', text: 'Continue.' },
    ]);
    expect(result.messages[1].content[0].content).toEqual([
      { type: 'text', text: 'loaded' },
    ]);
  });

  test('removes ToolSearch tool_reference blocks from assistant content_blocks', () => {
    const result = transformUsingProviderConfig(AnthropicChatCompleteConfig, {
      model: 'claude-sonnet-4-5',
      messages: [
        {
          role: 'assistant',
          content_blocks: [
            { type: 'text', text: 'Loaded.' },
            {
              type: 'tool_reference',
              tool_name: 'mcp__plugin_engram_engram__mem_save',
            },
          ],
          tool_calls: [
            {
              id: 'toolu_next',
              function: { name: 'lookup', arguments: '{}' },
            },
          ],
        },
      ],
    } as any);

    expect(JSON.stringify(result.messages)).not.toContain('tool_reference');
    expect(result.messages[0].content).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'Loaded.' },
        { type: 'tool_use', name: 'lookup', id: 'toolu_next', input: {} },
      ])
    );
  });
});
