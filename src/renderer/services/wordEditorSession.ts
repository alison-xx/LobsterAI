import '@docx-editor.dev/core/styles/editor.css';

import type { EditorSnapshot } from '@docx-editor.dev/core/contracts/editor';
import { createDocxEditor, type DocxEditorInstance } from '@docx-editor.dev/core/editor';
import { createT, deepMerge, en, type LocaleStrings, type TranslationKey, zhCN } from '@docx-editor.dev/i18n';

import { WordFileError, type WordOpenResult, type WordResult } from '../../shared/artifactPreview/wordEditing';
import { i18nService } from './i18n';
import { installMarkdownDocumentLifecycle } from './markdownDocumentLifecycle';
import { normalizeShellFilePath } from './shellAppsCache';
import { WordDocument, type WordEditorPort } from './wordDocument';
import { loadWordFonts } from './wordFonts';

const EDITOR_MODE = { Edit: 'edit', View: 'view' } as const;
const ZOOM_MODE = { Fit: 'fit', Fixed: 'fixed' } as const;
const SHAPED_MEASURER = 'shaped';
interface WordEditorRegistry {
  sessions: Map<string, WordEditorSession>;
  paths: Map<string, Promise<WordResult<WordEditorSession>>>;
  parking?: HTMLDivElement;
  disposeLifecycle?: () => void;
  disposeChanges?: () => void;
  reportedUnsafe: boolean;
}
const registry: WordEditorRegistry = import.meta.hot?.data.wordEditorRegistry ?? {
  sessions: new Map(), paths: new Map(), reportedUnsafe: false,
};
const { sessions, paths } = registry;
const MAX_CACHED_SESSIONS = 4;

function getParking(): HTMLDivElement {
  if (!registry.parking) {
    const parking = document.createElement('div');
    parking.style.cssText = 'position:fixed;left:-100000px;top:0;width:1000px;height:800px;visibility:hidden;pointer-events:none;';
    parking.setAttribute('aria-hidden', 'true');
    parking.inert = true;
    document.body.appendChild(parking);
    registry.parking = parking;
  }
  return registry.parking;
}

const hasUnsafeEdits = (): boolean => [...sessions.values()].some(session => session.document.unsafe);
const reportState = (): void => {
  const unsafe = hasUnsafeEdits();
  if (unsafe !== registry.reportedUnsafe) {
    try {
      window.electron.artifact.word.setHasUnsafeEdits(unsafe);
      registry.reportedUnsafe = unsafe;
    } catch (error) {
      console.warn('[WordEditor] Could not report unsaved edits:', error);
    }
  }
};

function evictCleanSessions(): void {
  if (sessions.size <= MAX_CACHED_SESSIONS) return;
  for (const [id, session] of sessions) {
    if (sessions.size <= MAX_CACHED_SESSIONS) break;
    if (session.mounted || session.document.dirty || session.document.busy) continue;
    session.dispose();
    sessions.delete(id);
    for (const alias of session.aliases) paths.delete(alias);
  }
}

/** The host element itself moves between the visible view and an offscreen parking area.
 * Core attach/detach remounts from bytes and loses undo, so it is NOT used on React unmount.
 */
export class WordEditorSession implements WordEditorPort {
  readonly host = document.createElement('div');
  readonly document: WordDocument;
  readonly aliases = new Set<string>();
  editor?: DocxEditorInstance;
  mounted = false;
  private readOnly = false;
  private stopLocale?: () => void;
  private stopChange?: () => void;
  private stopSnapshot?: () => void;
  private stopError?: () => void;
  private initialization?: Promise<void>;
  private listeners = new Set<() => void>();

  constructor(file: WordOpenResult) {
    this.host.className = 'docx-editor lobster-word-surface';
    getParking().appendChild(this.host);
    this.document = new WordDocument(file, window.electron.artifact.word, this, reportState);
  }

  initialize(): Promise<void> {
    this.initialization ??= this.document.initialize();
    return this.initialization;
  }

  getEditorSnapshot = (): EditorSnapshot | undefined => this.editor?.snapshot();
  subscribeEditor = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private notify = (): void => { this.listeners.forEach(listener => listener()); };

