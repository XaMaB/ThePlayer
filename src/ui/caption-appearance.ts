export interface CaptionAppearance {
  scale?: number;
  /** Vertical offset as a percentage of the video box; negative moves up. */
  offset?: number;
  color?: 'source' | 'white' | 'yellow' | 'cyan';
  background?: 'source' | 'transparent' | 'dark' | 'solid';
  font?: 'source' | 'sans-serif' | 'serif' | 'monospace';
  outline?: boolean;
}
const preferences = new WeakMap<HTMLVideoElement, CaptionAppearance>();
let sequence = 0;
export const captionAppearance = (video: HTMLVideoElement) =>
  preferences.get(video) ?? {};
export const captionBackground = (value?: string) =>
  ({ transparent: 'transparent', dark: 'rgba(0,0,0,.75)', solid: '#000' })[
    value ?? ''
  ] ?? undefined;
/** Appearance is scoped to one video; no preferences are persisted without the application. */
export class CaptionAppearanceController {
  private style: HTMLStyleElement;
  private id = `tp-captions-${++sequence}`;
  private observer: ResizeObserver;
  private abort = new AbortController();
  private originalLines = new Map<
    VTTCue,
    { line: VTTCue['line']; snap: boolean }
  >();
  constructor(
    private video: HTMLVideoElement,
    initial: CaptionAppearance = {},
  ) {
    this.style = video.ownerDocument.createElement('style');
    this.style.dataset.captionPreferences = '';
    video.setAttribute('data-caption-owner', this.id);
    video.parentElement!.setAttribute('data-caption-container', this.id);
    video.parentElement!.append(this.style);
    this.observer = new ResizeObserver(() => this.render());
    this.observer.observe(video);
    for (const event of [
      'timeupdate',
      'loadedmetadata',
      'theplayerdocumentchange',
    ])
      video.addEventListener(event, () => this.render(), {
        signal: this.abort.signal,
      });
    this.set(initial);
  }
  get value(): CaptionAppearance {
    return { ...captionAppearance(this.video) };
  }
  set(value: CaptionAppearance) {
    const next = { ...value };
    if (
      !Number.isFinite(next.scale ?? 1) ||
      (next.scale ?? 1) < 0.5 ||
      (next.scale ?? 1) > 2
    )
      throw new RangeError('Caption scale must be 0.5–2');
    if (!Number.isFinite(next.offset ?? 0) || Math.abs(next.offset ?? 0) > 40)
      throw new RangeError('Caption offset must be -40–40 percent');
    for (const [key, allowed] of Object.entries({
      color: ['source', 'white', 'yellow', 'cyan'],
      background: ['source', 'transparent', 'dark', 'solid'],
      font: ['source', 'sans-serif', 'serif', 'monospace'],
    }))
      if (
        next[key as keyof CaptionAppearance] !== undefined &&
        !allowed.includes(next[key as keyof CaptionAppearance] as string)
      )
        throw new Error(`Invalid caption ${key}`);
    preferences.set(this.video, next);
    this.render();
    this.video.dispatchEvent(new Event('theplayercaptionappearance'));
  }
  reset() {
    this.set({});
  }
  private render() {
    const p = this.value;
    const root = `[data-caption-container="${this.id}"]`;
    const layers = [
      '.theplayer-ttml',
      '.theplayer-cea708',
      '.theplayer-cea608',
      'canvas[data-caption-layer]',
    ];
    const text = `${root} .theplayer-ttml *,${root} .theplayer-cea708 *,${root} .theplayer-cea608 *`;
    const declarations = [
      p.color && p.color !== 'source' ? `color:${p.color}!important;` : '',
      p.font && p.font !== 'source' ? `font-family:${p.font}!important;` : '',
      p.background && p.background !== 'source'
        ? `background-color:${captionBackground(p.background)}!important;`
        : '',
      p.outline
        ? 'text-shadow:-1px -1px 1px #000,1px 1px 1px #000,-1px 1px 1px #000,1px -1px 1px #000!important;'
        : '',
    ].join('');
    const transforms =
      (p.scale ?? 1) !== 1 || (p.offset ?? 0) !== 0
        ? `${layers.map((layer) => root + ' ' + layer).join(',')}{transform:translateY(${p.offset ?? 0}%) scale(${p.scale ?? 1});transform-origin:50% 90%;}`
        : '';
    const size =
      p.scale && p.scale !== 1
        ? `font-size:${Math.max(10, this.video.clientHeight * 0.05 * p.scale)}px;`
        : '';
    this.style.textContent = `${transforms}\n${text}{${declarations}}\nvideo[data-caption-owner="${this.id}"]::cue{${declarations}${size}}`;
    // Native text tracks cannot be translated with CSS. Preserve authored lines on reset.
    const current = new Set<VTTCue>();
    for (const track of Array.from(this.video.textTracks)) {
      if (!['subtitles', 'captions'].includes(track.kind)) continue;
      for (const raw of Array.from(track.activeCues ?? [])) {
        const cue = raw as VTTCue;
        if (!('line' in cue)) continue;
        current.add(cue);
        if (p.offset) {
          if (!this.originalLines.has(cue))
            this.originalLines.set(cue, {
              line: cue.line,
              snap: cue.snapToLines,
            });
          const original = this.originalLines.get(cue)!;
          const base =
            !original.snap && typeof original.line === 'number'
              ? original.line
              : 90;
          cue.snapToLines = false;
          cue.line = Math.max(0, Math.min(100, base + p.offset));
        }
      }
    }
    for (const [cue, original] of this.originalLines)
      if (!p.offset || !current.has(cue)) {
        cue.line = original.line;
        cue.snapToLines = original.snap;
        this.originalLines.delete(cue);
      }
  }
  destroy() {
    this.reset();
    this.abort.abort();
    this.observer.disconnect();
    this.style.remove();
    this.video.removeAttribute('data-caption-owner');
    this.video.parentElement?.removeAttribute('data-caption-container');
    preferences.delete(this.video);
  }
}
