import type { TtmlDocument, TtmlStyle, TtmlParagraph } from './ttml';
/** DOM text overlay; no markup, selectors or URLs from subtitle documents are executed. */
export class TtmlRenderer {
  readonly element = document.createElement('div');
  private documents: TtmlDocument[] = [];
  private observer: ResizeObserver;
  private frame = 0;
  private closed = false;
  private previous = '';
  private parent: HTMLElement;
  private position: string;
  private width = 0;
  private height = 0;
  constructor(
    private video: HTMLVideoElement,
    private present: (text: string) => void,
  ) {
    this.parent = video.parentElement!;
    this.position = this.parent.style.position;
    if (getComputedStyle(this.parent).position === 'static')
      this.parent.style.position = 'relative';
    this.element.className = 'theplayer-ttml';
    Object.assign(this.element.style, {
      position: 'absolute',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '2',
    });
    this.element.setAttribute('aria-hidden', 'true');
    this.parent.append(this.element);
    this.observer = new ResizeObserver(() => {
      this.measure();
      this.previous = '';
      this.render();
    });
    this.observer.observe(video);
    this.video.addEventListener('seeked', this.render);
    this.video.addEventListener('loadedmetadata', this.measure);
    this.measure();
    this.tick();
  }
  private measure = () => {
    const r = this.video.getBoundingClientRect(),
      parent = this.parent.getBoundingClientRect();
    const aspect =
      this.video.videoWidth && this.video.videoHeight
        ? this.video.videoWidth / this.video.videoHeight
        : r.width / r.height;
    this.width = Math.min(r.width, r.height * aspect);
    this.height = Math.min(r.height, r.width / aspect);
    Object.assign(this.element.style, {
      left: `${r.left - parent.left + this.parent.scrollLeft + (r.width - this.width) / 2}px`,
      top: `${r.top - parent.top + this.parent.scrollTop + (r.height - this.height) / 2}px`,
      width: `${this.width}px`,
      height: `${this.height}px`,
    });
  };
  add(doc: TtmlDocument) {
    this.documents.push(doc);
    this.documents = this.documents.filter((d) =>
      d.paragraphs.some((p) => p.end >= this.video.currentTime - 30),
    );
    this.previous = '';
    this.render();
  }
  private length(
    value: string,
    axis: 'x' | 'y',
    doc: TtmlDocument,
    relative?: number,
  ): string {
    const m = /^(-?\d+(?:\.\d+)?)(%|px|c|em)$/.exec(value);
    if (!m) return value === 'normal' ? 'normal' : '0px';
    const size = axis === 'x' ? this.width : this.height;
    const units = axis === 'x' ? doc.cells[0] : doc.cells[1];
    const reference = axis === 'x' ? doc.extent?.[0] : doc.extent?.[1];
    if (m[2] === 'em') return value;
    return `${+m[1] * (m[2] === '%' ? (relative ?? size) / 100 : m[2] === 'c' ? size / units : size / (reference ?? size))}px`;
  }
  private style(el: HTMLElement, style: TtmlStyle, doc: TtmlDocument) {
    const css = el.style;
    for (const [name, property] of Object.entries({
      color: 'color',
      backgroundColor: 'background-color',
      fontWeight: 'font-weight',
      fontStyle: 'font-style',
      textAlign: 'text-align',
      opacity: 'opacity',
      visibility: 'visibility',
      direction: 'direction',
    }))
      if (style[name]) css.setProperty(property, style[name]);
    if (style.display === 'none') css.display = 'none';
    if (style.fontFamily)
      css.fontFamily = style.fontFamily
        .replaceAll('proportionalSansSerif', 'sans-serif')
        .replaceAll('monospaceSansSerif', 'monospace')
        .replaceAll('proportionalSerif', 'serif')
        .replaceAll('monospaceSerif', 'monospace');
    if (style.fontSize) {
      const size = style.fontSize.split(/\s+/).at(-1)!;
      css.fontSize = size.endsWith('%') ? size : this.length(size, 'y', doc);
    }
    if (style.lineHeight)
      css.lineHeight = style.lineHeight.endsWith('%')
        ? String(parseFloat(style.lineHeight) / 100)
        : this.length(style.lineHeight, 'y', doc);
    if (style.textOutline && style.textOutline !== 'none') {
      const values = style.textOutline.trim().split(/\s+/);
      const thickness = values.findIndex((v) =>
        /^\d+(?:\.\d+)?(?:px|c|em|%)$/.test(v),
      );
      if (thickness >= 0) {
        const color = thickness
          ? values.slice(0, thickness).join(' ')
          : 'currentColor';
        const size = parseFloat(this.length(values[thickness], 'y', doc));
        const blur = values[thickness + 1]
          ? this.length(values[thickness + 1], 'y', doc)
          : '0px';
        if (Number.isFinite(size))
          css.textShadow = [
            [-1, -1],
            [0, -1],
            [1, -1],
            [-1, 0],
            [1, 0],
            [-1, 1],
            [0, 1],
            [1, 1],
          ]
            .map(([x, y]) => `${x * size}px ${y * size}px ${blur} ${color}`)
            .join(',');
      }
    }
    if (style.textDecoration)
      css.textDecoration =
        style.textDecoration
          .split(/\s+/)
          .filter((v) => ['underline', 'overline', 'lineThrough'].includes(v))
          .map((v) => (v === 'lineThrough' ? 'line-through' : v))
          .join(' ') || 'none';
    if (style.unicodeBidi)
      css.unicodeBidi =
        (
          {
            bidiOverride: 'bidi-override',
            embed: 'embed',
            isolate: 'isolate',
            isolateOverride: 'isolate-override',
            plaintext: 'plaintext',
          } as Record<string, string>
        )[style.unicodeBidi] ?? 'normal';
    if (style.writingMode)
      css.writingMode =
        (
          {
            tbrl: 'vertical-rl',
            tb: 'vertical-rl',
            tblr: 'vertical-lr',
            lrtb: 'horizontal-tb',
            lr: 'horizontal-tb',
            rltb: 'horizontal-tb',
            rl: 'horizontal-tb',
          } as Record<string, string>
        )[style.writingMode] ?? 'horizontal-tb';
    if (['rltb', 'rl'].includes(style.writingMode)) css.direction = 'rtl';
    css.whiteSpace = style.wrapOption === 'noWrap' ? 'pre' : 'pre-wrap';
  }
  private region(style: TtmlStyle, doc: TtmlDocument) {
    const box = document.createElement('div');
    const origin = (style.origin || '0% 0%').split(/\s+/),
      extent = (style.extent || '100% 100%').split(/\s+/);
    Object.assign(box.style, {
      position: 'absolute',
      left: this.length(origin[0], 'x', doc),
      top: this.length(origin[1], 'y', doc),
      width: this.length(extent[0], 'x', doc),
      height: this.length(extent[1], 'y', doc),
      display: 'flex',
      flexDirection: 'column',
      justifyContent:
        style.displayAlign === 'after'
          ? 'flex-end'
          : style.displayAlign === 'center'
            ? 'center'
            : 'flex-start',
      boxSizing: 'border-box',
      overflow: style.overflow === 'visible' ? 'visible' : 'hidden',
      color: 'white',
      fontFamily: 'sans-serif',
      fontSize: `${this.height / doc.cells[1]}px`,
      lineHeight: 'normal',
      textAlign: 'start',
    });
    if (style.padding)
      box.style.padding = style.padding
        .split(/\s+/)
        .map((v, i) =>
          this.length(
            v,
            i % 2 ? 'x' : 'y',
            doc,
            parseFloat(i % 2 ? box.style.width : box.style.height),
          ),
        )
        .join(' ');
    this.style(box, style, doc);
    return box;
  }
  private render = () => {
    if (this.closed) return;
    const time = this.video.currentTime;
    const active: {
      doc: TtmlDocument;
      p: TtmlParagraph;
      runs: TtmlParagraph['runs'];
    }[] = [];
    for (const doc of this.documents)
      for (const p of doc.paragraphs)
        if (p.start <= time && p.end > time) {
          const runs = p.runs.filter((r) => r.start <= time && r.end > time);
          if (runs.length) active.push({ doc, p, runs });
        }
    const signature = JSON.stringify(active);
    if (signature === this.previous) return;
    this.previous = signature;
    this.element.replaceChildren();
    const regions = new Map<string, HTMLElement>();
    let text = '';
    for (const { doc, p, runs } of active) {
      const key = this.documents.indexOf(doc) + ':' + p.region;
      let box = regions.get(key);
      if (!box) {
        box = this.region(doc.regions[p.region] ?? doc.regions[''], doc);
        regions.set(key, box);
        this.element.append(box);
      }
      const paragraph = document.createElement('div');
      this.style(paragraph, p.style, doc);
      for (const run of runs) {
        const span = document.createElement('span');
        this.style(span, run.style, doc);
        span.textContent = run.text;
        paragraph.append(span);
      }
      box.append(paragraph);
      text += (text ? '\n' : '') + runs.map((r) => r.text).join('');
    }
    this.present(text);
  };
  private tick = () => {
    if (this.closed) return;
    this.render();
    this.frame = this.video.requestVideoFrameCallback
      ? this.video.requestVideoFrameCallback(this.tick)
      : requestAnimationFrame(this.tick);
  };
  destroy() {
    this.closed = true;
    if (this.video.cancelVideoFrameCallback)
      this.video.cancelVideoFrameCallback(this.frame);
    else cancelAnimationFrame(this.frame);
    this.video.removeEventListener('seeked', this.render);
    this.video.removeEventListener('loadedmetadata', this.measure);
    this.observer.disconnect();
    this.element.remove();
    this.documents = [];
    if (
      !this.parent.querySelector('.theplayer-ttml') &&
      this.parent.style.position === 'relative'
    )
      this.parent.style.position = this.position;
  }
}