  async load(bytes: Uint8Array): Promise<void> {
    const fonts = await loadWordFonts();
    if (!this.editor) {
      this.editor = createDocxEditor({ container: this.host, fonts, mode: EDITOR_MODE.View, zoomMode: 'auto' });
      const syncLocale = () => {
        const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en';
        this.editor?.setLocale(locale);
        const translate = createT(locale === 'zh-CN' ? deepMerge(en, zhCN) as LocaleStrings : en, locale);
        this.editor?.setTranslate((key, params) => translate(key as TranslationKey, params));
      };
      syncLocale();
      this.stopLocale = i18nService.subscribe(syncLocale);
      this.stopChange = this.editor.on('change', () => { this.document.changed(); this.notify(); });
      this.stopSnapshot = this.editor.on('selectionChange', this.notify);
      this.stopError = this.editor.on('error', error => { console.warn('[WordEditor] Editor rejected an operation:', error); });
    }
    this.editor.setMode(EDITOR_MODE.View);
    this.editor.load(bytes);
    // Opening and font admission both run asynchronously, including for embedded fonts.
    const deadline = Date.now() + 30000;
    while (true) {
      const state = this.editor.snapshot();
      if (state.parseError) throw new Error(state.parseError);
      if (!state.isLoading && !state.isOpening && !this.editor.fontMeasurement().resolving) {
        // snapshot.editable includes the current viewing mode, not just file capability.
        this.editor.setMode(EDITOR_MODE.Edit);
        if (!this.editor.snapshot().editable || this.editor.fontMeasurement().measurer !== SHAPED_MEASURER) {
          this.editor.setMode(EDITOR_MODE.View);
          throw new Error('Document cannot be edited with shaped fonts');
        }
        break;
      }
      if (Date.now() > deadline) throw new Error('Word editor opening timed out');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    this.editor.setMode(this.readOnly ? EDITOR_MODE.View : EDITOR_MODE.Edit);
    this.notify();
  }

  async save(): Promise<Uint8Array> {
    if (!this.editor) throw new Error('Word editor is not ready');
    return new Uint8Array(await this.editor.save());
  }

  setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
    this.editor?.setMode(readOnly ? EDITOR_MODE.View : EDITOR_MODE.Edit);
  }

  mount(container: HTMLElement): () => void {
    this.mounted = true;
    container.appendChild(this.host);
    evictCleanSessions();
    const frame = requestAnimationFrame(() => {
      const mode = this.editor?.getZoomMode();
      // Moving the live plane changes its scroll viewport. Rebind core's fit
      // observer without reopening bytes or replacing the undo history.
      if (mode?.type === ZOOM_MODE.Fit) {
        this.editor?.setZoomMode({ type: ZOOM_MODE.Fixed });
        this.editor?.setZoomMode(mode);
      }
      this.editor?.relayout();
    });
    return () => {
      cancelAnimationFrame(frame);
      this.mounted = false;
      getParking().appendChild(this.host);
      void this.document.flush();
      evictCleanSessions();
    };
  }

  dispose(): void {
    this.document.dispose();
    this.stopChange?.();
    this.stopSnapshot?.();
    this.stopLocale?.();
    this.stopError?.();
    this.editor?.destroy();
    this.host.remove();
    void window.electron.artifact.word.release(this.document.file.sessionId);
  }
}

export function acquireWordEditor(filePath: string): Promise<WordResult<WordEditorSession>> {
  registry.disposeChanges ??= window.electron.artifact.word.onChanged(sessionId => {
    void sessions.get(sessionId)?.document.refresh();
  });
  registry.disposeLifecycle ??= installMarkdownDocumentLifecycle(window, {
    hasUnsafeEdits,
    flush: async () => { await Promise.all([...sessions.values()].map(session => session.document.flush())); },
  });
  const normalized = normalizeShellFilePath(filePath);
  let pending = paths.get(normalized);
  if (!pending) {
    pending = (async (): Promise<WordResult<WordEditorSession>> => {
      const opened = await window.electron.artifact.word.open(normalized);
      if (!opened.success) return opened;
      let session = sessions.get(opened.value.sessionId);
      if (!session) {
        session = new WordEditorSession(opened.value);
        sessions.set(opened.value.sessionId, session);
      }
      await session.initialize();
      session.aliases.add(normalized);
      const state = session.document.getSnapshot();
      if (!state.ready) {
        session.dispose();
        sessions.delete(opened.value.sessionId);
        return { success: false, code: state.errorCode ?? WordFileError.Unsupported };
      }
      return { success: true, value: session };
    })().catch(error => {
      console.error('[WordEditor] Could not open document:', error);
      return { success: false, code: WordFileError.Io } as const;
    });
    paths.set(normalized, pending);
    void pending.then(result => { if (!result.success) paths.delete(normalized); });
  }
  return pending;
}

/** Route refreshes through the live session instead of replacing its Redux artifact bytes. */
export async function refreshOpenWordEditor(filePath: string): Promise<boolean> {
  const pending = paths.get(normalizeShellFilePath(filePath));
  if (!pending) return false;
  const result = await pending;
  if (!result.success) return false;
  await result.value.document.refresh();
  return true;
}

if (import.meta.hot) {
  // Keep handles, DOM, listeners and exit protection together across development
  // updates too. A new registry could open a second model for the same file.
  import.meta.hot.data.wordEditorRegistry = registry;
  import.meta.hot.dispose(() => {
    for (const session of sessions.values()) void session.document.flush();
  });
}
