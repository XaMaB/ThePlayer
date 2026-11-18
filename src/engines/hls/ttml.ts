import { compileTtmlSets } from './ttml-animation';
/** Original TTML text parser, using the browser's XML parser and media timing. */
const TT = 'http://www.w3.org/ns/ttml';
const TTS = TT + '#styling';
const TTP = TT + '#parameter';
const XML = 'http://www.w3.org/XML/1998/namespace';
export type TtmlStyle = Record<string, string>;
export interface TtmlRuby {
  group: number;
  role: string;
  index: number;
  side: string;
  align: string;
  fontSize: string;
}
export interface TtmlRun {
  ruby?: TtmlRuby;
  text: string;
  start: number;
  end: number;
  style: TtmlStyle;
}
export interface TtmlParagraph {
  start: number;
  end: number;
  region: string;
  style: TtmlStyle;
  runs: TtmlRun[];
}
export interface TtmlDocument {
  paragraphs: TtmlParagraph[];
  regions: Record<string, TtmlStyle>;
  cells: [number, number];
  extent?: [number, number];
}
interface Rates {
  frame: number;
  subFrame: number;
  tick: number;
}
export function ttmlTime(value: string, rates: Rates): number {
  const clock =
    /^(\d{2,}):(\d{2}):(\d{2})(?:(\.\d+)|:(\d{2,})(?:\.(\d+))?)?$/.exec(value);
  if (clock) {
    const [, h, m, s, fraction, frames, sub] = clock;
    if (+m >= 60 || +s >= 60 || (frames && +frames >= Math.ceil(rates.frame)))
      throw new Error('Invalid TTML clock time');
    return (
      +h * 3600 +
      +m * 60 +
      +s +
      +(fraction ?? 0) +
      (+(frames ?? 0) + +(sub ?? 0) / rates.subFrame) / rates.frame
    );
  }
  const offset = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(value);
  if (!offset) throw new Error('Invalid TTML time expression');
  return (
    +offset[1] *
    { h: 3600, m: 60, s: 1, ms: 0.001, f: 1 / rates.frame, t: 1 / rates.tick }[
      offset[2]
    ]!
  );
}
const positivePair = (value: string, suffix = ''): [number, number] => {
  const parts = value
    .trim()
    .split(/\s+/)
    .map((v) => Number(suffix ? v.replace(new RegExp(suffix + '$'), '') : v));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n <= 0))
    throw new Error('Invalid TTML dimensions');
  return parts as [number, number];
};
const nonInherited = new Set([
  'backgroundColor',
  'origin',
  'extent',
  'padding',
  'displayAlign',
  'showBackground',
  'overflow',
  'opacity',
  'zIndex',
  'ruby',
]);
const styleValue = (
  local: TtmlStyle,
  parent: TtmlStyle,
  name: string,
  fallback: string,
) => local[name] ?? parent[name] ?? fallback;
const inheritedStyle = (style: TtmlStyle) =>
  Object.fromEntries(
    Object.entries(style).filter(([name]) => !nonInherited.has(name)),
  );
