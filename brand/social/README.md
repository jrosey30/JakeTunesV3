# Launch animation — social cuts

Made 2026-08-09 for the JakeTunes Instagram account.

| file | use |
|---|---|
| **`jaketunes-launch-reel.mp4`** | **1080x1920, 21s — the launch post (Reels/Stories)** |
| **`jaketunes-launch-post.mp4`** | **1080x1080, 21s — the launch post (feed)** |
| `jaketunes-launch-score.wav` | the 21s score on its own |
| `jaketunes-launch-square.mp4` | 1080x1080, 7s — logo only, the simpler cut |
| `jaketunes-launch-vertical.mp4` | 1080x1920, 7s — logo only |
| `jaketunes-launch-new.wav` | the app's launch chime on its own |

## The 21s launch films

Jake: "it is the first post so get the people excited!!!"

Structure, cut to the score:

    0.0 - 3.2    the boot — dark plate, the logo assembling, the wordmark
    3.2 - 12.9   the PRODUCT: the album wall, the song list, Home, artists,
                 a mixtape — each a real scroll captured from the running app
    12.9 - 15.4  the hush. The window fades to paper and the score drops away
                 to near-silence. The oldest trick there is.
    15.4 - 21.2  the logo assembles a SECOND time, landing exactly on the
                 score's arrival at 16.6s, then holds through the tail

The score is the app's own launch chime arranged out to 21s: the chime intact
at the head, its chord slowed and looped into a bed under the montage, then
the bloom again, louder, as the arrival. Measured RMS confirms the shape —
bloom 0.10, bed 0.03-0.08, hush 0.00, arrival 0.10.

### Constraint worth knowing for next time

The renderer caps `Page.captureScreenshot` at CSS resolution (1390x831); no
`deviceScaleFactor` or `clip.scale` override changes it, and `fromSurface:true`
needs an unoccluded window. So there are no retina app pixels to crop INTO for
a 9:16 frame — a vertical slice would be a 2.3x upscale and mush. The films
therefore SHOW the window whole, downscaled (crisp), and compose the rest of
the frame deliberately: wordmark above, caption below, on the app's own paper.
That's a design decision forced by a real limit, not a shortcut.

The 7s cuts below are the earlier, simpler version — logo only, no product.

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
