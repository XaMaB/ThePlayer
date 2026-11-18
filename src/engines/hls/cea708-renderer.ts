import { columns708, visibility708, wipe708 } from './cea708-layout';
import type { Screen708, Window708, Pen708 } from './cea708-service';
/** Broadcast window coordinates and cell positions are independent of native cue layout. */
export class Cea708Renderer {
  readonly element = document.createElement('div');
  private parent: HTMLElement;
  private previousPosition: string;
  private observer: ResizeObserver;
  private frame = 0;
  private closed = false;
  private signature = '';
  private width = 0;
  private height = 0;
  private events: Screen708[] = [];
  constructor(
    private video: HTMLVideoElement,
    private present: (text: string) => void,
    private options: { columns?: number; className?: string } = {},
  ) {
    this.parent = video.parentElement!;
    this.previousPosition = this.parent.style.position;
    if (getComputedStyle(this.parent).position === 'static')
      this.parent.style.position = 'relative';
    this.element.className = options.className ?? 'theplayer-cea708';
    this.element.setAttribute('aria-hidden', 'true');
    Object.assign(this.element.style, {
      position: 'absolute',
      pointerEvents: 'none',
      overflow: 'hidden',
      zIndex: '2',
    });
    this.parent.append(this.element);
    this.observer = new ResizeObserver(this.measure);
    this.observer.observe(video);
    video.addEventListener('loadedmetadata', this.measure);
    video.addEventListener('seeked', this.render);
    this.measure();
    this.tick();
  }
  set(events: Screen708[]) {
    this.events = events;
    this.signature = '';
    this.render();
  }
  private measure = () => {
    const video = this.video.getBoundingClientRect(),
      parent = this.parent.getBoundingClientRect();
    const aspect =
      this.video.videoWidth / this.video.videoHeight ||
      video.width / video.height;
    this.width = Math.min(video.width, video.height * aspect);
    this.height = Math.min(video.height, video.width / aspect);
    Object.assign(this.element.style, {
      left: `${video.left - parent.left + this.parent.scrollLeft + (video.width - this.width) / 2}px`,
      top: `${video.top - parent.top + this.parent.scrollTop + (video.height - this.height) / 2}px`,
      width: `${this.width}px`,
      height: `${this.height}px`,
    });
    this.signature = '';
    this.render();
  };
  private color(value: number) {
    const levels = [0, 85, 170, 255],
      opacity = value >>> 6;
    const alpha =
      opacity === 3
        ? 0
        : opacity === 2
          ? 0.5
          : opacity === 1 && Math.floor(this.video.currentTime * 2) % 2
            ? 0
            : 1;
    return `rgba(${levels[(value >>> 4) & 3]},${levels[(value >>> 2) & 3]},${levels[value & 3]},${alpha})`;
  }
  private pen(element: HTMLElement, pen: Pen708, cellHeight: number) {
    const fonts = [
      'monospace',
      'monospace',
      'serif',
      'monospace',
      'sans-serif',
      'sans-serif',
      'cursive',
      'serif',
    ];
    const scale = pen.size === 0 ? 0.75 : pen.size === 2 ? 1.25 : 1;
    Object.assign(element.style, {
      color: this.color(pen.foreground),
      backgroundColor: this.color(pen.background),
      fontFamily: fonts[pen.font],
      fontSize: `${cellHeight * 0.85 * scale}px`,
      fontStyle: pen.italic ? 'italic' : 'normal',
      textDecoration: pen.underline ? 'underline' : 'none',
      fontVariant: pen.font === 7 ? 'small-caps' : 'normal',
      whiteSpace: 'pre',
    });
    if (pen.offset !== 1)
      element.style.transform = `translateY(${pen.offset === 0 ? 20 : -20}%)`;
    const edge = this.color(pen.edgeColor);
    if (pen.edge === 3)
      element.style.textShadow = `-1px 0 ${edge},1px 0 ${edge},0 -1px ${edge},0 1px ${edge}`;
    else if (pen.edge)
      element.style.textShadow = `${pen.edge === 4 ? -1 : 1}px ${pen.edge === 1 ? -1 : 1}px 1px ${edge}`;
  }
  private window(window: Window708) {
    const element = document.createElement('div');
    element.dataset.window = String(window.id);
    const aspect = this.width / this.height,
      columns = this.options.columns ?? (aspect > 1.5 ? 42 : 32);
    const cellWidth = (this.width * 0.8) / columns,
      cellHeight = (this.height * 0.8) / 15;
    const width = window.columns * cellWidth,
      height = window.rows * cellHeight;
    const x =
        window.horizontal / (window.relative ? 99 : aspect > 1.5 ? 209 : 159),
      y = window.vertical / (window.relative ? 99 : 74);
    const left =
      this.width * (0.1 + 0.8 * x) - ((window.anchor % 3) * width) / 2;
    const top =
      this.height * (0.1 + 0.8 * y) -
      (Math.floor(window.anchor / 3) * height) / 2;
    Object.assign(element.style, {
      position: 'absolute',
      left: `${Math.max(0, Math.min(this.width - width, left))}px`,
      top: `${Math.max(0, Math.min(this.height - height, top))}px`,
      width: `${width}px`,
      height: `${height}px`,
      backgroundColor: this.color(window.fill),
      overflow: 'hidden',
      zIndex: String(8 - window.priority),
    });
    const amount = visibility708(window, this.video.currentTime);
    if (window.visibility?.effect === 1) element.style.opacity = String(amount);
    element.style.clipPath = wipe708(window, amount);
    if (window.border)
      element.style.border = `1px ${window.border === 1 ? 'inset' : window.border === 2 ? 'outset' : 'solid'} ${this.color(window.borderColor)}`;
    for (const [rowIndex, row] of window.cells.entries()) {
      const last = row.findLastIndex((cell) => cell !== null);
      if (last < 0) continue;
      const positions = columns708(row, window.columns, window.justify);
      for (let column = 0; column <= last; column++) {
        const cell = row[column];
        if (!cell) continue;
        const span = document.createElement('span');
        span.textContent = cell.text;
        Object.assign(span.style, {
          position: 'absolute',
          left: `${positions[column] * cellWidth}px`,
          top: `${rowIndex * cellHeight}px`,
          width: `${cellWidth}px`,
          height: `${cellHeight}px`,
          lineHeight: `${cellHeight}px`,
          textAlign: 'center',
        });
        this.pen(span, cell.pen, cellHeight);
        element.append(span);
      }
    }
    return element;
  }
  private render = () => {
    if (this.closed) return;
    const event = this.events.findLast(
      (e) => e.time <= this.video.currentTime + 0.001,
    );
    const windows = (event?.windows ?? []).filter(
      (w) => visibility708(w, this.video.currentTime) > 0,
    );
    const animating = windows.some(
      (w) =>
        w.visibility &&
        this.video.currentTime < w.visibility.start + w.visibility.duration,
    );
    const signature = JSON.stringify([
      windows,
      animating ? Math.floor(this.video.currentTime * 60) : 0,
      Math.floor(this.video.currentTime * 2) % 2,
      this.width,
      this.height,
    ]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.element.replaceChildren(
      ...windows.map((window) => this.window(window)),
    );
    const text = windows
      .map((w) =>
        w.cells
          .map((row) =>
            row
              .map((c) => c?.text ?? ' ')
              .join('')
              .trimEnd(),
          )
          .join('\n')
          .trimEnd(),
      )
      .filter(Boolean)
      .join('\n');
    this.present(text);
  };
  private tick = () => {
    if (this.closed) return;
    this.render();
    this.frame = requestAnimationFrame(this.tick);
  };
  destroy() {
    this.closed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.video.removeEventListener('loadedmetadata', this.measure);
    this.video.removeEventListener('seeked', this.render);
    this.element.remove();
    this.parent.style.position = this.previousPosition;
  }
}