function parseTtmlDocument(
  xml: string,
  clipStart: number,
  clipEnd: number,
  offset = 0,
  animations = true,
): TtmlDocument {
  if (xml.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Unsupported TTML document declarations or size');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (
    doc.getElementsByTagName('parsererror').length ||
    root.localName !== 'tt' ||
    root.namespaceURI !== TT
  )
    throw new Error('Invalid TTML XML');
  if (
    root.getAttributeNS(TTP, 'timeBase') &&
    root.getAttributeNS(TTP, 'timeBase') !== 'media'
  )
    throw new Error('TTML requires media time base');
  if (
    (
      (root.getAttributeNS(TTP, 'contentProfiles') ?? '') +
      (root.getAttributeNS(TTP, 'profile') ?? '')
    ).includes('/image')
  )
    throw new Error('TTML image profile is not supported');
  const frame = Number(root.getAttributeNS(TTP, 'frameRate') || 30);
  const multiplier = positivePair(
    root.getAttributeNS(TTP, 'frameRateMultiplier') || '1 1',
  );
  const subFrame = Number(root.getAttributeNS(TTP, 'subFrameRate') || 1);
  const effective = (frame * multiplier[0]) / multiplier[1];
  const tick = Number(
    root.getAttributeNS(TTP, 'tickRate') ||
      (root.hasAttributeNS(TTP, 'frameRate') ? effective * subFrame : 1),
  );
  if (
    ![frame, subFrame, tick, effective].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    throw new Error('Invalid TTML clock rate');
  const rates = { frame: effective, subFrame, tick };
  const elements = [...doc.getElementsByTagName('*')];
  if (elements.length > 20000) throw new Error('TTML element limit exceeded');
  if (
    animations &&
    elements.some(
      (e) =>
        e.namespaceURI === TT &&
        (e.localName === 'set' || e.hasAttribute('animate')),
    )
  )
    return compileTtmlSets(
      root,
      clipStart,
      clipEnd,
      (value) => ttmlTime(value, rates),
      (text, start, end) => parseTtmlDocument(text, start, end, offset, false),
    );
  const styles = new Map(
    elements
      .filter((e) => e.namespaceURI === TT && e.localName === 'style')
      .map((e) => [e.getAttributeNS(XML, 'id'), e]),
  );
  const memo = new Map<string, TtmlStyle>();
  const resolve = (element: Element, stack: string[] = []): TtmlStyle => {
    const result: TtmlStyle = {};
    for (const id of (element.getAttribute('style') ?? '')
      .split(/\s+/)
      .filter(Boolean)) {
      if (stack.includes(id) || stack.length > 64)
        throw new Error('Cyclic TTML style reference');
      const definition = styles.get(id);
      if (!definition) continue;
      if (!memo.has(id)) memo.set(id, resolve(definition, [...stack, id]));
      Object.assign(result, memo.get(id));
    }
    for (const a of element.attributes)
      if (a.namespaceURI === TTS) result[a.localName] = a.value;
    return result;
  };
  const regions: Record<string, TtmlStyle> = Object.assign(
    Object.create(null),
    {
      '': { origin: '0% 0%', extent: '100% 100%', displayAlign: 'before' },
    },
  );
  for (const e of elements.filter(
    (e) => e.namespaceURI === TT && e.localName === 'region',
  )) {
    const id = e.getAttributeNS(XML, 'id');
    if (id) {
      regions[id] = resolve(e);
      if (regions[id].fontSize?.endsWith('%'))
        regions[id].fontSize =
          String(parseFloat(regions[id].fontSize) / 100) + 'c';
    }
  }
  const result: TtmlDocument = {
    paragraphs: [],
    regions,
    cells: positivePair(root.getAttributeNS(TTP, 'cellResolution') || '32 15'),
  };
  const extent = root.getAttributeNS(TTS, 'extent');
  if (extent && extent !== 'auto') result.extent = positivePair(extent, 'px');
  const interval = (e: Element, base: number, parentEnd: number) => {
    const start =
      base +
      (e.hasAttribute('begin') ? ttmlTime(e.getAttribute('begin')!, rates) : 0);
    let end = Math.min(
      parentEnd,
      e.hasAttribute('end')
        ? base + ttmlTime(e.getAttribute('end')!, rates)
        : Infinity,
      e.hasAttribute('dur')
        ? start + ttmlTime(e.getAttribute('dur')!, rates)
        : Infinity,
    );
    if (
      e.localName === 'set' &&
      e.hasAttribute('dur') &&
      e.hasAttribute('repeatCount')
    ) {
      const repeat = e.getAttribute('repeatCount')!;
      const count = repeat === 'indefinite' ? Infinity : Number(repeat);
      const duration = ttmlTime(e.getAttribute('dur')!, rates);
      if (duration > 0)
        end = Math.min(
          parentEnd,
          e.hasAttribute('end')
            ? base + ttmlTime(e.getAttribute('end')!, rates)
            : Infinity,
          start + duration * count,
        );
    }
    return { start, end };
  };
  let rubyGroup = 0;
  const rubyIndices = new WeakMap<Element, Record<string, number>>();
  const halfFont = (value: string) =>
    value
      .split(/\s+/)
      .map((v) => v.replace(/^(\d+(?:\.\d+)?)/, (n) => String(Number(n) / 2)))
      .join(' ');
  const walk = (
    e: Element,
    base: number,
    parentEnd: number,
    inherited: TtmlStyle,
    region: string,
    preserve: boolean,
    paragraph?: TtmlParagraph,
    depth = 0,
    paint: TtmlStyle = {},
    ruby?: TtmlRuby,
  ): number => {
    if (depth > 128) throw new Error('TTML nesting limit exceeded');
    const { start, end } = interval(e, base, parentEnd);
    if (end <= start) return end;
    region = e.getAttribute('region') || region;
    const parentStyle = {
      ...(e.localName === 'p'
        ? inheritedStyle(regions[region] ?? regions[''])
        : {}),
      ...inheritedStyle(inherited),
    };
    const declared = resolve(e);
    const role = declared.ruby ?? 'none';
    const parentRuby = ruby;
    if (role === 'container') {
      if (ruby) throw new Error('Nested TTML ruby containers are invalid');
      ruby = {
        group: ++rubyGroup,
        role,
        index: 0,
        side: 'before',
        align: styleValue(declared, parentStyle, 'rubyAlign', 'center'),
        fontSize: declared.fontSize ?? parentStyle.fontSize ?? '1c',
      };
    } else if (
      ['baseContainer', 'textContainer', 'base', 'text', 'delimiter'].includes(
        role,
      )
    ) {
      if (!ruby) throw new Error('TTML ruby component has no container');
      const indices = rubyIndices.get(e.parentElement!) ?? {};
      const index = parentRuby?.role === 'container' ? 0 : (indices[role] ?? 0);
      indices[role] = index + 1;
      rubyIndices.set(e.parentElement!, indices);
      ruby = {
        ...ruby,
        role,
        index,
        side:
          parentRuby?.role === 'textContainer'
            ? parentRuby.side
            : styleValue(declared, parentStyle, 'rubyPosition', 'before'),
      };
      if (role === 'text' && parentRuby?.role === 'container')
        parentStyle.fontSize = halfFont(ruby.fontSize);
    }
    const style = { ...parentStyle, ...declared };
    if (role === 'textContainer' && !declared.fontSize)
      style.fontSize = halfFont(ruby!.fontSize);
    if (declared.fontSize?.endsWith('%')) {
      const parent = /^(\d+(?:\.\d+)?)(c|px|em)$/.exec(
        parentStyle.fontSize ?? '1c',
      );
      if (parent)
        style.fontSize =
          String((+parent[1] * parseFloat(declared.fontSize)) / 100) +
          parent[2];
    }
    if (role === 'container') ruby!.fontSize = style.fontSize ?? '1c';
    if (e.localName === 'p') paint = {};
    else {
      paint = { ...paint };
      if (declared.backgroundColor)
        paint.backgroundColor = declared.backgroundColor;
      if (declared.opacity)
        paint.opacity = String(
          Number(paint.opacity ?? 1) * Number(declared.opacity),
        );
    }
    const space = e.getAttributeNS(XML, 'space');
    preserve = space === 'preserve' || (space !== 'default' && preserve);
    if (e.localName === 'p') {
      paragraph = {
        start: Math.max(start, clipStart) + offset,
        end: Math.min(end, clipEnd) + offset,
        region,
        style: { ...inheritedStyle(regions[region] ?? regions['']), ...style },
        runs: [],
      };
      if (paragraph.end > paragraph.start) result.paragraphs.push(paragraph);
    }
    if (e.localName === 'br' && paragraph)
      paragraph.runs.push({
        text: '\n',
        ...(ruby ? { ruby } : {}),
        start: Math.max(start, clipStart) + offset,
        end: Math.min(end, clipEnd) + offset,
        style: { ...inheritedStyle(style), ...paint },
      });
    let cursor = start;
    for (const node of e.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && paragraph) {
        let text = node.textContent ?? '';
        if (!preserve) {
          text = text.replace(/[\t\r\n ]+/g, ' ');
          const previous = paragraph.runs.at(-1)?.text;
          if (!previous || /[ \n]$/.test(previous))
            text = text.replace(/^ /, '');
        }
        if (
          ruby &&
          ['container', 'baseContainer', 'textContainer'].includes(ruby.role)
        ) {
          if (text.trim())
            throw new Error('Text outside TTML ruby base/annotation');
          continue;
        }
        if (ruby?.role === 'delimiter') continue;
        if (text)
          paragraph.runs.push({
            ...(ruby ? { ruby } : {}),
            text,
            start: Math.max(start, clipStart) + offset,
            end: Math.min(end, clipEnd) + offset,
            style: { ...inheritedStyle(style), ...paint },
          });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const child = node as Element;
        if (child.namespaceURI === TT && child.localName === 'set') {
          if (e.getAttribute('timeContainer') === 'seq')
            cursor = interval(child, cursor, end).end;
          continue;
        }
        if (
          child.namespaceURI !== TT ||
          !['body', 'div', 'p', 'span', 'br'].includes(child.localName)
        )
          continue;
        const childEnd = walk(
          child,
          e.getAttribute('timeContainer') === 'seq' ? cursor : start,
          end,
          style,
          region,
          preserve,
          paragraph,
          depth + 1,
          paint,
          ruby,
        );
        if (e.getAttribute('timeContainer') === 'seq') cursor = childEnd;
      }
    }
    return end;
  };
  const rootStyle = resolve(root);
  if (rootStyle.fontSize?.endsWith('%'))
    rootStyle.fontSize = String(parseFloat(rootStyle.fontSize) / 100) + 'c';
  for (const body of Array.from(root.children).filter(
    (e) => e.localName === 'body' && e.namespaceURI === TT,
  ))
    walk(
      body,
      0,
      Infinity,
      rootStyle,
      '',
      root.getAttributeNS(XML, 'space') === 'preserve',
    );
  return result;
}

export function parseTtml(
  xml: string,
  clipStart: number,
  clipEnd: number,
  offset = 0,
): TtmlDocument {
  return parseTtmlDocument(xml, clipStart, clipEnd, offset);
}
