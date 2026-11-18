/** Original CTA-608 field decoder. Text/XDS services are not captions. */
export interface Cell608 {
  char: string;
  color: string;
  background: number;
  italic: boolean;
  underline: boolean;
}
export interface Row608 {
  row: number;
  column: number;
  cells: (Cell608 | null)[];
}
export interface Screen608 {
  checkpoint?: boolean;
  time: number;
  service: number;
  rows: Row608[];
}
const blank = (): (Cell608 | null)[][] =>
  Array.from({ length: 15 }, () => Array(32).fill(null));
const colors = [
  'white',
  'lime',
  'blue',
  'cyan',
  'red',
  'yellow',
  'magenta',
  'white',
];
const basic: Record<number, string> = {
  42: 'á',
  92: 'é',
  94: 'í',
  95: 'ó',
  96: 'ú',
  123: 'ç',
  124: '÷',
  125: 'Ñ',
  126: 'ñ',
  127: '█',
};
const special = Array.from('®°½¿™¢£♪à\u00a0èâêîôû');
const extended = [
  Array.from("ÁÉÓÚÜü‘¡*'—©℠•“”ÀÂÇÈÊËëÎÏïÔÙùÛ«»"),
  Array.from('ÃãÍÌìÒòÕõ{}\\^_|~ÄäÖöß¥¤│ÅåØø┌┐└┘'),
];
const oddParity = (v: number) => {
  let bits = 0;
  for (let n = v; n; n >>>= 1) bits ^= n & 1;
  return bits === 1;
};
class Channel {
  front = blank();
  back = blank();
  mode: 'pop' | 'paint' | 'roll' | 'text' = 'pop';
  row = 14;
  column = 0;
  roll = 2;
  color = 'white';
  background = 14;
  italic = false;
  underline = false;
  get memory() {
    return this.mode === 'pop' ? this.back : this.front;
  }
  put(char: string) {
    if (this.mode === 'text') return;
    this.memory[this.row][this.column] = {
      char,
      color: this.color,
      background: this.background,
      italic: this.italic,
      underline: this.underline,
    };
    this.column = Math.min(31, this.column + 1);
  }
  backspace() {
    this.column = Math.max(0, this.column - 1);
    this.memory[this.row][this.column] = null;
  }
  style(value: number) {
    const index = (value >>> 1) & 7;
    this.color = colors[index];
    this.italic = index === 7;
    this.underline = !!(value & 1);
  }
  moveBase(row: number) {
    const next = blank();
    for (let i = 0; i < this.roll; i++)
      if (this.row - i >= 0 && row - i >= 0)
        next[row - i] = this.front[this.row - i];
    this.front = next;
    this.row = row;
  }
  command(a: number, b: number) {
    if (
      this.mode === 'text' &&
      !(
        a === 0x14 &&
        [0x20, 0x25, 0x26, 0x27, 0x29, 0x2c, 0x2e, 0x2f].includes(b)
      )
    )
      return;
    if (b >= 0x40 && b <= 0x7f) {
      const base = [10, 0, 2, 11, 13, 4, 6, 8][a & 7];
      if (a === 0x10 && b & 32) return;
      const row = base + ((b >>> 5) & 1);
      if (this.mode === 'roll') this.moveBase(Math.max(this.roll - 1, row));
      else this.row = row;
      this.column = b & 16 ? ((b >>> 1) & 7) * 4 : 0;
      this.background = 14;
      if (b & 16) {
        this.color = 'white';
        this.italic = false;
        this.underline = !!(b & 1);
      } else this.style(b);
    } else if (a === 0x11 && b >= 0x30 && b <= 0x3f)
      this.put(special[b - 0x30]);
    else if ((a === 0x12 || a === 0x13) && b >= 0x20 && b <= 0x3f) {
      this.backspace();
      this.put(extended[a - 0x12][b - 0x20]);
    } else if (a === 0x11 && b >= 0x20 && b <= 0x2f) {
      this.style(b);
      this.put(' ');
    } else if (a === 0x10 && b >= 0x20 && b <= 0x2f) {
      this.background = b & 15;
      this.backspace();
      this.put(' ');
    } else if (a === 0x17 && b >= 0x2d && b <= 0x2f) {
      if (b === 0x2d) this.background = 16;
      else {
        this.color = 'black';
        this.italic = false;
        this.underline = b === 0x2f;
      }
      this.backspace();
      this.put(' ');
    } else if (a === 0x17 && b >= 0x21 && b <= 0x23)
      this.column = Math.min(31, this.column + b - 0x20);
    else if (a === 0x14 && b >= 0x20 && b <= 0x2f) {
      switch (b) {
        case 0x20:
          this.mode = 'pop';
          break;
        case 0x21:
          this.backspace();
          break;
        case 0x24:
          this.memory[this.row].fill(null, this.column);
          break;
        case 0x25:
        case 0x26:
        case 0x27:
          if (this.mode !== 'roll') {
            this.front = blank();
            this.back = blank();
            this.row = 14;
            this.column = 0;
          }
          this.mode = 'roll';
          this.roll = b - 0x23;
          this.moveBase(Math.max(this.roll - 1, this.row));
          break;
        case 0x29:
          this.mode = 'paint';
          break;
        case 0x2a:
        case 0x2b:
          this.mode = 'text';
          break;
        case 0x2c:
          this.front = blank();
          break;
        case 0x2d:
          if (this.mode === 'roll') {
            const first = Math.max(0, this.row - this.roll + 1);
            for (let i = first; i < this.row; i++)
              this.front[i] = this.front[i + 1];
            this.front[this.row] = Array(32).fill(null);
            this.column = 0;
            this.background = 14;
          }
          break;
        case 0x2e:
          this.back = blank();
          break;
        case 0x2f:
          [this.front, this.back] = [this.back, this.front];
          this.mode = 'pop';
          this.column = 0;
          break;
      }
    }
  }
  rows(): Row608[] {
    return this.front.flatMap((cells, row) => {
      const column = cells.findIndex((c) => c !== null);
      if (column < 0) return [];
      let end = 31;
      while (end > column && !cells[end]) end--;
      return [
        {
          row,
          column,
          cells: cells.slice(column, end + 1).map((c) => (c ? { ...c } : null)),
        },
      ];
    });
  }
}
export class Cea608Decoder {
  private xds = false;
  constructor(private field: 1 | 2 = 1) {}
  private channels = [new Channel(), new Channel()];
  private service = 0;
  private lastControl = -1;
  private lastScreens = ['[]', '[]'];
  parityErrors = 0;
  reset() {
    this.xds = false;
    this.channels = [new Channel(), new Channel()];
    this.service = 0;
    this.lastControl = -1;
    this.lastScreens = ['[]', '[]'];
  }
  clone(): Cea608Decoder {
    const copy = new Cea608Decoder(this.field);
    copy.xds = this.xds;
    copy.channels = this.channels.map((channel) =>
      Object.assign(new Channel(), structuredClone(channel)),
    );
    copy.service = this.service;
    copy.lastControl = this.lastControl;
    copy.lastScreens = [...this.lastScreens];
    copy.parityErrors = this.parityErrors;
    return copy;
  }
  screens(time: number): Screen608[] {
    return this.channels.map((c, i) => ({
      time,
      service: i + 1,
      rows: c.rows(),
    }));
  }
  push(first: number, second: number, time: number): Screen608[] {
    if ((first & 127) === 0 && (second & 127) === 0) return [];
    const a = first & 127,
      b = second & 127;
    if (!oddParity(first) || !oddParity(second)) {
      this.parityErrors++;
      this.lastControl = -1;
      return [];
    }
    if (this.field === 2) {
      if (a >= 1 && a <= 15) {
        this.xds = a !== 15;
        return [];
      }
      if (a >= 0x10 && a <= 0x1f) this.xds = false;
      if (this.xds) return [];
    }
    const coded = a >= 0x10 && a <= 0x1f && b >= 0x20;
    if (coded) {
      this.service = a & 8 ? 1 : 0;
      const normal = a & 0x17;
      const character =
        (normal === 0x11 && b >= 0x30 && b <= 0x3f) ||
        ((normal === 0x12 || normal === 0x13) && b <= 0x3f);
      const key = (a << 8) | b;
      if (!character && key === this.lastControl) {
        this.lastControl = -1;
        return [];
      }
      this.lastControl = character ? -1 : key;
      this.channels[this.service].command(normal, b);
    } else {
      this.lastControl = -1;
      for (const c of [a, b])
        if (c >= 32)
          this.channels[this.service].put(basic[c] ?? String.fromCharCode(c));
    }
    const rows = this.channels[this.service].rows(),
      signature = JSON.stringify(rows);
    if (signature === this.lastScreens[this.service]) return [];
    this.lastScreens[this.service] = signature;
    return [{ time, service: this.service + 1, rows }];
  }
}
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(' ', '\u00a0');
/** One native cue per positioned row; never insert stream text as HTML. */
export function row608Text(row: Row608): string {
  return row.cells
    .map((cell) =>
      cell
        ? `<c.cea608.${cell.color}.cea608-bg${cell.background ?? 14}>${cell.italic ? '<i>' : ''}${cell.underline ? '<u>' : ''}${escape(cell.char)}${cell.underline ? '</u>' : ''}${cell.italic ? '</i>' : ''}</c>`
        : '\u00a0',
    )
    .join('');
}

/** Native cue rules remain scoped to the owning video by WebVttStyles. */
export function cea608Styles() {
  const rgb = [
    '255,255,255',
    '0,255,0',
    '0,0,255',
    '0,255,255',
    '255,0,0',
    '255,255,0',
    '255,0,255',
    '0,0,0',
  ];
  return (
    '::cue { background-color: transparent; }\n::cue(.cea608) { font-family: monospace; }\n' +
    Array.from(
      { length: 17 },
      (_, id) =>
        `::cue(.cea608-bg${id}) { background-color: ${id === 16 ? 'transparent' : `rgba(${rgb[id >>> 1]},${id & 1 ? 0.5 : 1})`}; }`,
    ).join('\n')
  );
}
