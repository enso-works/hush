// Just enough of the peer dependencies' types to type-check this package
// without installing React Native. The real packages come from the app.
declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  export default AsyncStorage;
}
declare module 'expo-constants' {
  const Constants: { expoConfig?: { version?: string; ios?: { buildNumber?: string }; android?: { versionCode?: number } } | null };
  export default Constants;
}
declare module 'expo-device' {
  export const osVersion: string | null;
  export const modelId: string | null;
  export const modelName: string | null;
}
declare module 'expo-localization' {
  export function getLocales(): { languageTag: string }[];
}
declare module 'react-native' {
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  export const AppState: { addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void } };
  export const Platform: { OS: 'ios' | 'android' | 'web' | 'windows' | 'macos' };
}
