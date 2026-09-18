import { expect, test } from 'vitest';

import {
  AutoModelCategory,
  AutoModelResolveReason,
  type AutoRoutingCandidate,
  DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG,
} from '../../../shared/cowork/autoModelRouting';
import {
  AUTO_LONG_CONTEXT_TOKEN_THRESHOLD,
  type AutoModelRoutingSource,
  classifyTaskCategory,
  resolveAutoTurnModel,
} from './autoModelRouter';

const candidates: AutoRoutingCandidate[] = [
  { ref: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', supportsImage: false, contextWindow: 128_000 },
  { ref: 'openai/gpt-vision', name: 'GPT Vision', supportsImage: true, contextWindow: 200_000 },
  { ref: 'google/gemini-long', name: 'Gemini Long', supportsImage: false, contextWindow: 1_000_000 },
];

const source = (overrides: Partial<typeof DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG> = {}): AutoModelRoutingSource => ({
  candidates,
  config: { ...DEFAULT_COWORK_AUTO_MODEL_ROUTING_CONFIG, ...overrides },
});

// -- classifyTaskCategory ---------------------------------------------------

test('classifies image attachments as Vision', () => {
  expect(classifyTaskCategory({ prompt: 'describe this', imageAttachmentCount: 1 })).toBe(AutoModelCategory.Vision);
});

test('Vision wins even when the prompt also contains code', () => {
  expect(classifyTaskCategory({
    prompt: '```ts\nconst x = 1;\n```',
    imageAttachmentCount: 2,
  })).toBe(AutoModelCategory.Vision);
});

test('classifies very long input as LongContext', () => {
  const longPrompt = 'a'.repeat(AUTO_LONG_CONTEXT_TOKEN_THRESHOLD * 3.5 + 100);
  expect(classifyTaskCategory({ prompt: longPrompt })).toBe(AutoModelCategory.LongContext);
});

test('LongContext estimate folds in extra context text', () => {
  expect(classifyTaskCategory({
    prompt: 'b'.repeat(10_000),
    contextText: 'c'.repeat(12_000),
  })).toBe(AutoModelCategory.LongContext);
});

test('LongContext wins over code when both apply', () => {
  const longCode = '```py\n' + 'x = 1\n'.repeat(4000) + '```';
  expect(classifyTaskCategory({ prompt: longCode })).toBe(AutoModelCategory.LongContext);
});

test('classifies fenced code, file references and code keywords as Code', () => {
  expect(classifyTaskCategory({ prompt: 'fix this\n```js\nfunction f() {}\n```' })).toBe(AutoModelCategory.Code);
  expect(classifyTaskCategory({ prompt: 'please update main.ts for me' })).toBe(AutoModelCategory.Code);
  expect(classifyTaskCategory({ prompt: 'write a function that sorts a list' })).toBe(AutoModelCategory.Code);
});

test('detects code that only appears in the context text', () => {
  expect(classifyTaskCategory({ prompt: 'what does this do', contextText: 'SELECT * FROM users' }))
    .toBe(AutoModelCategory.Code);
});

test('classifies short plain prompts and empty input as General', () => {
  expect(classifyTaskCategory({ prompt: 'hello, how are you today?' })).toBe(AutoModelCategory.General);
  expect(classifyTaskCategory({})).toBe(AutoModelCategory.General);
});

// -- resolveAutoTurnModel ---------------------------------------------------

test('returns null for a session that uses neither Auto nor Max', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'hello' },
    source: source({ maxModel: 'google/gemini-long' }),
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: false,
    maxMode: false,
  })).toBeNull();
});

test('Auto keeps general turns on the agent model', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'hello there' },
    source: source(),
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: false,
  })).toEqual({
    modelRef: 'deepseek/deepseek-chat',
    reason: AutoModelResolveReason.Auto,
    category: AutoModelCategory.General,
  });
});

test('Auto routes image turns to a vision-capable model', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'what is this?', imageAttachmentCount: 1 },
    source: source(),
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: false,
  })).toMatchObject({ modelRef: 'openai/gpt-vision', category: AutoModelCategory.Vision });
});

test('Auto routes long turns to the larger context window', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'x'.repeat(30_000) },
    source: source(),
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: false,
  })).toMatchObject({ modelRef: 'google/gemini-long', category: AutoModelCategory.LongContext });
});

test('Auto honours a configured code model', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'refactor utils.py' },
    source: source({ codeModel: 'openai/gpt-vision' }),
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: false,
  })).toMatchObject({ modelRef: 'openai/gpt-vision', category: AutoModelCategory.Code });
});

test('Auto falls back to the agent model when no routing source is available', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'what is this?', imageAttachmentCount: 1 },
    source: null,
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: false,
  })).toMatchObject({ modelRef: 'deepseek/deepseek-chat', category: AutoModelCategory.Vision });
});

test('Auto returns null when nothing concrete can be resolved', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'hello' },
    source: null,
    baseModelRef: '',
    autoSelected: true,
    maxMode: false,
  })).toBeNull();
});

test('Max overlays Auto and explicit selections when a Max model is configured', () => {
  const maxSource = source({ maxModel: 'google/gemini-long' });
  expect(resolveAutoTurnModel({
    input: { prompt: 'what is this?', imageAttachmentCount: 1 },
    source: maxSource,
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: true,
  })).toEqual({ modelRef: 'google/gemini-long', reason: AutoModelResolveReason.Max });
  expect(resolveAutoTurnModel({
    input: { prompt: 'hello' },
    source: maxSource,
    baseModelRef: 'openai/gpt-vision',
    autoSelected: false,
    maxMode: true,
  })).toEqual({ modelRef: 'google/gemini-long', reason: AutoModelResolveReason.Max });
});

test('Max without a usable Max model leaves the session on its own selection', () => {
  expect(resolveAutoTurnModel({
    input: { prompt: 'hello' },
    source: source({ maxModel: 'removed/model' }),
    baseModelRef: 'openai/gpt-vision',
    autoSelected: false,
    maxMode: true,
  })).toBeNull();
  expect(resolveAutoTurnModel({
    input: { prompt: 'hello' },
    source: source(),
    baseModelRef: 'deepseek/deepseek-chat',
    autoSelected: true,
    maxMode: true,
  })).toMatchObject({ modelRef: 'deepseek/deepseek-chat', reason: AutoModelResolveReason.Auto });
});
