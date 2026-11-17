export interface VttRegionData {
  id: string;
  width: number;
  lines: number;
  regionAnchorX: number;
  regionAnchorY: number;
  viewportAnchorX: number;
  viewportAnchorY: number;
  scroll: ScrollSetting;
}
export interface TextCue {
  start: number;
  end: number;
  text: string;
  settings: string;
}
function time(value: string): number {
  if (!/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(value))
    throw new Error('Invalid WebVTT timestamp');
  const parts = value.split(':').map(Number);
  if (parts.at(-1)! >= 60 || parts.at(-2)! >= 60)
    throw new Error('Invalid WebVTT timestamp');
  return parts.reduce((n, p) => n * 60 + p, 0);
}
/** Segmented WebVTT, including the HLS 90 kHz timestamp mapping. */
export function parseVtt(
  text: string,
  offset = 0,
  reference?: number,
): TextCue[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replaceAll('\r', '')
    .split('\n');
  if (!/^WEBVTT(?:[ \t]|$)/.test(lines[0])) throw new Error('Expected WebVTT');
  const map = lines.find((line) => line.startsWith('X-TIMESTAMP-MAP='));
  if (map) {
    const local = /LOCAL:([^,]+)/.exec(map),
      mpeg = /MPEGTS:(\d+)/.exec(map);
    if (!local || !mpeg) throw new Error('Invalid WebVTT timestamp map');
    const wrap = 2 ** 33 / 90000;
    const media = Number(mpeg[1]) / 90000;
    if (media >= wrap) throw new Error('Invalid WebVTT MPEGTS timestamp');
    if (reference !== undefined)
      offset += Math.round((reference - (media + offset)) / wrap) * wrap;
    offset += media - time(local[1]);
  }
  const out: TextCue[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[i])) {
      while (i < lines.length && lines[i]) i++;
      continue;
    }
    if (!lines[i].includes('-->')) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines[i]);
    if (!match) throw new Error('Invalid WebVTT cue');
    const start = time(match[1]) + offset,
      end = time(match[2]) + offset;
    const content: string[] = [];
    while (++i < lines.length && lines[i]) content.push(lines[i]);
    if (end > start)
      out.push({
        start,
        end,
        text: content.join('\n'),
        settings: match[3].trim(),
      });
  }
  return out;
}
export function nativeCue(
  cue: TextCue,
  regions: Map<string, VttRegionData> = new Map(),
): VTTCue {
  const out = new VTTCue(
    Math.max(0, cue.start),
    Math.max(0, cue.end),
    cue.text,
  );
  let selectedRegion: VttRegionData | undefined;
  for (const setting of cue.settings.split(/\s+/)) {
    const [name, value] = setting.split(':');
    if (
      name === 'align' &&
      ['start', 'center', 'end', 'left', 'right'].includes(value)
    )
      out.align = value as AlignSetting;
    if (name === 'size' && /^\d+(?:\.\d+)?%$/.test(value))
      out.size = Math.min(100, parseFloat(value));
    if (name === 'position' && /^\d+(?:\.\d+)?%/.test(value)) {
      out.position = Math.min(100, parseFloat(value));
      const align = value.split(',')[1];
      if (['line-left', 'center', 'line-right', 'auto'].includes(align))
        out.positionAlign = align as PositionAlignSetting;
    }
    if (name === 'region' && regions.has(value))
      selectedRegion = regions.get(value)!;
    if (name === 'line' && /^-?\d/.test(value)) {
      out.snapToLines = !value.includes('%');
      const align = value.split(',')[1];
      if (['start', 'center', 'end'].includes(align))
        out.lineAlign = align as LineAlignSetting;
      out.line = out.snapToLines
        ? parseInt(value)
        : Math.min(100, parseFloat(value));
    }
    if (name === 'vertical' && ['rl', 'lr'].includes(value))
      out.vertical = value as DirectionSetting;
  }
  if (
    selectedRegion &&
    out.line === 'auto' &&
    out.size === 100 &&
    !out.vertical
  ) {
    if (typeof VTTRegion !== 'undefined' && selectedRegion instanceof VTTRegion)
      out.region = selectedRegion;
    else {
      out.size = selectedRegion.width;
      out.position = Math.max(
        0,
        Math.min(
          100,
          selectedRegion.viewportAnchorX -
            (selectedRegion.regionAnchorX * selectedRegion.width) / 100,
        ),
      );
      out.positionAlign = 'line-left';
      out.snapToLines = false;
      out.line = selectedRegion.viewportAnchorY;
      out.lineAlign =
        selectedRegion.regionAnchorY >= 75
          ? 'end'
          : selectedRegion.regionAnchorY >= 25
            ? 'center'
            : 'start';
    }
  }
  return out;
}

