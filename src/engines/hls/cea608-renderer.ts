import type { Screen608 } from './cea608';
import type { Window708, Pen708 } from './cea708-service';
import { Cea708Renderer } from './cea708-renderer';
const colors: Record<string, number> = {
  white: 63,
  lime: 12,
  blue: 3,
  cyan: 15,
  red: 48,
  yellow: 60,
  magenta: 51,
  black: 0,
};
const backgrounds = [63, 12, 3, 15, 48, 60, 51, 0];
/** Firefox lacks selector-based ::cue styling. Use the shared cell compositor then. */
export class Cea608Renderer {
  private renderer: Cea708Renderer;
  constructor(video: HTMLVideoElement, present: (text: string) => void) {
    this.renderer = new Cea708Renderer(video, present, {
      columns: 32,
      className: 'theplayer-cea608',
    });
  }
  set(events: Screen608[]) {
    this.renderer.set(
      events.map((event) => ({
        ...event,
        windows: event.rows.map((row): Window708 => {
          const pen: Pen708 = {
            size: 1,
            font: 0,
            offset: 1,
            italic: false,
            underline: false,
            edge: 0,
            foreground: 63,
            background: 0,
            edgeColor: 0,
          };
          return {
            id: row.row,
            visible: true,
            priority: 0,
            relative: true,
            vertical: (row.row * 99) / 15,
            horizontal: (row.column * 99) / 32,
            anchor: 0,
            rows: 1,
            columns: 32 - row.column,
            rowLock: true,
            columnLock: true,
            row: 0,
            column: 0,
            justify: 0,
            print: 0,
            scroll: 3,
            wrap: false,
            fill: 192,
            border: 0,
            borderColor: 0,
            effect: 0,
            effectDirection: 0,
            effectSpeed: 0,
            definition: [],
            pen,
            cells: [
              row.cells.map((cell) => {
                if (!cell) return null;
                const background = cell.background ?? 14;
                return {
                  text: cell.char,
                  pen: {
                    ...pen,
                    italic: cell.italic,
                    underline: cell.underline,
                    foreground: colors[cell.color] ?? 63,
                    background:
                      background === 16
                        ? 192
                        : backgrounds[background >>> 1] |
                          (background & 1 ? 128 : 0),
                  },
                };
              }),
            ],
          };
        }),
      })),
    );
  }
  destroy() {
    this.renderer.destroy();
  }
}
