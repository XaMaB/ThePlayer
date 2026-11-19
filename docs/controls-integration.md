# Controls and optional modules

ThePlayer's controls are independent of the MoQ, HLS and DASH transports. Mount one controls instance per video. The video, subtitle overlays and controls should share a positioned `screen` container. Include `style.css` from the distribution (or supply equivalent styles). Call `controls.destroy()` before removing or replacing the UI.

```js
import { ThePlayer, mountControls } from './player.js';

const player = new ThePlayer(video);
const controls = mountControls(screen, video, () => player, showError, {
  autoHideDelayMs: 3000,
  pictureInPicture: { mode: 'auto', automatic: false },
  layout: {
    toolbar: [
      'play',
      'mute',
      'volume',
      'time',
      'seek',
      'spacer',
      'quality',
      'audio',
      'captions',
      'options',
      'pip',
      'fullscreen',
    ],
    center: ['back', 'play', 'forward'],
  },
  extras: {
    playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
    captions: {},
    frameCapture: true,
  },
});
// Load a source using player.load(...); playback remains application-owned.
// On removal: controls.destroy(); await player.destroy();
```

`video`, `screen` and `showError` are application-owned elements/callbacks. Settings apply to every supported transport where the source and browser expose the required capability. The `options` button and right-click menu contain the additional settings in collapsible groups. Live streams do not display the VOD speed selector. Unavailable chapter, queue, remote and capture groups are hidden.

## Layout

`layout.toolbar` selects and orders the named controls shown above. `layout.center` accepts `back`, `play`, `forward`. Omitted arrays use the default layout; an empty array hides that group. Unknown or duplicate names are rejected. Use `controls.configureLayout({toolbar: [...], center: [...]})` to reconfigure at runtime; omitted arrays revert to defaults. This changes presentation, not keyboard shortcuts or engine capabilities. Hiding `seek` also hides its timeline markers. Applications may use different layouts at breakpoints; the supplied CSS adapts button sizes for narrow screens.

## Extra settings defaults

| Option          | Default                   | Meaning                                                                  |
| --------------- | ------------------------- | ------------------------------------------------------------------------ |
| `extras`        | `{}`                      | `false` disables all additional groups.                                  |
| `playbackRates` | `[0.5,0.75,1,1.25,1.5,2]` | VOD rates; accepted range 0.25–4. `false` removes the selector.          |
| `captions`      | `{}`                      | Source appearance; `false` removes appearance controls.                  |
| `chapters`      | Native chapter tracks     | Array or `(player) => Chapter[]` callback.                               |
| `queue`         | None                      | Application-owned `PlaybackQueue`.                                       |
| `remote`        | Native discovery          | `false` disables remote controls, or `{video, cast}` as described below. |
| `frameCapture`  | `false`                   | Opt into Save/Copy frame controls for eligible video.                    |

The controls never persist preferences in localStorage, cookies or a server. Applications may save a user's chosen preferences through their own settings system. Inserted/ad presentations hide queue navigation, chapters, speed and capture to avoid interfering with their timelines.

## Subtitle appearance

`controls.extras.captions` is a `CaptionAppearanceController` with `value`, `set(preferences)`, `reset()` and `destroy()` (owned/destroyed by the controls). A standalone controller can also be imported. Use only one controller per video.

```js
controls.extras.captions.set({
  scale: 1.25,
  offset: -10,
  color: 'yellow',
  background: 'dark',
  font: 'sans-serif',
  outline: true,
});
// Save controls.extras.captions.value in your application if desired.
controls.extras.captions.reset();
```

