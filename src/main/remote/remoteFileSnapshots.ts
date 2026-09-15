import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteFileReason } from '../../shared/remote/files';

export const REMOTE_FILE_CACHE_BYTES = 200 * 1024 * 1024;
export interface RemoteFileSnapshot { path: string; sizeBytes: string; sha256?: string; identity: string; cacheIdentity?: string }
const identity = (stat: fs.Stats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
export function remoteFileCacheDirectory(root: string, owner: RemoteOwner): string {
  return path.join(root, createHash('sha256').update(owner.userId).digest('hex'), createHash('sha256').update(owner.scopeKey).digest('hex'));
}
function cacheUsage(directory: string): number {
  let used = 0;
  for (const scope of fs.readdirSync(path.dirname(directory), { withFileTypes: true })) {
    if (!scope.isDirectory()) throw new Error(RemoteFileReason.Source);
    for (const entry of fs.readdirSync(path.join(path.dirname(directory), scope.name), { withFileTypes: true })) {
      if (!entry.isFile()) throw new Error(RemoteFileReason.Source);
      used += fs.statSync(path.join(path.dirname(directory), scope.name, entry.name)).size;
    }
  }
  return used;
}
export function writeRemoteTemporaryInput(root: string, owner: RemoteOwner, bytes: Buffer): string {
  const directory = remoteFileCacheDirectory(root, owner); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (bytes.length > 10 * 1024 * 1024 || cacheUsage(directory) + bytes.length > REMOTE_FILE_CACHE_BYTES) throw new Error(RemoteFileReason.Final);
  const file = path.join(directory, randomUUID()); fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); return file;
}
/** A bounded synchronous copy freezes final-run bytes before a later run can modify them. No network I/O. */
export function captureRemoteFileSnapshot(source: string, root: string, owner: RemoteOwner, maximumBytes: number,
  assertAllowed: () => void): RemoteFileSnapshot {
  assertAllowed();
  if (!path.isAbsolute(source) || fs.lstatSync(source).isSymbolicLink()) throw new Error(RemoteFileReason.Source);
  const canonical = fs.realpathSync.native(source);
  const before = fs.statSync(canonical);
  if (!before.isFile() || before.size < 1 || before.size > maximumBytes) throw new Error(RemoteFileReason.Size);
  const directory = remoteFileCacheDirectory(root, owner);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const used = cacheUsage(directory);
  if (used + before.size > REMOTE_FILE_CACHE_BYTES) throw new Error(RemoteFileReason.Final);
  const target = path.join(directory, randomUUID());
  try {
    assertAllowed();
    fs.copyFileSync(canonical, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(target, 0o600);
    assertAllowed();
    if (fs.realpathSync.native(source) !== canonical || identity(fs.statSync(canonical)) !== identity(before)
      || fs.statSync(target).size !== before.size) throw new Error(RemoteFileReason.Source);
    const hashFile = (file: string): string => {
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const hash = createHash('sha256'), bytes = Buffer.alloc(64 * 1024);
      try { let length: number; while ((length = fs.readSync(descriptor, bytes, 0, bytes.length, null)) > 0) { assertAllowed(); hash.update(bytes.subarray(0, length)); } }
      finally { fs.closeSync(descriptor); }
      return hash.digest('hex');
    };
    const sha256 = hashFile(target);
    if (sha256 !== hashFile(canonical) || identity(fs.statSync(canonical)) !== identity(before)) throw new Error(RemoteFileReason.Source);
    assertAllowed();
    return { path: target, sizeBytes: String(before.size), sha256, identity: identity(before), cacheIdentity: identity(fs.statSync(target)) };
  } catch (error) { fs.rmSync(target, { force: true }); throw error; }
}
/** Hash both the captured source and its copy at a stable boundary, detecting same-size rewrites. */
export async function verifyRemoteFileSnapshot(snapshot: RemoteFileSnapshot, current: () => boolean, source?: string): Promise<string> {
  const hash = async (file: string, expectedIdentity?: string): Promise<string> => {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = await handle.stat(), result = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      if (!before.isFile() || (expectedIdentity && identity(before) !== expectedIdentity)) throw new Error(RemoteFileReason.Source);
      let length: number;
      while ((length = (await handle.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
        if (!current()) throw new Error(RemoteFileReason.Access);
        result.update(buffer.subarray(0, length));
      }
      if (!current()) throw new Error(RemoteFileReason.Access);
      if (identity(await handle.stat()) !== identity(before) || identity(await fs.promises.lstat(file)) !== identity(before)) throw new Error(RemoteFileReason.Source);
      return result.digest('hex');
    } finally { await handle.close(); }
  };
  const digest = await hash(snapshot.path, snapshot.cacheIdentity);
  if (snapshot.sha256 && snapshot.sha256 !== digest) throw new Error(RemoteFileReason.Source);
  if (source) {
    if (identity(fs.statSync(source)) !== snapshot.identity) throw new Error(RemoteFileReason.Source);
    if (await hash(source) !== digest || identity(fs.statSync(source)) !== snapshot.identity) throw new Error(RemoteFileReason.Source);
  }
  return digest;
}
