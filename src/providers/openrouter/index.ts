import { createModelResponseParams } from '../open-ai-base';
import { ProviderConfigs } from '../types';
import OpenrouterAPIConfig from './api';
import {
  OpenrouterChatCompleteConfig,
  OpenrouterChatCompleteResponseTransform,
  OpenrouterChatCompleteStreamChunkTransform,
} from './chatComplete';
import {
  OpenrouterImageGenerateConfig,
  OpenrouterImageGenerateResponseTransform,
} from './imageGenerate';
import { OpenrouterLogConfig } from './pricing';

const OpenrouterConfig: ProviderConfigs = {
  chatComplete: OpenrouterChatCompleteConfig,
  imageGenerate: OpenrouterImageGenerateConfig,
  createModelResponse: createModelResponseParams([]),
  api: OpenrouterAPIConfig,
  responseTransforms: {
    chatComplete: OpenrouterChatCompleteResponseTransform,
    'stream-chatComplete': OpenrouterChatCompleteStreamChunkTransform,
    imageGenerate: OpenrouterImageGenerateResponseTransform,
  },
  pricing: OpenrouterLogConfig,
};

export default OpenrouterConfig;