| Setting      | Values                                       | Effect                                                                                                                                                                |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scale`      | 0.5–2, default 1                             | Scale custom subtitle layers; resize native text.                                                                                                                     |
| `offset`     | -40–40, default 0                            | Vertical percentage offset; negative moves up. Native authored percentage lines are adjusted; line-number/automatic positioning uses a 90% baseline while overridden. |
| `color`      | `source`, `white`, `yellow`, `cyan`          | Text only.                                                                                                                                                            |
| `background` | `source`, `transparent`, `dark`, `solid`     | Text background; dark uses 75% opacity.                                                                                                                               |
| `font`       | `source`, `sans-serif`, `serif`, `monospace` | Text only.                                                                                                                                                            |
| `outline`    | Boolean, default false                       | Dark outline/shadow for legibility; reset preserves the renderer's source defaults.                                                                                   |

DVB and bitmap Teletext captions support scale/position only: pixels do not contain editable fonts. Text controls are disabled for these selected formats. Default settings preserve authored CEA/TTML layout and styling. A user scale/position override can clip content at the video edge. Native cue support and font rendering vary by browser. MoQ canvas subtitles use `SubtitleRenderer`; its caption canvas is marked automatically. Custom integrations with another bitmap renderer must apply their own appearance adapter. Document PiP carries the styles with the screen; native video PiP does not carry custom DOM/canvas captions.

## VOD playback speed

The selector sets `video.playbackRate`. Unsupported rates can still be rejected by the browser. Live latency control remains engine-owned and the selector is hidden for live sources. When switching from VOD to live, a rate selected through these controls is cleared rather than competing with live catch-up logic. A source reload may reset the rate. Destroying the controls restores the original rate only if the user-selected value is still active.

## Chapters

```js
const chapterMap = new Map([
  [
    movieUrl,
    [
      { title: 'Opening', start: 0 },
      { title: 'Part two', start: 120 },
    ],
  ],
]);
// Pass to extras:
const chapters = (player) => chapterMap.get(player?.source?.url) ?? [];
```

`Chapter` has `title: string` and `start: number` in seconds on the video's playback timeline. Entries are sorted and invalid/negative times are excluded. With no supplied array, native `TextTrack` entries of kind `chapters` are used. Your application must load any external chapter track (for example `<track kind="chapters">`, set to hidden) or map provider metadata to this array. Chapter navigation checks the available seek window. Queue items may carry their own `chapters`; an explicit `extras.chapters` value takes precedence. Generic HLS date ranges or DASH events are not automatically assumed to be chapters.

## Playback queue

```js
import { PlaybackQueue, mountControls } from './player.js';
const queue = new PlaybackQueue(
  () => player,
  [
    {
      id: 'episode-1',
      title: 'Episode 1',
      source: { protocol: 'hls', url: episode1Url },
      chapters: [{ title: 'Opening', start: 0 }],
    },
    {
      id: 'episode-2',
      title: 'Episode 2',
      source: { protocol: 'dash', url: episode2Url },
    },
  ],
  true,
); // true: advance on ended for VOD (default)
const controls = mountControls(screen, video, () => player, showError, {
  extras: { queue },
});
queue.addEventListener('error', (event) => logQueueError(event.detail));
startButton.onclick = () => queue.select(0).catch(showError);
// On removal: controls.destroy(); queue.destroy(); await player.destroy();
```

Queue methods: `select(index)`, `next()`, `previous()`, `reset()`, `destroy()`. State: `items`, `index` (-1 until selected), `loading`, `hasNext`, `hasPrevious`. `change` fires on transitions. Explicit load failures reject the operation; automatic-advance failures emit `error`. Controls display those errors through their report callback. Concurrent selections are rejected while loading. A reset/destroy during a load prevents queue-driven autoplay after that load finishes; cancellation of the engine load itself remains the player's responsibility. Call `reset()` when loading a source outside the queue. IDs must be unique. The same video element must be retained. No automatic queue persistence, authentication or URL refresh is assumed; integrate those in the application's player adapter. The demo supplies two public examples and leaves the queue inactive until selected.

## Native AirPlay / Remote Playback

Native discovery is enabled by default. The button appears after the browser reports a target, or while connected. It invokes WebKit's target picker where available, otherwise `video.remote.prompt()`. It respects `disableRemotePlayback` and embedding/browser policy. This is not screen mirroring and cannot make an MSE `blob:` or a MoQ transport receiver-compatible.

If your application maintains a separate, natively playable remote video element, pass `extras.remote.video` and own that element's source, credentials, synchronization and lifecycle. ThePlayer does not switch the active engine or remove ManagedMediaSource's required `disableRemotePlayback` flag to force AirPlay. Device/codec/source compatibility must be validated on the target platform.

## Google Cast

Cast is an optional sender adapter, not a new playback engine. Nothing downloads Google's SDK until the application explicitly requests it. The sender receives an HTTP(S) URL which the receiver fetches independently; local MSE buffers, private network access, cookies and license callbacks are not transferred.

```js
import { CastSender, loadCastSdk, mountControls } from './player.js';
let sender;
const controls = mountControls(screen, video, () => player, showError, {
  extras: { remote: { cast: () => sender } },
});
enableCastButton.onclick = async () => {
  await loadCastSdk();
  sender = new CastSender(video, {
    // Omit for Google's Default Media Receiver; supply your ID for a custom receiver.
    receiverApplicationId: myReceiverId,
    media: () => ({
      url: receiverAccessibleUrl,
      contentType: 'application/dash+xml', // HLS: application/x-mpegURL
      title: 'My programme',
      live: player.isLive,
      customData: receiverSpecificData,
    }),
  });
};
// Controls provide connect/disconnect and remote Play/Pause.
// On removal: controls.destroy(); sender?.destroy();
```

`CastSender.connect()` requests a session from a user gesture, loads media and pauses local playback only after successful receiver loading. VOD starts at the local current time; live requests use the receiver's live behavior. `togglePlay()` and `disconnect()` control the receiver. `supported`, `connected`, `paused` and `change` expose state. Ordinary seek/quality/audio controls continue to describe local playback; this is not complete remote-track/receiver UI synchronization. Local playback is not silently resumed on disconnect. `destroy()` removes sender listeners without ending a shared Cast session.

`receiverApplicationId`, media URLs and custom data come from the application. An authenticated/DRM stream normally requires a custom receiver and provider-specific license integration; `customData` is passed through, not interpreted by ThePlayer. The demo only offers unprotected HLS/DASH sources without application media headers. URLs must remain valid from the receiver's IP. The Cast context is page-global; applications with multiple senders should coordinate receiver configuration. Physical device and provider validation is required. SDK contract tests do not prove hardware compatibility.

References: [Google Cast sender integration](https://developers.google.com/cast/docs/web_sender/integrate), [Remote Playback prompt](https://developer.mozilla.org/en-US/docs/Web/API/RemotePlayback/prompt).

## Frame download and clipboard

`captureFrame(video)` returns a PNG `Blob`; `downloadFrame(video, filename?)` downloads it; `copyFrame(video)` writes a PNG to the clipboard. The settings group is enabled with `extras.frameCapture: true`. All operations require a decoded frame. Copy also requires Clipboard API support, HTTPS and permission/user activation.

DRM video with attached MediaKeys is rejected, and the UI also hides capture for sources configured with DRM. Cross-origin tainted media is rejected with a CORS explanation. Platform-protected content without observable MediaKeys may still block or blank captures. Capture includes the video frame only, not custom subtitles/HTML overlays. Exported helpers do not upload or store images remotely. Call copy/download directly from a user action and handle rejected promises.

## Verification and scope

`npm run test:controls:extras` runs real HLS/DASH queue playback, chapter seeking, playback-rate controls, PNG capture, caption reset and layout checks in Chromium and WebKit. It also runs simulated native-device/Cast SDK lifecycle tests and the DRM capture guard. Queue race/failure tests run in `npm test`. Real AirPlay/Chromecast hardware, third-party DRM receivers and provider-specific authentication remain integration acceptance tests, not claims established by browser mocks.
