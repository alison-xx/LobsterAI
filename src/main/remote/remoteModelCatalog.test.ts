import { describe, expect, it } from 'vitest';

import { RemoteInputReason } from '../../shared/remote/input';
import { type LocalRemoteModel, RemoteModelCatalog } from './remoteModelCatalog';
import type { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
function fixture() {
  const values = new Map<string, unknown>();
  const store = { get: <T>(key: string): T | null => values.get(key) as T ?? null,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)) };
  let models: LocalRemoteModel[] = [{ identity: 'provider/model', runtimeRef: 'custom/model', source: 'custom', displayName: 'Chat model',
    providerLabel: 'Custom', available: true, image: true, toolCalling: true, thinking: { options: ['low', 'high'], default: 'low' },
    configuration: { apiKey: 'secret-one', baseURL: 'http://private.local/v1' } }];
  return { values, catalog: new RemoteModelCatalog(store as Pick<RemoteStore, 'get' | 'put'>, () => models),
    change: (patch: Partial<LocalRemoteModel>) => { models = [{ ...models[0], ...patch }]; }, remove: () => { models = []; } };
}
describe('remote model references', () => {
  it('keeps selectable models usable without asserting tool-calling support', () => {
    const { catalog, change } = fixture();
    change({ toolCalling: false });
    const item = catalog.refresh(owner, 'pc')[0];
    expect(item).toMatchObject({ available: true, unavailableReason: null, inputCapabilities: { toolCalling: false } });
    expect(catalog.resolve(owner, 'pc', item.modelRef, item.version).item).toEqual(item);
  });
  it('limits public labels to server UTF-16 units without splitting emoji', () => {
    const { catalog, change } = fixture();
    change({ displayName: 'x' + '🦞'.repeat(100), providerLabel: '🦞'.repeat(100) });
    const item = catalog.refresh(owner, 'pc')[0];
    expect(item.displayName).toHaveLength(119);
    expect(item.providerLabel).toHaveLength(120);
    expect(item.displayName.endsWith('🦞')).toBe(true);
  });
  it('round-trips server-normalized null thinking defaults without repeating publication', async () => {
    const { catalog, change } = fixture();
    change({ displayName: 'x'.repeat(150), thinking: { options: [] } });
    const items = catalog.refresh(owner, 'pc');
    expect(items[0].displayName).toHaveLength(120);
    expect(items[0].thinking).toEqual({ options: [], default: null });
    let writes = 0;
    await catalog.publish(owner, 'pc', '1', async (_path, method) => {
      if (method === 'POST') writes++;
      return { catalogVersion: '1', items };
    }, () => true);
    expect(writes).toBe(0);
  });
  it('publishes safe opaque references and keeps credentials and addresses local', () => {
    const { catalog } = fixture();
    const items = catalog.refresh(owner, 'pc');
    expect(items[0].modelRef).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(items)).not.toMatch(/secret-one|private.local|apiKey|baseURL|runtimeRef/u);
    expect(catalog.resolve(owner, 'pc', items[0].modelRef, '1').local.runtimeRef).toBe('custom/model');
  });
  it('isolates account, space and target device without guessing same-name models', () => {
    const { catalog } = fixture(); const item = catalog.refresh(owner, 'pc')[0];
    for (const [actor, device] of [[{ userId: 'B', scopeKey: 'personal' }, 'pc'], [{ ...owner, scopeKey: 'team' }, 'pc'], [owner, 'other']] as const) {
      expect(() => catalog.resolve(actor, device, item.modelRef)).toThrow(RemoteInputReason.ModelUnavailable);
    }
    expect(() => catalog.resolveRuntime(owner, 'pc', 'other/model')).toThrow(RemoteInputReason.ModelUnavailable);
  });
  it('invalidates exact versions on secret rotation and capability changes', () => {
    const { catalog, change } = fixture(); const item = catalog.refresh(owner, 'pc')[0];
    change({ configuration: { apiKey: 'secret-two' } });
    expect(catalog.refresh(owner, 'pc')[0]).toMatchObject({ modelRef: item.modelRef, version: '2' });
    expect(() => catalog.resolve(owner, 'pc', item.modelRef, '1')).toThrow(RemoteInputReason.ModelChanged);
    change({ image: false }); expect(catalog.refresh(owner, 'pc')[0].version).toBe('3');
  });
  it('never reuses deleted references or replaces an unavailable model', () => {
    const { catalog, change, remove } = fixture(); const item = catalog.refresh(owner, 'pc')[0];
    remove(); catalog.refresh(owner, 'pc');
    change({ identity: 'provider/model', runtimeRef: 'custom/model', source: 'custom', displayName: 'New', providerLabel: 'Custom',
      available: true, image: false, toolCalling: true, thinking: { options: [] }, configuration: {} });
    expect(catalog.refresh(owner, 'pc')[0].modelRef).not.toBe(item.modelRef);
    expect(() => catalog.resolve(owner, 'pc', item.modelRef)).toThrow(RemoteInputReason.ModelUnavailable);
    change({ available: false }); expect(catalog.refresh(owner, 'pc')[0].available).toBe(false);
  });
  it('recovers a lost publication response using the same immutable receipt', async () => {
    const { catalog } = fixture(); let published: any = null;
    const api = async (_path: string, method?: string, body?: any) => {
      if (method === 'POST') { published = body; throw new Error('response lost'); }
      return published ? { catalogVersion: '1', lastPublicationId: published.publicationId, items: published.items } : { catalogVersion: '0', items: [] };
    };
    await expect(catalog.publish(owner, 'pc', '1', api, () => true)).rejects.toThrow('response lost');
    await expect(catalog.publish(owner, 'pc', '2', api, () => true)).resolves.toBeUndefined();
  });
});