export function vttHeaders(text: string): {
  styles: string[];
  regions: Map<string, VttRegionData>;
} {
  const blocks = text.replaceAll('\r', '').split(/\n\s*\n/);
  const styles: string[] = [],
    regions = new Map<string, VttRegionData>();
  for (const block of blocks.slice(1)) {
    if (block.includes('-->')) break;
    const lines = block.split('\n');
    if (lines[0] === 'STYLE') styles.push(lines.slice(1).join('\n'));
    if (lines[0] !== 'REGION') continue;
    const settings = Object.fromEntries(
      lines.slice(1).map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
    );
    if (!settings.id) continue;
    const region: VttRegionData =
      typeof VTTRegion !== 'undefined'
        ? new VTTRegion()
        : {
            id: '',
            width: 100,
            lines: 3,
            regionAnchorX: 0,
            regionAnchorY: 100,
            viewportAnchorX: 0,
            viewportAnchorY: 100,
            scroll: '',
          };
    region.id = settings.id;
    const percentage = (value: string) => {
      if (!/^\d+(?:\.\d+)?%$/.test(value) || parseFloat(value) > 100)
        throw new Error('Invalid WebVTT region percentage');
      return parseFloat(value);
    };
    if (settings.width) region.width = percentage(settings.width);
    if (settings.lines && /^\d+$/.test(settings.lines))
      region.lines = Number(settings.lines);
    for (const [key, x, y] of [
      ['regionanchor', 'regionAnchorX', 'regionAnchorY'],
      ['viewportanchor', 'viewportAnchorX', 'viewportAnchorY'],
    ] as const) {
      if (!settings[key]) continue;
      const pair = settings[key].split(',');
      region[x] = percentage(pair[0]);
      region[y] = percentage(pair[1]);
    }
    if (settings.scroll === 'up') region.scroll = 'up';
    regions.set(region.id, region);
  }
  return { styles, regions };
}
let styleId = 0;
export class WebVttStyles {
  private element = document.createElement('style');
  private rules = new Set<string>();
  private id = 'vtt-' + ++styleId;
  constructor(private video: HTMLVideoElement) {
    video.dataset.theplayerVtt = this.id;
    document.head.append(this.element);
  }
  add(text: string) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    for (const rule of sheet.cssRules) {
      if (
        !(rule instanceof CSSStyleRule) ||
        !/^::cue(?:\((?:[biu]|\.[\w-]+|c(?:\.[\w-]+)?|v(?:\[voice="[^"<>]*"\])?|:lang\([a-zA-Z-]+\))\))?$/.test(
          rule.selectorText,
        )
      )
        continue;
      const declarations: string[] = [];
      for (const property of rule.style) {
        if (
          ![
            'color',
            'background-color',
            'font-family',
            'font-size',
            'font-style',
            'font-weight',
            'text-decoration',
            'text-shadow',
            'opacity',
            'white-space',
          ].includes(property)
        )
          continue;
        const value = rule.style.getPropertyValue(property);
        if (/url\s*\(|expression\s*\(|@/i.test(value)) continue;
        declarations.push(property + ':' + value);
      }
      if (declarations.length)
        this.rules.add(
          'video[data-theplayer-vtt="' +
            this.id +
            '"]' +
            rule.selectorText +
            '{' +
            declarations.join(';') +
            '}',
        );
    }
    this.element.textContent = [...this.rules].join('\n');
  }
  destroy() {
    this.element.remove();
    if (this.video.dataset.theplayerVtt === this.id)
      delete this.video.dataset.theplayerVtt;
  }
}
