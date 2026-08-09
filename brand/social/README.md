# Launch animation — social cuts

Made 2026-08-09 for the JakeTunes Instagram account.

| file | use |
|---|---|
| `jaketunes-launch-square.mp4` | 1080x1080, feed post |
| `jaketunes-launch-vertical.mp4` | 1080x1920, Reels / Stories |
| `jaketunes-launch-new.wav` | the launch sound on its own, 48k stereo |

Both are 7s: the real animation (~3.05s) then the settled logo held under the
chord's tail.

## How they were made — so this is repeatable, not a one-off

The picture is the ACTUAL app, not a recreation. `Page.startScreencast` over
CDP, then `Page.reload` so the splash replays, capturing every frame WITH its
timestamp. The video is assembled from those timestamps rather than a guessed
frame rate, because the audio's chord has to land on the logo landing and
"about 30fps" isn't good enough for that.

The audio is the app's own synthesis (`src/renderer/utils/introStinger.ts`)
rendered through an OfflineAudioContext inside the running app — not a
re-recording and not an approximation. Same graph, same numbers.

Two things that had to be got right, both caught by sampling frames rather
than trusting the render:

- **Hold the last SPLASH frame, not the last captured frame.** The capture
  keeps running after the splash ends, so the naive "hold the final frame"
  parked the app's library page on screen for the last three seconds.
- **Crop above the greeting.** The splash's greeting line ("Burning the
  midnight oil, Jake.") is time-of-day specific and personal — fine in the
  app, wrong baked into a post forever. The content bands were measured
  (logo 398-873, wordmark 906-973, tagline 993-1018, greeting 1031-1059) and
  the crop ends at 990, so the frame holds the logo and wordmark only. There
  is no square crop that includes the tagline AND excludes the greeting —
  they are 13px apart.

To regenerate: launch with `--remote-debugging-port=9222`, capture with the
screencast script, then the ffmpeg concat + crop + pad in this session's
history.
