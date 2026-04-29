// One-shot TrackPlayer.setupPlayer + capability registration. Called
// at app startup from PlaybackContext. Idempotent — safe to call from
// hot reload paths.

import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  IOSCategory,
  IOSCategoryMode,
  IOSCategoryOptions,
} from 'react-native-track-player'

let setupDone = false

export async function ensureTrackPlayerReady(): Promise<void> {
  if (setupDone) return
  await TrackPlayer.setupPlayer({
    iosCategory: IOSCategory.Playback,
    iosCategoryMode: IOSCategoryMode.Default,
    // AllowAirPlay: AirPlay routing inherits from this category.
    // MixWithOthers: false by default — JakeTunes Mobile takes the
    // audio session like a "real" music app, ducking nav and other
    // background audio.
    iosCategoryOptions: [IOSCategoryOptions.AllowAirPlay],
    autoHandleInterruptions: true,
  })
  await TrackPlayer.updateOptions({
    android: {
      appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
    },
    capabilities: [
      Capability.Play,
      Capability.Pause,
      Capability.SkipToNext,
      Capability.SkipToPrevious,
      Capability.SeekTo,
      Capability.Stop,
    ],
    compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
    progressUpdateEventInterval: 1,
  })
  setupDone = true
}
