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
  return parts.reduce((n, p) => n * 60 + p, 0);
}
/** Segmented WebVTT, including the HLS 90 kHz timestamp mapping. */
export function parseVtt(text: string, offset = 0): TextCue[] {
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
    offset += Number(mpeg[1]) / 90000 - time(local[1]);
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
export function nativeCue(cue: TextCue): VTTCue {
  const out = new VTTCue(
    Math.max(0, cue.start),
    Math.max(0, cue.end),
    cue.text,
  );
  for (const setting of cue.settings.split(/\s+/)) {
    const [name, value] = setting.split(':');
    if (
      name === 'align' &&
      ['start', 'center', 'end', 'left', 'right'].includes(value)
    )
      out.align = value as AlignSetting;
    if (name === 'size' && /^\d+(?:\.\d+)?%$/.test(value))
      out.size = Math.min(100, parseFloat(value));
    if (name === 'position' && /^\d+(?:\.\d+)?%/.test(value))
      out.position = Math.min(100, parseFloat(value));
    if (name === 'line' && /^-?\d/.test(value)) {
      out.snapToLines = !value.includes('%');
      out.line = out.snapToLines
        ? parseInt(value)
        : Math.min(100, parseFloat(value));
    }
    if (name === 'vertical' && ['rl', 'lr'].includes(value))
      out.vertical = value as DirectionSetting;
  }
  return out;
}
