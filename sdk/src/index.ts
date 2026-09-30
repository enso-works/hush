/**
 * hush for React Native and Expo: in-app feedback and anonymous usage
 * tracking, talking to a hush server. The logic is the platform-free core
 * (core.ts); this file gives it AsyncStorage, AppState, expo-constants,
 * expo-device and expo-localization, and exposes one instance as the
 * module-level API:
 *
 *   import * as hush from '@bavrk/hush';
 *   hush.configure({ url, key });
 *   hush.init();
 *
 * The only identifier is an install UUID generated on first launch. No
 * account, no advertising id, no location. If the server is down or the key
 * is empty, the app behaves exactly as without it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Localization from 'expo-localization';
import { AppState, Platform } from 'react-native';

import { createHush } from './core.ts';

declare const __DEV__: boolean | undefined;

const client = createHush({
  storage: AsyncStorage,
  onAppState(listener) {
    AppState.addEventListener('change', (state) => {
      if (state === 'active') listener('active');
      // iOS passes through 'inactive' (Control Center, the app switcher) on
      // its way out; it counts as leaving.
      else if (state === 'background' || state === 'inactive') listener('background');
    });
  },
  device: () => ({
    version: Constants.expoConfig?.version ?? '',
    build: String(
      Platform.OS === 'ios' ? (Constants.expoConfig?.ios?.buildNumber ?? '') : (Constants.expoConfig?.android?.versionCode ?? ''),
    ),
    platform: Platform.OS,
    os: `${Platform.OS} ${Device.osVersion ?? ''}`.trim(),
    device: Device.modelId ?? Device.modelName ?? '',
    // The phone's language, not the app's override: it says which
    // translations are worth having, which is what the number is for.
    locale: Localization.getLocales()[0]?.languageTag ?? '',
  }),
  isDev: () => typeof __DEV__ !== 'undefined' && !!__DEV__,
});

export const {
  configure,
  init,
  track,
  screen,
  identify,
  entry,
  setGlobalProps,
  removeGlobalProp,
  clearGlobalProps,
  installationId,
  getInstallationId,
  optOut,
  optIn,
  isOptedOut,
  forget,
  setEnabled,
  flushNow,
  pause,
  resume,
  createTicket,
  replyToTicket,
  listTickets,
  telemetryAvailable,
} = client;

export { SDK_VERSION, createHush } from './core.ts';
export type {
  AttributionBridge,
  ConversionValue,
  DeviceInfo,
  Entry,
  FlushResult,
  Hush,
  HushConfig,
  HushPlatform,
  HushStorage,
  LifecycleState,
  Props,
  Ticket,
  TicketKind,
} from './core.ts';
