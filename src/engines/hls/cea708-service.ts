import {
  commandLength708,
  graphic708,
  type P16Encoding,
} from './cea708-packets';

export interface Pen708 {
  size: number;
  font: number;
  offset: number;
  italic: boolean;
  underline: boolean;
  edge: number;
  foreground: number;
  background: number;
  edgeColor: number;
}
export interface Cell708 {
  text: string;
  pen: Pen708;
}
export interface Window708 {
  id: number;
  visible: boolean;
  priority: number;
  relative: boolean;
  vertical: number;
  horizontal: number;
  anchor: number;
  rows: number;
  columns: number;
  rowLock: boolean;
  columnLock: boolean;
  row: number;
  column: number;
  justify: number;
  print: number;
  scroll: number;
  wrap: boolean;
  fill: number;
  border: number;
  borderColor: number;
  effect: number;
  effectDirection: number;
  effectSpeed: number;
  pen: Pen708;
  cells: (Cell708 | null)[][];
  definition: number[];
}
export interface Screen708 {
  time: number;
  service: number;
  windows: Window708[];
  checkpoint?: boolean;
}
const penStyle = (id: number): Pen708 => ({
  size: 1,
  font: [0, 0, 1, 2, 3, 4, 3, 4][id] ?? 0,
  offset: 1,
  italic: false,
  underline: false,
  edge: id >= 6 ? 3 : 0,
  foreground: 0x2a,
  background: id >= 6 ? 0xc0 : 0,
  edgeColor: 0,
});
const blank = (columns: number): (Cell708 | null)[] =>
  Array(columns).fill(null);
const clear = (window: Window708) => {
  window.cells = Array.from({ length: window.rows }, () =>
    blank(window.columns),
  );
};
const windowStyle = (window: Window708, id: number) => {
  window.justify = id === 3 || id === 6 ? 2 : 0;
  window.print = id === 7 ? 2 : 0;
  window.scroll = id === 7 ? 1 : 3;
  window.wrap = id >= 4 && id <= 6;
  window.fill = id === 2 || id === 5 ? 0xc0 : 0;
  window.border = 0;
  window.borderColor = 0;
  window.effect = 0;
  window.effectDirection = 0;
  window.effectSpeed = 0;
};

/** Original service interpreter. All timestamps use the media clock, including delays. */
export class Cea708Service {
  windows = new Map<number, Window708>();
  current = -1;
  private partial: number[] = [];
  private queued: number[][] = [];
  private queuedBytes = 0;
  private until = 0;
  errors = 0;
  constructor(
    readonly service: number,
    readonly encoding: P16Encoding = 'unicode',
  ) {}

