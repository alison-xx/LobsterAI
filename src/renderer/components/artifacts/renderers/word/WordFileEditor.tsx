import './wordEditor.css';

import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { WordSaveState } from '@/services/wordDocument';
import { acquireWordEditor, type WordEditorSession } from '@/services/wordEditorSession';
import { openLocalPathWithToast, revealLocalPathWithToast } from '@/utils/localFileActions';

import { WordFileError, type WordResult } from '../../../../../shared/artifactPreview/wordEditing';
import { useRegisterOfficePreviewZoomControls } from '../OfficePreviewActionsContext';
import { WordToolbar } from './WordToolbar';

const t = (key: string) => i18nService.t(key);
const SAVE_LABEL = {
  [WordSaveState.Loading]: 'wordLoading', [WordSaveState.Saved]: 'wordSaved',
  [WordSaveState.Pending]: 'wordPending', [WordSaveState.Saving]: 'wordSaving',
  [WordSaveState.Conflict]: 'wordConflict', [WordSaveState.Error]: 'wordSaveFailed',
};
const ConflictChoice = { Mine: 'mine', Disk: 'disk' } as const;
type ConflictChoice = typeof ConflictChoice[keyof typeof ConflictChoice];

function errorLabel(code?: WordFileError): string {
  if (code === WordFileError.TooLarge) return t('wordTooLarge');
  if (code === WordFileError.Unsupported) return t('wordUnsupported');
  return t('wordAccessFailed');
}

function ActiveWordEditor({ session }: { session: WordEditorSession }): React.ReactElement {
  const document = session.document;
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const editorState = useSyncExternalStore(session.subscribeEditor, session.getEditorSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<ConflictChoice | null>(null);
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    const unmount = session.mount(host.current);
    void document.refresh();
    return unmount;
  }, [session, document]);
  useEffect(() => {
    const onFocus = () => { void document.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [document]);
  const zoomControls = useMemo(() => ({
    zoomFactor: editorState?.zoom ?? 1,
    onZoomOut: () => session.editor?.setZoom(Math.max(0.25, (session.editor?.getZoom() ?? 1) - 0.1)),
    onZoomIn: () => session.editor?.setZoom(Math.min(3, (session.editor?.getZoom() ?? 1) + 0.1)),
    onResetZoom: () => session.editor?.setZoomMode('auto'),
  }), [session, editorState?.zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);

  const resolve = async (next: ConflictChoice) => {
    if (choice !== next) { setChoice(next); return; }
    setResolving(true);
    try { await document.resolveConflict(next === ConflictChoice.Mine); }
    finally { setResolving(false); setChoice(null); }
  };

  return (
    <section className="lobster-word-editor" aria-label={t('wordEditor')}
      onKeyDownCapture={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); event.stopPropagation(); void document.flush();
        }
      }}>
      <div className="lobster-word-statusbar">
        <span className="flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
          {state.status === WordSaveState.Saved && <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />}
          {t(SAVE_LABEL[state.status])}
          {state.status !== WordSaveState.Saved && state.draftSafe && <span className="opacity-60">· {t('wordDraftSafe')}</span>}
        </span>
        <button type="button" disabled={resolving || state.status === WordSaveState.Saving || !document.dirty}
          onClick={() => { void document.flush(); }}>{t('save')}</button>
      </div>
      {state.needsResolution && (
        <div className="lobster-word-notice" role="alert">
          <p>{t(state.restored ? 'wordRecovered' : 'wordConflictHelp')}</p>
          {choice && <p className="font-medium">{t(choice === ConflictChoice.Mine ? 'wordConfirmMine' : 'wordConfirmDisk')}</p>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button type="button" disabled={resolving} onClick={() => { void resolve(ConflictChoice.Mine); }}>{t('wordKeepMine')}</button>
            <button type="button" disabled={resolving} onClick={() => { void resolve(ConflictChoice.Disk); }}>{t('wordUseDisk')}</button>
            {choice && <button type="button" onClick={() => setChoice(null)}>{t('cancel')}</button>}
          </div>
        </div>
      )}
      {state.status === WordSaveState.Error && (
        <div className="lobster-word-notice" role="alert">
          <p>{errorLabel(state.errorCode)} {t(state.draftSafe ? 'wordDraftRetained' : 'wordDraftUnsafe')}</p>
          <button type="button" onClick={() => { void (document.dirty ? document.flush() : document.refresh()); }}>{t('retry')}</button>
        </div>
      )}
      <WordToolbar session={session} />
      <div className="lobster-word-mount docx-editor__scroll-container" ref={host} />
      <div className="lobster-word-footer">
        <span>{t('wordPage')} {editorState?.page.current ?? 1} / {editorState?.page.total ?? 1}</span>
        {state.originalCopyPath && <button type="button" onClick={() => { void revealLocalPathWithToast(state.originalCopyPath!); }}>{t('wordOriginalCopy')}</button>}
        <span title={t('wordFontNotice')}>{t('wordLocalFonts')}</span>
      </div>
    </section>
  );
}

export default function WordFileEditor({ filePath, preview }: { filePath: string; preview: React.ReactNode }): React.ReactElement {
  const [result, setResult] = useState<WordResult<WordEditorSession>>();
  const [previewing, setPreviewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setPreviewing(false);
    void acquireWordEditor(filePath).then(opened => { if (!cancelled) setResult(opened); });
    return () => { cancelled = true; };
  }, [filePath, attempt]);
  if (result?.success) return <ActiveWordEditor key={result.value.document.file.sessionId} session={result.value} />;
  if (!result) return <div className="p-6 text-sm opacity-60" role="status">{t('wordLoading')}</div>;
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="lobster-word-notice" role="status">
        <p>{errorLabel(result.code)}</p>
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={() => setPreviewing(true)}>{t('wordPreview')}</button>
          <button type="button" onClick={() => { void openLocalPathWithToast(filePath); }}>{t('wordOpenExternal')}</button>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('retry')}</button>
        </div>
      </div>
      {previewing && <div className="flex-1 min-h-0">{preview}</div>}
    </div>
  );
}
