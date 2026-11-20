import { captionAppearance } from '../ui/caption-appearance';
import { draw708 } from './cea708/render.mjs';
import { activeCue, trimCues, SubtitleCounters } from './cues.mjs';

/** Transport-independent canvas subtitles synchronized to the video media clock. */
export class SubtitleRenderer {
  readonly counters = new SubtitleCounters();
  private detach = () => {};
  constructor(
    readonly video: HTMLVideoElement,
    readonly canvas: HTMLCanvasElement,
    readonly onChange: () => void = () => {},
    readonly isVisible: () => boolean = () => true,
  ) {
    canvas.setAttribute('data-caption-layer', '');
  }
  attach(player: EventTarget) {
    this.detach();
    const { video, canvas, onChange: updateSubtitleCounters, isVisible } = this;
    const context = canvas.getContext('2d')!;
    const subtitleCounters = this.counters;
    let cues: any[] = [],
      drawn: any = null,
      animation = 0,
      generation = 0;
    const abort = new AbortController();
    const clear = () => {
      generation++;
      cues = [];
      drawn = null;
      context.clearRect(0, 0, canvas.width, canvas.height);
      subtitleCounters.present(null, false);
      updateSubtitleCounters();
    };
    player.addEventListener('subtitlechange', clear, { signal: abort.signal });
    player.addEventListener(
      'caption',
      (event: Event) => {
        const { cue, replaceFrom } = (event as CustomEvent).detail;
        if (Number.isFinite(replaceFrom)) {
          cues = cues.filter((previous) => previous.pts < replaceFrom);
          drawn = null;
        }
        const token = generation;
        subtitleCounters.receive();
        updateSubtitleCounters();
        void (async () => {
          if (typeof cue.text !== 'string')
            cue.images = await Promise.all(
              cue.rects.map(async (rect: any) => {
                const image = new Image();
                image.src = 'data:image/png;base64,' + rect.png;
                await image.decode();
                return image;
              }),
            );
          if (token !== generation || abort.signal.aborted) return;
          cues.push(cue);
          cues.sort((a, b) => a.pts - b.pts);
          cues = trimCues(cues, video.currentTime).slice(-200);
        })().catch((error) => {
          if (!abort.signal.aborted)
            player.dispatchEvent(
              new CustomEvent('captionwarning', { detail: error }),
            );
        });
      },
      { signal: abort.signal },
    );
    let frameWindow = video.ownerDocument.defaultView!;
    const schedule = () => {
      frameWindow = video.ownerDocument.defaultView!;
      animation = frameWindow.requestAnimationFrame(renderSubtitles);
    };
    video.addEventListener(
      'theplayerdocumentchange',
      () => {
        frameWindow.cancelAnimationFrame(animation);
        drawn = null;
        schedule();
      },
      { signal: abort.signal },
    );
    video.addEventListener(
      'theplayercaptionappearance',
      () => {
        drawn = null;
      },
      { signal: abort.signal },
    );
    function renderSubtitles() {
      if (video.ownerDocument.hidden || !isVisible() || video.readyState < 2) {
        schedule();
        return;
      }
      const cue = activeCue(cues, video.currentTime);
      // Match the image rectangle of object-fit:contain, including fullscreen letterboxing.
      const w = video.videoWidth || 1920,
        h = video.videoHeight || 1080;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawn = null;
      }
      const box = video.getBoundingClientRect();
      const scale = Math.min(box.width / w, box.height / h);
      canvas.style.width = `${w * scale}px`;
      canvas.style.height = `${h * scale}px`;
      canvas.style.left = `${(box.width - w * scale) / 2}px`;
      canvas.style.top = `${(box.height - h * scale) / 2}px`;
      if (cue !== drawn) {
        context.clearRect(0, 0, w, h);
        drawn = cue;
        if (cue && typeof cue.text === 'string') {
          subtitleCounters.present(
            cue,
            draw708(context, cue, w, h, captionAppearance(video)),
          );
        } else if (cue) {
          cue.rects.forEach((r: any, i: number) =>
            context.drawImage(
              cue.images[i],
              (r.x * w) / cue.width,
              (r.y * h) / cue.height,
              (r.w * w) / cue.width,
              (r.h * h) / cue.height,
            ),
          );
          const visible = cue.rects.some((r: any) => {
            const x = Math.max(0, Math.floor((r.x * w) / cue.width)),
              y = Math.max(0, Math.floor((r.y * h) / cue.height));
            const rw = Math.min(
                w - x,
                Math.ceil(((r.x + r.w) * w) / cue.width) - x,
              ),
              rh = Math.min(
                h - y,
                Math.ceil(((r.y + r.h) * h) / cue.height) - y,
              );
            if (rw <= 0 || rh <= 0) return false;
            const pixels = context.getImageData(x, y, rw, rh).data;
            for (let i = 3; i < pixels.length; i += 4)
              if (pixels[i]) return true;
            return false;
          });
          subtitleCounters.present(cue, visible);
        } else subtitleCounters.present(null, false);
        updateSubtitleCounters();
      }
      schedule();
    }

    schedule();
    this.detach = () => {
      abort.abort();
      frameWindow.cancelAnimationFrame(animation);
      clear();
    };
  }
  destroy() {
    this.detach();
    this.detach = () => {};
  }
}
