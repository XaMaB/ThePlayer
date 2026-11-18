import type { TtmlDocument } from './ttml';
const TT = 'http://www.w3.org/ns/ttml';
const TTS = TT + '#styling';
const XML = 'http://www.w3.org/XML/1998/namespace';
/** Compile discrete style changes into bounded, independently seekable intervals. */
export function compileTtmlSets(
  root: Element,
  clipStart: number,
  clipEnd: number,
  time: (value: string) => number,
  parse: (xml: string, start: number, end: number) => TtmlDocument,
): TtmlDocument {
  if (root.getElementsByTagNameNS(TT, 'set').length > 128)
    throw new Error('TTML animation count limit exceeded');
  let copies = 0;
  const definitions = new Map<string, Element>();
  for (const set of root.getElementsByTagNameNS(TT, 'set'))
    if (set.parentElement?.localName === 'animation')
      definitions.set(set.getAttributeNS(XML, 'id') ?? '', set);
  for (const target of [root, ...root.getElementsByTagName('*')]) {
    const refs = (target.getAttribute('animate') ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (new Set(refs).size !== refs.length)
      throw new Error('Duplicate TTML animation reference');
    for (const ref of refs) {
      const definition = definitions.get(ref);
      if (!definition) throw new Error('Unsupported TTML animation reference');
      if (++copies > 128)
        throw new Error('TTML animation reference limit exceeded');
      const copy = definition.cloneNode(false) as Element;
      copy.removeAttributeNS(XML, 'id');
      const content = Array.from(target.children).find(
        (e) => !['metadata', 'set', 'animate'].includes(e.localName),
      );
      target.insertBefore(copy, content ?? null);
    }
    target.removeAttribute('animate');
  }
  const changes: {
    target: Element;
    start: number;
    end: number;
    style: [string, string][];
    order: number;
  }[] = [];
  const walk = (
    element: Element,
    base: number,
    parentEnd: number,
    depth = 0,
  ): number => {
    if (depth > 128) throw new Error('TTML animation nesting limit exceeded');
    const start =
      base +
      (element.hasAttribute('begin')
        ? time(element.getAttribute('begin')!)
        : 0);
    const explicitEnd = element.hasAttribute('end')
      ? base + time(element.getAttribute('end')!)
      : Infinity;
    const duration = element.hasAttribute('dur')
      ? time(element.getAttribute('dur')!)
      : Infinity;
    let end = Math.min(parentEnd, explicitEnd, start + duration);
    if (element.localName === 'set') {
      const repeat = element.getAttribute('repeatCount') ?? '1';
      const count = repeat === 'indefinite' ? Infinity : Number(repeat);
      if (!(count > 0) || (repeat !== 'indefinite' && !Number.isFinite(count)))
        throw new Error('Invalid TTML animation repeat count');
      if (duration !== Infinity && duration > 0)
        end = Math.min(parentEnd, explicitEnd, start + duration * count);
      const fill = element.getAttribute('fill') ?? 'remove';
      if (!['remove', 'freeze'].includes(fill))
        throw new Error('Invalid TTML animation fill');
      const effectEnd = fill === 'freeze' && end > start ? parentEnd : end;
      const style = Array.from(element.attributes)
        .filter((a) => a.namespaceURI === TTS)
        .map((a) => [a.localName, a.value] as [string, string]);
      if (style.some(([, v]) => v.includes(';')))
        throw new Error('TTML set requires one style value');
      if (
        start < clipEnd &&
        effectEnd > clipStart &&
        effectEnd > start &&
        style.length
      )
        changes.push({
          target: element.parentElement!,
          start,
          end: effectEnd,
          style,
          order: changes.length,
        });
      return end;
    }
    let cursor = start;
    for (const child of element.children) {
      if (
        child.namespaceURI !== TT ||
        ['animation', 'metadata', 'styling', 'style'].includes(child.localName)
      )
        continue;
      if (child.localName === 'animate')
        throw new Error('Continuous TTML animation is not supported');
      const childEnd = walk(
        child,
        element.getAttribute('timeContainer') === 'seq' ? cursor : start,
        end,
        depth + 1,
      );
      if (element.getAttribute('timeContainer') === 'seq') cursor = childEnd;
    }
    return end;
  };
  walk(root, 0, Infinity);
  if (changes.length > 128)
    throw new Error('TTML animation count limit exceeded');
  const points = [
    ...new Set([
      clipStart,
      clipEnd,
      ...changes.flatMap((c) => [
        Math.max(clipStart, c.start),
        Math.min(clipEnd, c.end),
      ]),
    ]),
  ].sort((a, b) => a - b);
  if (points.length * root.getElementsByTagName('*').length > 2000000)
    throw new Error('TTML animation expansion limit exceeded');
  const serializer = new XMLSerializer();
  let result: TtmlDocument | undefined;
  let runCount = 0,
    characters = 0,
    regionCount = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1];
    if (end <= start) continue;
    const undo: { target: Element; name: string; value: string | null }[] = [];
    for (const change of changes
      .filter((c) => c.start <= start && c.end > start)
      .sort((a, b) => a.start - b.start || a.order - b.order)) {
      for (const [name, value] of change.style) {
        undo.push({
          target: change.target,
          name,
          value: change.target.getAttributeNS(TTS, name),
        });
        change.target.setAttributeNS(TTS, 'tts:' + name, value);
      }
    }
    let slice: TtmlDocument;
    try {
      slice = parse(serializer.serializeToString(root), start, end);
    } finally {
      for (const item of undo.reverse()) {
        if (item.value === null) item.target.removeAttributeNS(TTS, item.name);
        else item.target.setAttributeNS(TTS, 'tts:' + item.name, item.value);
      }
    }
    if (!result)
      result = { ...slice, paragraphs: [], regions: Object.create(null) };
    regionCount += Object.keys(slice.regions).length;
    if (regionCount > 100000)
      throw new Error('TTML animated region limit exceeded');
    for (const [id, style] of Object.entries(slice.regions))
      result.regions[i + ':' + id] = style;
    for (const paragraph of slice.paragraphs) {
      runCount += paragraph.runs.length;
      characters += paragraph.runs.reduce((sum, r) => sum + r.text.length, 0);
      if (runCount > 100000 || characters > 8 * 1024 * 1024)
        throw new Error('TTML compiled animation limit exceeded');
      result.paragraphs.push({
        ...paragraph,
        region: i + ':' + paragraph.region,
      });
    }
  }
  return (
    result ?? parse(serializer.serializeToString(root), clipStart, clipEnd)
  );
}
