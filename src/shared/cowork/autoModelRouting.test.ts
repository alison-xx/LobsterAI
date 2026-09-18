import { expect, test } from 'vitest';

import {
  AutoModelCategory,
  type AutoRoutingCandidate,
  COWORK_AUTO_MODEL_REF,
  DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG,
  deriveAutoRoutingPolicy,
  findAutoRoutingCandidate,
  isAutoModelRef,
  isAutoRoutingAvailable,
  isSameAutoModelRoutingConfig,
  normalizeAutoModelRoutingConfig,
  resolveMaxModelRef,
  selectAutoRoutingModelRef,
} from './autoModelRouting';

const textModel: AutoRoutingCandidate = {
  ref: 'deepseek/deepseek-chat',
  name: 'DeepSeek Chat',
  supportsImage: false,
  contextWindow: 128_000,
};
const visionModel: AutoRoutingCandidate = {
  ref: 'openai/gpt-vision',
  name: 'GPT Vision',
  supportsImage: true,
  contextWindow: 200_000,
};
const sameProviderVisionModel: AutoRoutingCandidate = {
  ref: 'deepseek/deepseek-vl',
  name: 'DeepSeek VL',
  supportsImage: true,
  contextWindow: 64_000,
};
const longModel: AutoRoutingCandidate = {
  ref: 'google/gemini-long',
  name: 'Gemini Long',
  supportsImage: false,
  contextWindow: 1_000_000,
};
const unknownWindowModel: AutoRoutingCandidate = {
  ref: 'custom/local-model',
  name: 'Local',
};

const config = (overrides: Partial<typeof DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG>) => ({
  ...DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG,
  ...overrides,
});

test('isAutoModelRef matches the sentinel case-insensitively and ignores concrete refs', () => {
  expect(isAutoModelRef(COWORK_AUTO_MODEL_REF)).toBe(true);
  expect(isAutoModelRef('  LobsterAI/__AUTO__ ')).toBe(true);
  expect(isAutoModelRef('lobsterai-server/__auto__')).toBe(false);
  expect(isAutoModelRef('openai/gpt-5')).toBe(false);
  expect(isAutoModelRef('')).toBe(false);
  expect(isAutoModelRef(null)).toBe(false);
});

test('normalizeAutoModelRoutingConfig keeps only trimmed string fields', () => {
  expect(normalizeAutoModelRoutingConfig({
    generalModel: ' openai/gpt-5 ',
    codeModel: 42,
    maxModel: 'anthropic/opus',
    extra: 'ignored',
  })).toEqual({
    generalModel: 'openai/gpt-5',
    codeModel: '',
    visionModel: '',
    longContextModel: '',
    maxModel: 'anthropic/opus',
  });
  expect(normalizeAutoModelRoutingConfig('bad')).toEqual(DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG);
  expect(isSameAutoModelRoutingConfig(config({ maxModel: 'a/b' }), config({ maxModel: ' a/b ' }))).toBe(true);
  expect(isSameAutoModelRoutingConfig(config({ maxModel: 'a/b' }), undefined)).toBe(false);
});

test('Auto is available only with at least two usable models', () => {
  expect(isAutoRoutingAvailable([])).toBe(false);
  expect(isAutoRoutingAvailable([textModel])).toBe(false);
  expect(isAutoRoutingAvailable([textModel, visionModel])).toBe(true);
});

test('findAutoRoutingCandidate matches exact refs, provider case, and unique bare ids', () => {
  const candidates = [textModel, visionModel];
  expect(findAutoRoutingCandidate(candidates, 'openai/gpt-vision')).toBe(visionModel);
  expect(findAutoRoutingCandidate(candidates, 'OpenAI/gpt-vision')).toBe(visionModel);
  expect(findAutoRoutingCandidate(candidates, 'legacy-provider/deepseek-chat')).toBe(textModel);
  expect(findAutoRoutingCandidate(candidates, 'missing/model')).toBeNull();
  expect(findAutoRoutingCandidate(candidates, COWORK_AUTO_MODEL_REF)).toBeNull();
  expect(findAutoRoutingCandidate(candidates, '')).toBeNull();
});

test('without overrides general, code and long context stay on the base model', () => {
  const policy = deriveAutoRoutingPolicy({
    candidates: [textModel, unknownWindowModel],
    baseModelRef: textModel.ref,
  });
  expect(policy).toEqual({
    general: textModel.ref,
    code: textModel.ref,
    vision: textModel.ref,
    longContext: textModel.ref,
    max: '',
  });
});

test('vision prefers the base model when it reads images', () => {
  const policy = deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel],
    baseModelRef: visionModel.ref,
  });
  expect(policy.vision).toBe(visionModel.ref);
});

test('vision falls back to an image-capable model, preferring the base provider', () => {
  expect(deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel],
    baseModelRef: textModel.ref,
  }).vision).toBe(visionModel.ref);
  expect(deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel, sameProviderVisionModel],
    baseModelRef: textModel.ref,
  }).vision).toBe(sameProviderVisionModel.ref);
});

test('long context picks the largest window only when it beats the base model', () => {
  expect(deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel, longModel],
    baseModelRef: textModel.ref,
  }).longContext).toBe(longModel.ref);
  expect(deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel, longModel],
    baseModelRef: longModel.ref,
  }).longContext).toBe(longModel.ref);
  // Unknown base window: nothing sensible to compare against, stay on base.
  expect(deriveAutoRoutingPolicy({
    candidates: [unknownWindowModel, longModel],
    baseModelRef: unknownWindowModel.ref,
  }).longContext).toBe(unknownWindowModel.ref);
});

test('usable overrides win and stale overrides are ignored', () => {
  const policy = deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel, longModel],
    config: config({
      generalModel: visionModel.ref,
      codeModel: longModel.ref,
      visionModel: 'removed/vision-model',
      longContextModel: textModel.ref,
      maxModel: longModel.ref,
    }),
    baseModelRef: textModel.ref,
  });
  expect(policy).toEqual({
    general: visionModel.ref,
    code: longModel.ref,
    // Stale vision override ignored; the general override already reads images.
    vision: visionModel.ref,
    longContext: textModel.ref,
    max: longModel.ref,
  });
});

test('Max is never derived and requires a usable configured model', () => {
  const candidates = [textModel, visionModel, longModel];
  expect(resolveMaxModelRef(candidates, DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG)).toBe('');
  expect(resolveMaxModelRef(candidates, config({ maxModel: 'gone/model' }))).toBe('');
  expect(resolveMaxModelRef(candidates, config({ maxModel: longModel.ref }))).toBe(longModel.ref);
});

test('the Auto sentinel is never used as a base model', () => {
  const policy = deriveAutoRoutingPolicy({
    candidates: [textModel, visionModel],
    baseModelRef: COWORK_AUTO_MODEL_REF,
  });
  expect(policy.general).toBe('');
  expect(selectAutoRoutingModelRef(policy, AutoModelCategory.Vision)).toBe(visionModel.ref);
  expect(selectAutoRoutingModelRef(policy, AutoModelCategory.Code)).toBe('');
});
