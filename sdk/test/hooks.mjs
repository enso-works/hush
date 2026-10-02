// Resolve hook for the SDK's own tests: React is the real one from
// sdk/node_modules (also for modules compiled at test time and imported from
// data: URLs, which have no node_modules of their own); React Native and Expo
// are small stand-ins on globalThis.__rn, which each test resets.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const rn = `const s = (globalThis.__rn ??= { storage: new Map(), app: [] });`;
const MODULES = {
  '@react-native-async-storage/async-storage': `${rn} export default {
    getItem: async (k) => (s.storage.has(k) ? s.storage.get(k) : null),
    setItem: async (k, v) => void s.storage.set(k, String(v)),
    removeItem: async (k) => void s.storage.delete(k),
  };`,
  'expo-constants': `export default { expoConfig: { version: '2.1.0', ios: { buildNumber: '7' } } };`,
  'expo-device': `export const osVersion = '18.6'; export const modelId = 'iPhone17,1'; export const modelName = 'iPhone';`,
  'expo-localization': `export const getLocales = () => [{ languageTag: 'en-US' }];`,
  'react-native': `${rn} export const Platform = { OS: 'ios' };
    export const AppState = { addEventListener(_t, l) { s.app.push(l); return { remove() {} }; } };`,
};

export async function resolve(specifier, context, next) {
  if (specifier in MODULES) return { url: `data:text/javascript,${encodeURIComponent(MODULES[specifier])}`, shortCircuit: true };
  if (specifier === '@bavrk/hush') return { url: new URL('../src/index.ts', import.meta.url).href, shortCircuit: true };
  if (/^react(-test-renderer)?(\/|$)/.test(specifier)) return { url: `file://${require.resolve(specifier)}`, shortCircuit: true };
  return next(specifier, context);
}
