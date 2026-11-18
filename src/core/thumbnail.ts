export interface Thumbnail {
  /** Engine-owned object URL; valid until cache eviction or player destruction. */
  url: string;
  time: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  sheetWidth: number;
  sheetHeight: number;
}
