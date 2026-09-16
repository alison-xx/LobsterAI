import { createHash } from 'crypto';

import type { RemoteReplyUpload as ReplyContentUpload } from '../../shared/remote/reply';

interface ReplyUploadOptions {
  sessionId: string;
  deviceId: string;
  scope: string;
  uploads: ReplyContentUpload[];
  transport(): Record<string, string>;
  current(): boolean;
  api(path: string, method: string, body: unknown): Promise<any>;
}

/** Only immutable bytes are uploaded here. A later sync commit publishes their references. */
export class RemoteReplyTransport {
  private readonly chunks = new Map<string, number>();
  clear(): void { this.chunks.clear(); }
  async upload(options: ReplyUploadOptions): Promise<void> {
    const assertCurrent = (): void => { if (!options.current()) throw new Error('Reply synchronization context changed'); };
    const base = `/sessions/${encodeURIComponent(options.sessionId)}/contents`;
    const complete = new Set<string>();
    for (const content of options.uploads) {
      assertCurrent();
      const key = `${content.contentId}:${content.version}`;
      if (complete.has(key)) continue;
      const digest = createHash('sha256');
      let size = 0;
      for (const chunk of content.chunks) {
        const bytes = Buffer.from(chunk.text, 'utf8');
        if (String(bytes.length) !== chunk.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== chunk.sha256) {
          throw new Error('Invalid local reply content chunk');
        }
        digest.update(bytes); size += bytes.length;
      }
      if (String(size) !== content.sizeBytes || digest.digest('hex') !== content.sha256) throw new Error('Invalid local reply content manifest');
      for (const chunk of content.chunks) {
        assertCurrent();
        const cacheKey = `${options.scope}:${options.sessionId}:${chunk.sha256}`;
        if ((this.chunks.get(cacheKey) || 0) <= Date.now()) {
          const ack = await options.api(`${base}/chunks/${chunk.sha256}`, 'PUT', {
            deviceId: options.deviceId, ...options.transport(), text: chunk.text,
          });
          assertCurrent();
          if (ack.sha256 !== chunk.sha256 || String(ack.sizeBytes) !== chunk.sizeBytes) throw new Error('Reply chunk acknowledgement mismatch');
          if (this.chunks.size >= 1024) this.chunks.delete(this.chunks.keys().next().value!);
          this.chunks.set(cacheKey, Date.now() + 30_000);
        }
      }
      const ack = await options.api(`${base}/${encodeURIComponent(content.contentId)}/versions/${encodeURIComponent(content.version)}`, 'PUT', {
        deviceId: options.deviceId, ...options.transport(), messageId: content.messageId, blockId: content.blockId,
        format: content.format, sizeBytes: content.sizeBytes, sha256: content.sha256,
        chunks: content.chunks.map(({ sha256, sizeBytes }) => ({ sha256, sizeBytes })),
      });
      assertCurrent();
      if (ack.contentId !== content.contentId || String(ack.version) !== content.version || String(ack.sizeBytes) !== content.sizeBytes
        || ack.sha256 !== content.sha256 || ack.format !== content.format) throw new Error('Reply manifest acknowledgement mismatch');
      complete.add(key);
    }
  }
}
