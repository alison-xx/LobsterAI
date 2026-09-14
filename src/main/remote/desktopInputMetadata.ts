import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type { CoworkImageAttachmentPayload } from '../../shared/cowork/imageAttachments';
import type { CoworkLocalInput } from '../../shared/cowork/inputAttachments';
import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteInputIntent } from '../../shared/remote/input';

export interface DesktopInputSource {
  path: string; fileName: string; mimeType: string; intent: 'file' | 'image'; sizeBytes: string;
  fileIdentity: { dev: string; ino: string; sizeBytes: string; mtimeMs: number };
}
export interface DesktopInputRun { owner: RemoteOwner; text: string; attachments: DesktopInputSource[] }
const mimeTypes: Record<string, string> = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };

/** Captures selected files only. Network upload runs independently after message synchronization. */
export async function captureDesktopInput(input: CoworkLocalInput | undefined, images: CoworkImageAttachmentPayload[] | undefined,
  deps: { owner: RemoteOwner; fallbackText: string; cacheRoot: string; current(): boolean; access(filePath: string): { assertAllowed(): void } }): Promise<DesktopInputRun | null> {
  if (!input && !images?.length) return null;
  const attachments: DesktopInputSource[] = [];
  const selected = Array.isArray(input?.attachments) ? input.attachments.slice(0, 20) : [];
  const candidates = [...selected];
  for (const image of images || []) {
    if (image.role || candidates.some(item => item.path === image.localPath)) continue;
    let filePath = image.localPath;
    if (!filePath && image.base64Data && image.base64Data.length <= 40_000_000 && deps.current()) {
      await fs.mkdir(deps.cacheRoot, { recursive: true, mode: 0o700 });
      if (!deps.current()) return null;
      filePath = path.join(deps.cacheRoot, randomUUID());
      await fs.writeFile(filePath, Buffer.from(image.base64Data, 'base64'), { flag: 'wx', mode: 0o600 });
      if (!deps.current()) { await fs.rm(filePath, { force: true }); return null; }
    }
    if (filePath) candidates.push({ path: filePath, name: image.name, intent: RemoteInputIntent.Image });
  }
  for (const candidate of candidates.slice(0, 20)) {
    if (!deps.current()) return null;
    if (typeof candidate.path !== 'string' || !path.isAbsolute(candidate.path) || typeof candidate.name !== 'string') continue;
    try {
      const lease = deps.access(candidate.path);
      const file = await fs.stat(candidate.path); lease.assertAllowed();
      if (!deps.current()) return null;
      if (!file.isFile() || file.size > 100 * 1024 * 1024) continue;
      const image = images?.find(value => value.localPath === candidate.path || value.name === candidate.name);
      attachments.push({ path: candidate.path, fileName: path.basename(candidate.name.replace(/\\/gu, '/')).slice(0, 255),
        mimeType: image?.mimeType || mimeTypes[path.extname(candidate.path).toLowerCase()] || 'application/octet-stream',
        intent: candidate.intent === RemoteInputIntent.Image ? RemoteInputIntent.Image : RemoteInputIntent.File, sizeBytes: String(file.size),
        fileIdentity: { dev: String(file.dev), ino: String(file.ino), sizeBytes: String(file.size), mtimeMs: file.mtimeMs } });
    } catch { /* Local execution retains its selected paths; an unavailable file is not uploaded. */ }
  }
  return { owner: deps.owner, text: typeof input?.text === 'string' ? input.text : deps.fallbackText, attachments };
}
