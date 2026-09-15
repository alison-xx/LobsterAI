import { promises as fs } from 'fs';
import path from 'path';

import type { CoworkImageAttachmentPayload } from '../../shared/cowork/imageAttachments';
import type { CoworkLocalInput } from '../../shared/cowork/inputAttachments';
import type { RemoteOwner } from '../../shared/remote/constants';
import { remoteFileLocalLimit } from '../../shared/remote/files';
import { RemoteInputIntent } from '../../shared/remote/input';
import { captureRemoteFileSnapshot, type RemoteFileSnapshot, writeRemoteTemporaryInput } from './remoteFileSnapshots';

export interface DesktopInputSource {
  path: string; fileName: string; mimeType: string; intent: 'file' | 'image'; sizeBytes: string;
  fileIdentity: { dev: string; ino: string; sizeBytes: string; mtimeMs: number };
  snapshot?: RemoteFileSnapshot;
}
export interface DesktopInputRun { owner: RemoteOwner; text: string; attachments: DesktopInputSource[] }
const mimeTypes: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

/** Captures selected files only. Network upload runs independently after message synchronization. */
export async function captureDesktopInput(input: CoworkLocalInput | undefined, images: CoworkImageAttachmentPayload[] | undefined,
  deps: { owner: RemoteOwner; fallbackText: string; cacheRoot: string; captureSnapshot?: boolean; current(): boolean; access(filePath: string): { assertAllowed(): void } }): Promise<DesktopInputRun | null> {
  if (!input && !images?.length) return null;
  const attachments: DesktopInputSource[] = [];
  let capturedBytes = 0, capturedImages = 0, capturedCount = 0;
  const temporary = new Set<string>();
  const selected = Array.isArray(input?.attachments) ? input.attachments.slice(0, 20) : [];
  const candidates = [...selected];
  for (const image of images || []) {
    if (image.role || candidates.some(item => item.path === image.localPath)) continue;
    let filePath = image.localPath;
    if (!filePath && deps.captureSnapshot && image.base64Data && image.base64Data.length <= 14_000_000 && deps.current()) {
      try { filePath = writeRemoteTemporaryInput(deps.cacheRoot, deps.owner, Buffer.from(image.base64Data, 'base64')); temporary.add(filePath); }
      catch { continue; }
    }
    if (filePath) candidates.push({ path: filePath, name: image.name, intent: RemoteInputIntent.Image });
  }
  try { for (const candidate of candidates.slice(0, 20)) {
    if (!deps.current()) return null;
    if (typeof candidate.path !== 'string' || !path.isAbsolute(candidate.path) || typeof candidate.name !== 'string') continue;
    try {
      const lease = deps.access(candidate.path);
      const file = await fs.stat(candidate.path); lease.assertAllowed();
      if (!deps.current()) return null;
      if (!file.isFile() || file.size > 100 * 1024 * 1024) continue;
      const image = images?.find(value => value.localPath === candidate.path || value.name === candidate.name);
      const localLimit = remoteFileLocalLimit(candidate.name, false);
      const mayCapture = deps.captureSnapshot && localLimit !== null && file.size <= localLimit && capturedCount < 10
        && capturedBytes + file.size <= 100 * 1024 * 1024 && (candidate.intent !== RemoteInputIntent.Image || capturedImages + file.size <= 20 * 1024 * 1024);
      const snapshot = mayCapture ? captureRemoteFileSnapshot(candidate.path, deps.cacheRoot, deps.owner, localLimit!,
        () => { if (!deps.current()) throw new Error('ACCESS_DENIED'); lease.assertAllowed(); }) : undefined;
      if (snapshot) { capturedBytes += file.size; capturedCount++; if (candidate.intent === RemoteInputIntent.Image) capturedImages += file.size; }
      attachments.push({ path: candidate.path, fileName: path.basename(candidate.name.replace(/\\/gu, '/')).slice(0, 255), ...(snapshot ? { snapshot } : {}),
        mimeType: image?.mimeType || mimeTypes[path.extname(candidate.path).toLowerCase()] || 'application/octet-stream',
        intent: candidate.intent === RemoteInputIntent.Image ? RemoteInputIntent.Image : RemoteInputIntent.File, sizeBytes: String(file.size),
        fileIdentity: { dev: String(file.dev), ino: String(file.ino), sizeBytes: String(file.size), mtimeMs: file.mtimeMs } });
    } catch { /* Local execution retains its selected paths; an unavailable file is not uploaded. */ }
  } } finally {
    for (const file of temporary) await fs.rm(file, { force: true });
    if (!deps.current()) for (const source of attachments) if (source.snapshot) await fs.rm(source.snapshot.path, { force: true });
  }
  return { owner: deps.owner, text: typeof input?.text === 'string' ? input.text : deps.fallbackText, attachments };
}
