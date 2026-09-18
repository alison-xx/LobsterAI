import { DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG } from '@shared/cowork/autoModelRouting';
import { ModelRuntimeProfile } from '@shared/providers/modelRuntimeProfiles';
import { expect, test } from 'vitest';

import type { Model } from '../../store/slices/modelSlice';
import {
  buildAutoRoutingCandidates,
  resolveAutoMaxImageSupport,
  resolveAutoModelDisplayName,
  resolveCoworkAutoMaxAvailability,
} from './autoModelRoutingSelection';

const textModel: Model = { id: 'deepseek-chat', name: 'DeepSeek Chat', providerKey: 'deepseek', supportsImage: false };
const visionModel: Model = { id: 'gpt-vision', name: 'GPT Vision', providerKey: 'openai', supportsImage: true };
const lockedServerModel: Model = {
  id: 'premium',
  name: 'Premium',
  providerKey: 'lobsterai-server',
  isServerModel: true,
  accessible: false,
};
const verifyingServerModel: Model = {
  id: 'kimi-k3',
  name: 'Kimi K3',
  providerKey: 'lobsterai-server',
  isServerModel: true,
  runtimeProfile: ModelRuntimeProfile.MoonshotKimiK3,
  agenticReady: false,
};

test('buildAutoRoutingCandidates skips inaccessible and not-yet-agentic models', () => {
  expect(buildAutoRoutingCandidates([textModel, visionModel, lockedServerModel, verifyingServerModel])).toEqual([
    { ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', supportsImage: false, contextWindow: undefined },
    { ref: 'openai/gpt-vision', name: 'GPT Vision', supportsImage: true, contextWindow: undefined },
  ]);
});

test('Auto needs two usable models and Max needs a configured usable model', () => {
  const single = buildAutoRoutingCandidates([textModel, lockedServerModel]);
  expect(resolveCoworkAutoMaxAvailability(single, DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG)).toEqual({
    autoAvailable: false,
    maxModelRef: '',
  });

  const both = buildAutoRoutingCandidates([textModel, visionModel]);
  expect(resolveCoworkAutoMaxAvailability(both, {
    ...DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG,
    maxModel: 'openai/gpt-vision',
  })).toEqual({ autoAvailable: true, maxModelRef: 'openai/gpt-vision' });
  expect(resolveCoworkAutoMaxAvailability(both, {
    ...DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG,
    maxModel: 'lobsterai-server/premium',
  }).maxModelRef).toBe('');
});

test('image support follows the Max model, then the Auto vision model', () => {
  const candidates = buildAutoRoutingCandidates([textModel, visionModel]);
  const config = DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG;
  expect(resolveAutoMaxImageSupport({
    autoSelected: false,
    maxModelRef: '',
    candidates,
    config,
    baseModelRef: 'deepseek/deepseek-chat',
  })).toBeNull();
  expect(resolveAutoMaxImageSupport({
    autoSelected: true,
    maxModelRef: '',
    candidates,
    config,
    baseModelRef: 'deepseek/deepseek-chat',
  })).toBe(true);
  expect(resolveAutoMaxImageSupport({
    autoSelected: true,
    maxModelRef: 'deepseek/deepseek-chat',
    candidates,
    config,
    baseModelRef: 'deepseek/deepseek-chat',
  })).toBe(false);
  expect(resolveAutoMaxImageSupport({
    autoSelected: true,
    maxModelRef: '',
    candidates: buildAutoRoutingCandidates([textModel, { ...textModel, id: 'deepseek-coder', name: 'Coder' }]),
    config,
    baseModelRef: 'deepseek/deepseek-chat',
  })).toBe(false);
});

test('resolveAutoModelDisplayName prefers the model name and falls back to the bare id', () => {
  expect(resolveAutoModelDisplayName('openai/gpt-vision', [textModel, visionModel])).toBe('GPT Vision');
  expect(resolveAutoModelDisplayName('custom/unknown-model', [textModel])).toBe('unknown-model');
});
