import { watch } from 'node:fs';
import path from 'node:path';

import { app, type BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { WordFileError, WordFileIpc, type WordWriteRequest } from '../../shared/artifactPreview/wordEditing';
import { WordFileStore } from '../libs/wordFileEditing';

const unsafeEditors = new Set<WebContents>();
export const hasUnsafeWordEdits = (): boolean => unsafeEditors.size > 0;

export function registerWordEditingHandlers(getMainWindow: () => BrowserWindow | null): void {
  const store = new WordFileStore(path.join(app.getPath('userData'), 'word-drafts'));
  const observed = new WeakSet<WebContents>();
  const ownerEpoch = new WeakMap<WebContents, number>();
  const watches = new Map<string, { owner: number; close: () => void }>();
  const releaseWatches = (owner: number) => {
    for (const [id, watcher] of watches) if (watcher.owner === owner) {
      watcher.close(); watches.delete(id);
    }
  };
  const watchDocument = (owner: WebContents, sessionId: string, filePath: string) => {
    if (watches.has(sessionId)) return;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Watch the directory: Office and our own saves replace the file's inode.
      const watcher = watch(path.dirname(filePath), { persistent: false }, (_event, name) => {
        if (name && name.toString().toLowerCase() !== path.basename(filePath).toLowerCase()) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!owner.isDestroyed()) owner.send(WordFileIpc.Changed, sessionId);
        }, 250);
      });
      watcher.on('error', error => { console.warn('[WordFiles] Document watcher failed:', error); });
      watches.set(sessionId, { owner: owner.id, close: () => { clearTimeout(timer); watcher.close(); } });
    } catch (error) {
      // Save still checks versions even if this filesystem cannot be watched.
      console.warn('[WordFiles] Could not watch document:', error);
    }
  };
  const allowed = (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>): boolean => {
    const owner = getMainWindow()?.webContents;
    if (!owner || owner.isDestroyed() || event.sender !== owner || event.senderFrame !== owner.mainFrame) return false;
    if (!observed.has(owner)) {
      observed.add(owner);
      const clear = () => {
        ownerEpoch.set(owner, (ownerEpoch.get(owner) ?? 0) + 1);
        store.releaseOwner(owner.id); releaseWatches(owner.id); unsafeEditors.delete(owner);
      };
      owner.once('destroyed', clear);
      owner.on('render-process-gone', clear);
      owner.on('did-navigate', clear);
    }
    return true;
  };
  const forbidden = { success: false, code: WordFileError.Forbidden } as const;
  ipcMain.handle(WordFileIpc.Open, async (event, filePath: string) => {
    if (!allowed(event)) return forbidden;
    const epoch = ownerEpoch.get(event.sender) ?? 0;
    const result = await store.open(event.sender.id, filePath);
    if (!allowed(event) || (ownerEpoch.get(event.sender) ?? 0) !== epoch) {
      if (result.success) store.release(event.sender.id, result.value.sessionId);
      return forbidden;
    }
    if (result.success) watchDocument(event.sender, result.value.sessionId, result.value.filePath);
    return result;
  });
  ipcMain.handle(WordFileIpc.Read, (event, sessionId: string) =>
    allowed(event) ? store.read(event.sender.id, sessionId) : forbidden);
  ipcMain.handle(WordFileIpc.Checkpoint, (event, request: WordWriteRequest) =>
    allowed(event) ? store.checkpoint(event.sender.id, request) : forbidden);
  ipcMain.handle(WordFileIpc.Save, (event, request: WordWriteRequest) =>
    allowed(event) ? store.save(event.sender.id, request) : forbidden);
  ipcMain.handle(WordFileIpc.DiscardDraft, (event, sessionId: string) =>
    allowed(event) ? store.discardDraft(event.sender.id, sessionId) : forbidden);
  ipcMain.handle(WordFileIpc.Release, (event, sessionId: string) => {
    if (!allowed(event)) return;
    store.release(event.sender.id, sessionId);
    const watcher = watches.get(sessionId);
    if (watcher?.owner === event.sender.id) { watcher.close(); watches.delete(sessionId); }
  });
  ipcMain.on(WordFileIpc.SetUnsafeEdits, (event, unsafe: unknown) => {
    if (!allowed(event) || typeof unsafe !== 'boolean') return;
    if (unsafe) unsafeEditors.add(event.sender);
    else unsafeEditors.delete(event.sender);
  });
}