  clone() {
    const copy = new Cea708Service(this.service, this.encoding);
    copy.windows = structuredClone(this.windows);
    copy.current = this.current;
    copy.partial = [...this.partial];
    copy.queued = this.queued.map((c) => [...c]);
    copy.queuedBytes = this.queuedBytes;
    copy.until = this.until;
    copy.errors = this.errors;
    return copy;
  }
  reset() {
    this.windows.clear();
    this.current = -1;
    this.partial = [];
    this.queued = [];
    this.queuedBytes = 0;
    this.until = 0;
  }
  screen(time: number): Screen708 {
    return {
      time,
      service: this.service,
      windows: structuredClone(
        [...this.windows.values()].filter((w) => w.visible),
      ),
    };
  }
  advance(time: number): Screen708[] {
    const events: Screen708[] = [];
    while (this.until && this.until <= time) {
      const at = this.until;
      this.until = 0;
      this.flush(at);
      events.push(this.screen(at));
    }
    return events;
  }
  push(data: Uint8Array, time: number): Screen708[] {
    const events = this.advance(time);
    this.partial.push(...data);
    let at = 0;
    while (at < this.partial.length) {
      const length = commandLength708(this.partial, at);
      if (!length) break;
      const command = this.partial.slice(at, at + length);
      at += length;
      if (command[0] === 0x8f) {
        // Reset must bypass the delayed input buffer without discarding later commands.
        this.windows.clear();
        this.current = -1;
        this.queued = [];
        this.queuedBytes = 0;
        this.until = 0;
      } else if (command[0] === 0x8e) {
        this.until = 0;
        this.flush(time);
      } else if (this.until) {
        this.queued.push(command);
        this.queuedBytes += length;
        if (this.queuedBytes >= 128) {
          this.until = 0;
          this.flush(time);
        }
      } else this.execute(command, time);
    }
    this.partial = this.partial.slice(at);
    events.push(this.screen(time));
    return events;
  }
  private flush(time: number) {
    while (this.queued.length && !this.until) {
      const command = this.queued.shift()!;
      this.queuedBytes -= command.length;
      this.execute(command, time);
    }
  }
  private define(id: number, p: number[]) {
    const previous = this.windows.get(id);
    if (previous?.definition.every((v, i) => v === p[i])) {
      this.current = id;
      return;
    }
    if (p[3] >>> 4 > 8 || (p[3] & 15) >= 15 || (p[4] & 63) >= 42) {
      this.errors++;
      return;
    }
    const rows = (p[3] & 15) + 1,
      columns = (p[4] & 63) + 1;
    const window = previous ?? {
      id,
      row: 0,
      column: 0,
      pen: penStyle(1),
      cells: [],
      visible: false,
      priority: 0,
      relative: false,
      vertical: 0,
      horizontal: 0,
      anchor: 0,
      rows,
      columns,
      rowLock: true,
      columnLock: true,
      justify: 0,
      print: 0,
      scroll: 3,
      wrap: false,
      fill: 0,
      border: 0,
      borderColor: 0,
      effect: 0,
      effectDirection: 0,
      effectSpeed: 0,
      definition: [],
    };
    Object.assign(window, {
      visible: !!(p[0] & 32),
      priority: p[0] & 7,
      rowLock: !!(p[0] & 16),
      columnLock: !!(p[0] & 8),
      relative: !!(p[1] & 128),
      vertical: p[1] & 127,
      horizontal: p[2],
      anchor: p[3] >>> 4,
      rows,
      columns,
      definition: [...p],
    });
    if (!previous || (p[5] >>> 3) & 7)
      windowStyle(window, (p[5] >>> 3) & 7 || 1);
    if (!previous || p[5] & 7) window.pen = penStyle(p[5] & 7 || 1);
    window.cells = Array.from({ length: rows }, (_, row) =>
      Array.from(
        { length: columns },
        (_, col) => window.cells[row]?.[col] ?? null,
      ),
    );
    window.row = Math.min(window.row, rows - 1);
    window.column = Math.min(window.column, columns - 1);
    this.windows.set(id, window);
    this.current = id;
  }
  private step(window: Window708, reverse = false) {
    const delta = reverse ? -1 : 1;
    if (window.print < 2) window.column += window.print === 0 ? delta : -delta;
    else window.row += window.print === 2 ? delta : -delta;
  }
  private carriage(window: Window708) {
    const horizontal = window.print < 2;
    if (horizontal) {
      window.column = window.print === 0 ? 0 : window.columns - 1;
      window.row += window.scroll === 2 ? -1 : 1;
      if (window.row < 0) {
        window.cells.pop();
        window.cells.unshift(blank(window.columns));
        window.row = 0;
      }
      if (window.row >= window.rows) {
        window.cells.shift();
        window.cells.push(blank(window.columns));
        window.row = window.rows - 1;
      }
    } else {
      window.row = window.print === 2 ? 0 : window.rows - 1;
      window.column += window.scroll === 0 ? -1 : 1;
      if (window.column < 0) {
        for (const row of window.cells) {
          row.pop();
          row.unshift(null);
        }
        window.column = 0;
      }
      if (window.column >= window.columns) {
        for (const row of window.cells) {
          row.shift();
          row.push(null);
        }
        window.column = window.columns - 1;
      }
    }
  }
  private write(window: Window708, text: string) {
    if (
      window.row < 0 ||
      window.row >= window.rows ||
      window.column < 0 ||
      window.column >= window.columns
    ) {
      if (!window.wrap) return;
      // Preserve a whole trailing word when wrapping a left-to-right row.
      const row =
        window.cells[Math.min(window.rows - 1, Math.max(0, window.row))];
      const space =
        window.print === 0
          ? row.findLastIndex((cell) => cell?.text === ' ')
          : -1;
      const carried =
        space >= 0 && space < row.length - 1 ? row.splice(space + 1) : [];
      while (row.length < window.columns) row.push(null);
      if (space >= 0) row[space] = null;
      this.carriage(window);
      for (const cell of carried) {
        if (window.column >= window.columns) break;
        window.cells[window.row][window.column++] = cell;
      }
      if (text === ' ' && window.column === 0) return;
    }
    window.cells[window.row][window.column] = { text, pen: { ...window.pen } };
    this.step(window);
  }
  private execute(c: number[], time: number) {
    const code = c[0];
    if (code >= 0x98 && code <= 0x9f) {
      this.define(code - 0x98, c.slice(1));
      return;
    }
    if (code >= 0x80 && code <= 0x87) {
      this.current = code - 0x80;
      return;
    }
    if (code === 0x8d) {
      this.until = c[1] ? time + c[1] / 10 : 0;
      return;
    }
    if (code >= 0x88 && code <= 0x8c) {
      for (const [id, window] of this.windows)
        if (c[1] & (1 << id)) {
          if (code === 0x88) clear(window);
          if (code === 0x89) window.visible = true;
          if (code === 0x8a) window.visible = false;
          if (code === 0x8b) window.visible = !window.visible;
          if (code === 0x8c) {
            this.windows.delete(id);
            if (this.current === id) this.current = -1;
          }
        }
      return;
    }
    const w = this.windows.get(this.current);
    if (!w) return;
    const text = graphic708(c, this.encoding);
    if (text !== undefined) {
      this.write(w, text);
      return;
    }
    if (code === 8) {
      this.step(w, true);
      w.row = Math.max(0, Math.min(w.rows - 1, w.row));
      w.column = Math.max(0, Math.min(w.columns - 1, w.column));
      w.cells[w.row][w.column] = null;
    }
    if (code === 12) {
      clear(w);
      w.row = w.column = 0;
    }
    if (code === 13) this.carriage(w);
    if (code === 14) {
      w.cells[Math.min(w.row, w.rows - 1)] = blank(w.columns);
      w.column = 0;
    }
    if (code === 0x90)
      Object.assign(w.pen, {
        size: c[1] & 3,
        offset: (c[1] >>> 2) & 3,
        font: c[2] & 7,
        edge: (c[2] >>> 3) & 7,
        underline: !!(c[2] & 64),
        italic: !!(c[2] & 128),
      });
    if (code === 0x91)
      Object.assign(w.pen, {
        foreground: c[1],
        background: c[2],
        edgeColor: c[3] & 63,
      });
    if (code === 0x92) {
      w.row = Math.min(w.rows - 1, c[1] & 15);
      w.column = Math.min(w.columns - 1, c[2] & 63);
    }
    if (code === 0x97) {
      if (w.justify !== (c[3] & 3)) clear(w);
      Object.assign(w, {
        fill: c[1],
        border: (c[2] >>> 6) | ((c[3] >>> 7) << 2),
        borderColor: c[2] & 63,
        wrap: !!(c[3] & 64),
        print: (c[3] >>> 4) & 3,
        scroll: (c[3] >>> 2) & 3,
        justify: c[3] & 3,
        effect: c[4] & 3,
        effectDirection: (c[4] >>> 2) & 3,
        effectSpeed: c[4] >>> 4,
      });
    }
  }
}
