// Stand-ins for the SDK's peer dependencies, so its one TypeScript file runs
// under Node as it is. State lives on globalThis.__hush, which each test resets.
const h = (globalThis.__hush ??= { storage: new Map(), listeners: [], dev: false });

export const AsyncStorage = {
  // h.failReads[key] = n: the next n reads of that key reject, as a storage
  // backend that is briefly unavailable does.
  getItem: async (k) => {
    if (h.failReads?.[k] > 0) {
      h.failReads[k] -= 1;
      throw new Error('storage unavailable');
    }
    return h.storage.has(k) ? h.storage.get(k) : null;
  },
  setItem: async (k, v) => void h.storage.set(k, String(v)),
  removeItem: async (k) => void h.storage.delete(k),
};
export const Constants = { expoConfig: { version: '1.2.3', ios: { buildNumber: '45' }, android: { versionCode: 45 } } };
export const AppState = {
  addEventListener(_type, fn) {
    h.listeners.push(fn);
    return { remove() {} };
  },
};
export const Platform = { OS: 'ios' };
