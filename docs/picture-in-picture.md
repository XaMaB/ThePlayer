# Picture-in-Picture

ThePlayer shares one PiP controller across MoQ, HLS and DASH. It moves the existing video rather than starting a second stream. The visible button is feature-detected and disabled until a video track is ready; audio-only playback does not open PiP.

```js
import { mountControls } from './player.js';

const controls = mountControls(screen, video, () => player, reportError, {
  pictureInPicture: {
    mode: 'auto',
    automatic: true,
    width: 560,
    height: 315,
  },
});
```

| Option             | Default      | Behavior                                                                                                                                                           |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pictureInPicture` | `{}`         | Use `false` to omit the feature entirely.                                                                                                                          |
| `mode`             | `'auto'`     | Prefer Document PiP, then standard video PiP, then WebKit presentation mode. `'video'` forces native video PiP; `'document'` requires Document PiP.                |
| `automatic`        | `false`      | Opt into the browser-driven Media Session `enterpictureinpicture` action. The demo enables it where the action is supported and provides a checkbox to disable it. |
| `width`, `height`  | `560`, `315` | Initial Document PiP dimensions; the browser determines final size and placement.                                                                                  |

The returned `controls.pictureInPicture` exposes `toggle()`, `enter()`, `exit()`, `setAutomatic(boolean)`, `supported`, `active`, `kind` (`document`, `video`, `none`) and `automaticEnabled`. Opening must normally run directly inside a user gesture. `setAutomatic(true)` returns whether the Media Session action was registered, not a guarantee of automatic activation. `controls.destroy()` closes PiP, restores the screen and removes listeners. A standalone `PictureInPictureController(screen, video, options, onChange)` is also exported; its owner must call `destroy()`.

## Adaptive behavior

Document PiP moves the entire `screen` element, preserving controls, canvas captions and DOM subtitle overlays. Stylesheet links, inline styles and adopted stylesheet rules are copied when opening. The opener displays a placeholder; closing, stopping playback or disposing controls returns the screen to its original location. Keyboard and pointer listeners follow the screen, and caption rendering schedules frames in the owning window. Keep the video, captions and controls inside `screen`. Application CSS relying on ancestors outside that element may need PiP-specific styles. Application code should keep element references rather than querying the opener document for moved controls.

Native video PiP uses browser-owned controls. Custom HTML/canvas overlays (including DVB/Teletext and rendered TTML/CEA-708 layers) cannot be carried into this window; native text-track display depends on the browser. The controller does not burn captions into video or copy DRM frames to a canvas. Safari's WebKit presentation API is used when the standard video API is unavailable. If no callable PiP API exists, the button is hidden; browser-owned PiP UI may still be available.

Permission denials do not trigger a second API prompt. In `auto` mode an explicit `NotSupportedError` from Document PiP can fall back to native video PiP. Embedding restrictions, `disablePictureInPicture`, browser policy and device capabilities are respected. Document PiP and Auto PiP are requested only from the top-level window. Native PiP in an iframe may require `allow="picture-in-picture"` and a compatible parent Permissions Policy.

## Automatic entry

The browser invokes the Media Session action when eligible. ThePlayer does **not** try to open a window on every `visibilitychange`. Chrome's eligibility includes a playing, recently audible video, audio focus, site permission/engagement and the top-level browsing context. Muted autoplay alone may therefore not trigger Auto PiP. Returning to the visible tab closes an automatically opened window; manually opened PiP remains open.

One Media Session action belongs to the entire page. Multiple ThePlayer controllers share it, selecting the most recently playing eligible video. Removing one controller leaves other registrations intact. Enabling Auto PiP owns the `enterpictureinpicture` action while controllers are registered; applications managing that action themselves should leave `automatic` disabled and invoke the controller in their own handler. Other Media Session actions are not overwritten.

Automatic activation is browser-controlled and not universally supported. Feature detection replaces browser-name/version checks. Physical Safari/iPhone testing is still required for device-specific native PiP behavior; mocked WebKit API tests do not establish physical-device support.

## Verification

- `npm run test:pip:fallback`: simulated standard and WebKit APIs, unsupported browsers, permission denial, fallback, shared Media Session ownership, and teardown during a pending request, in Chromium and WebKit.
- `xvfb-run -a npm run test:pip`: real Chromium Document/native video PiP with HLS/DASH decoded playback, keyboard controls, canvas captions with the opener hidden-state branch forced (Chromium may keep it logically visible during PiP), window-close restoration and teardown. Requires prepared HLS/DASH fixtures and a display (Xvfb in Linux CI).
- Native Auto PiP eligibility/permission prompts are controlled by the browser; deterministic action-handler tests do not simulate a user's media-engagement history.

References: [Document PiP](https://developer.chrome.com/docs/web-platform/document-picture-in-picture), [automatic media PiP](https://developer.chrome.com/blog/automatic-picture-in-picture-media-playback), [standard video PiP](https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API).
