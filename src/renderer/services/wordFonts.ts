import type { FontConfiguration, FontFaceRequest } from '@docx-editor.dev/core/contracts/editor';
import { createFontSource } from '@docx-editor.dev/core/editor';
import wasmUrl from '@docx-editor.dev/core/harfbuzz.wasm?url';
import { initializeHarfBuzz, setHarfBuzzWasmUrl } from '@docx-editor.dev/core/layout';

const fontUrls = import.meta.glob('../assets/word-fonts/*.{ttf,otf}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const FONT_MAX_BYTES = 16 * 1024 * 1024;
let configuration: Promise<FontConfiguration> | undefined;

async function loadConfiguration(): Promise<FontConfiguration> {
  setHarfBuzzWasmUrl(wasmUrl);
  await initializeHarfBuzz();
  const sources = await Promise.all(Object.entries(fontUrls).map(async ([filePath, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Bundled Word font unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const name = filePath.split('/').pop() ?? '';
    const family = name.startsWith('NotoSansSC-') ? 'Noto Sans SC' : name.split('-')[0];
    const font = createFontSource(bytes, {
      family, weight: name.includes('Bold') ? 700 : 400, style: name.includes('Italic') ? 'italic' : 'normal',
    }, { maxFontBytes: FONT_MAX_BYTES });
    if ('failure' in font) throw new Error(`Bundled Word font failed admission: ${font.failure.reason}`);
    return font.source;
  }));
  const substitutions: NonNullable<FontConfiguration['substitutions']>[number][] = [];
  const families = [
    { from: ['Calibri', 'Aptos', 'Arial', 'Helvetica', '等线', 'DengXian'], to: 'Carlito' },
    { from: ['Cambria', 'Times New Roman', 'Times'], to: 'Caladea' },
    { from: ['宋体', 'SimSun', '新宋体', 'NSimSun', '黑体', 'SimHei', '微软雅黑', 'Microsoft YaHei', '仿宋', 'FangSong', '楷体', 'KaiTi', 'PingFang SC', 'Noto Sans CJK SC'], to: 'Noto Sans SC' },
  ];
  for (const { from, to } of families) {
    for (const family of from) for (const weight of [400, 700]) for (const style of ['normal', 'italic'] as const) {
      const target: FontFaceRequest = { family: to, weight, style: to === 'Noto Sans SC' ? 'normal' : style };
      substitutions.push({ from: { family, weight, style }, to: target });
    }
  }
  return {
    epoch: 1, sources, substitutions, maxFontBytes: FONT_MAX_BYTES,
    defaultFont: { family: 'Noto Sans SC', sizeHalfPoints: 22 }, language: 'zh-CN',
  };
}

/** All assets resolve locally, before the editor accepts its first keystroke. */
export function loadWordFonts(): Promise<FontConfiguration> {
  configuration ??= loadConfiguration().catch(error => { configuration = undefined; throw error; });
  return configuration;
}
