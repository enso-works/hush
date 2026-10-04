// Resolve hook: the SDK's imports of React Native and Expo packages load small
// modules built on mocks.mjs instead.
const mocks = new URL('./mocks.mjs', import.meta.url).href;
const MODULES = {
  '@react-native-async-storage/async-storage': `import { AsyncStorage } from '${mocks}'; export default AsyncStorage;`,
  'expo-constants': `import { Constants } from '${mocks}'; export default Constants;`,
  'expo-device': `export const osVersion = '18.6'; export const modelId = 'iPhone17,1'; export const modelName = 'iPhone';`,
  'expo-localization': `export const getLocales = () => [{ languageTag: 'en-US' }];`,
  'react-native': `export { AppState, Platform } from '${mocks}';`,
  // Records what useConfig() subscribes with, and reads the snapshot as React would.
  react: `export function useSyncExternalStore(subscribe, getSnapshot) { (globalThis.__hushReact ??= []).push({ subscribe, getSnapshot }); return getSnapshot(); }`,
  // @bavrk/hush-expo's native module: whatever the test puts on globalThis.__hushExpoNative.
  'expo-modules-core': `export const requireOptionalNativeModule = (name) => (name === 'HushExpo' ? (globalThis.__hushExpoNative ?? null) : null);`,
  // @bavrk/hush-capacitor's bridge: globalThis.__hushCapacitor is { platform, plugins: { name: methods } };
  // a registered plugin forwards each call to it when made, as Capacitor's proxy does.
  '@capacitor/core': `
    const cap = () => globalThis.__hushCapacitor ?? { platform: 'web', plugins: {} };
    export const Capacitor = {
      getPlatform: () => cap().platform,
      isPluginAvailable: (name) => name in cap().plugins,
    };
    export const registerPlugin = (name) => new Proxy({}, {
      get: (_, method) => method === 'then' ? undefined : (...args) => {
        const impl = cap().plugins[name]?.[method];
        return impl ? impl(...args) : Promise.reject(new Error(name + '.' + String(method) + ' is not implemented on ' + cap().platform));
      },
    });`,
};
export async function resolve(specifier, context, next) {
  if (specifier in MODULES) {
    return { url: `data:text/javascript,${encodeURIComponent(MODULES[specifier])}`, shortCircuit: true };
  }
  return next(specifier, context);
}
