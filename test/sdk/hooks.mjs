// Resolve hook: the SDK's imports of React Native and Expo packages load small
// modules built on mocks.mjs instead.
const mocks = new URL('./mocks.mjs', import.meta.url).href;
const MODULES = {
  '@react-native-async-storage/async-storage': `import { AsyncStorage } from '${mocks}'; export default AsyncStorage;`,
  'expo-constants': `import { Constants } from '${mocks}'; export default Constants;`,
  'expo-device': `export const osVersion = '18.6'; export const modelId = 'iPhone17,1'; export const modelName = 'iPhone';`,
  'expo-localization': `export const getLocales = () => [{ languageTag: 'en-US' }];`,
  'react-native': `export { AppState, Platform } from '${mocks}';`,
  // @bavrk/hush-expo's native module: whatever the test puts on globalThis.__hushExpoNative.
  'expo-modules-core': `export const requireOptionalNativeModule = (name) => (name === 'HushExpo' ? (globalThis.__hushExpoNative ?? null) : null);`,
};
export async function resolve(specifier, context, next) {
  if (specifier in MODULES) {
    return { url: `data:text/javascript,${encodeURIComponent(MODULES[specifier])}`, shortCircuit: true };
  }
  return next(specifier, context);
}
