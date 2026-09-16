import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

import type { RemoteReplyUpload as ReplyContentUpload } from '../../shared/remote/reply';
import { RemoteReplyTransport } from './remoteReplyTransport';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const text = '中文🙂 stream';
const chunk = { text, sizeBytes: String(Buffer.byteLength(text)), sha256: hash(text) };
const content: ReplyContentUpload = { contentId: 'body', version: '2', messageId: 'message', blockId: 'block', format: 'text',
  sizeBytes: chunk.sizeBytes, sha256: chunk.sha256, chunks: [chunk] };
const setup = () => {
  const api = vi.fn(async (path: string, _method: string, body: any) => path.includes('/chunks/')
    ? { sha256: hash(body.text), sizeBytes: String(Buffer.byteLength(body.text)) }
    : { contentId: content.contentId, version: content.version, sizeBytes: body.sizeBytes, sha256: body.sha256, format: body.format });
  return { sessionId: 'session', deviceId: 'device', scope: 'owner/environment', uploads: [content],
    transport: () => ({ mode: 'online', connectionGeneration: '3' }), current: () => true, api };
};
describe('reply body upload', () => {
  it('uploads verified bytes before an immutable manifest, and reuses recent chunks', async () => {
    const options = setup(); const transport = new RemoteReplyTransport();
    await transport.upload(options);
    expect(options.api.mock.calls.map(call => call[0])).toEqual([
      `/sessions/session/contents/chunks/${chunk.sha256}`, '/sessions/session/contents/body/versions/2',
    ]);
    expect(options.api.mock.calls[1][2].chunks).toEqual([{ sha256: chunk.sha256, sizeBytes: chunk.sizeBytes }]);
    expect(options.api.mock.calls[1][2]).not.toHaveProperty('text');
    await transport.upload(options);
    expect(options.api).toHaveBeenCalledTimes(3);
    await transport.upload({ ...options, scope: 'other-owner/environment' });
    expect(options.api).toHaveBeenCalledTimes(5);
  });
  it('never publishes a manifest after a chunk ACK mismatch', async () => {
    const options = setup(); options.api.mockResolvedValueOnce({ sha256: 'wrong', sizeBytes: chunk.sizeBytes });
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('acknowledgement mismatch');
    expect(options.api).toHaveBeenCalledTimes(1);
  });
  it('stops immediately if identity changes during upload', async () => {
    const options = setup(); let active = true;
    options.current = () => active;
    options.api.mockImplementationOnce(async () => { active = false; return { sha256: chunk.sha256, sizeBytes: chunk.sizeBytes }; });
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('context changed');
    expect(options.api).toHaveBeenCalledTimes(1);
  });
  it('rejects inconsistent cached content before network access', async () => {
    const options = setup(); options.uploads = [{ ...content, sha256: 'incorrect' }];
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('Invalid local reply content manifest');
    expect(options.api).not.toHaveBeenCalled();
  });
  it('rejects a forged manifest receipt', async () => {
    const options = setup();
    options.api.mockResolvedValueOnce({ sha256: chunk.sha256, sizeBytes: chunk.sizeBytes });
    options.api.mockResolvedValueOnce({ contentId: 'other', version: '2', sizeBytes: chunk.sizeBytes, sha256: chunk.sha256 });
    await expect(new RemoteReplyTransport().upload(options)).rejects.toThrow('manifest acknowledgement mismatch');
  });
});
