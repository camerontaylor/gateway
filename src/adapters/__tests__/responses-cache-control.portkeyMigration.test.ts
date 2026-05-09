import { describe, expect, test } from '@jest/globals';
import { transformResponsesToChatCompletions } from '../responses/requestTransform';

describe('portkey migration Responses cache_control preservation', () => {
  test('preserves cache_control on function tools', () => {
    const result = transformResponsesToChatCompletions({
      model: 'claude-sonnet-4-5',
      input: 'use the tool',
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Lookup data',
          parameters: { type: 'object', properties: {} },
          cache_control: { type: 'ephemeral' },
        },
      ],
    });

    expect(result.tools?.[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('preserves cache_control on input text content parts', () => {
    const result = transformResponsesToChatCompletions({
      model: 'claude-sonnet-4-5',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'cache this input',
              cache_control: { type: 'ephemeral' },
            },
            { type: 'input_text', text: 'uncached input' },
          ],
        },
      ],
    });

    expect((result.messages?.[0].content as any[])[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  test('preserves cache_control on output text content parts', () => {
    const result = transformResponsesToChatCompletions({
      model: 'claude-sonnet-4-5',
      input: [
        {
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'cache this output',
              cache_control: { type: 'ephemeral' },
            },
            { type: 'output_text', text: 'uncached output' },
          ],
        },
      ],
    });

    expect((result.messages?.[0].content as any[])[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  test('preserves cache_control on input file content parts', () => {
    const result = transformResponsesToChatCompletions({
      model: 'claude-sonnet-4-5',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename: 'brief.pdf',
              file_data: 'data:application/pdf;base64,dmFsaWRhdGlvbg==',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    });

    expect((result.messages?.[0].content as any[])[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });
});
