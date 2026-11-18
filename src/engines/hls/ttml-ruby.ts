import type { TtmlRun } from './ttml';
/** Map matched TTML ruby bases and annotations to native HTML ruby layout. */
export function renderRuby(
  runs: TtmlRun[],
  span: (run: TtmlRun) => HTMLElement,
) {
  const group = document.createElement('span');
  group.className = 'theplayer-ruby';
  const indices = [
    ...new Set(
      runs.filter((r) => r.ruby?.role === 'base').map((r) => r.ruby!.index),
    ),
  ].sort((a, b) => a - b);
  for (const index of indices) {
    const bases = runs.filter(
      (r) => r.ruby?.role === 'base' && r.ruby.index === index,
    );
    const annotations = runs.filter(
      (r) => r.ruby?.role === 'text' && r.ruby.index === index,
    );
    let content: HTMLElement = document.createElement('span');
    content.dataset.rubyBase = String(index);
    content.append(...bases.map(span));
    for (const side of ['before', 'after']) {
      const texts = annotations.filter(
        (r) => (r.ruby!.side === 'after' ? 'after' : 'before') === side,
      );
      if (!texts.length) continue;
      const ruby = document.createElement('ruby');
      const align = bases[0].ruby!.align;
      const cssAlign =
        (
          {
            start: 'start',
            center: 'center',
            end: 'end',
            spaceAround: 'space-around',
            spaceBetween: 'space-between',
          } as Record<string, string>
        )[align] ?? 'center';
      ruby.style.setProperty(
        'ruby-align',
        CSS.supports('ruby-align', cssAlign) ? cssAlign : 'center',
      );
      const verticalLeft = ['tblr'].includes(bases[0].style.writingMode);
      ruby.style.setProperty(
        'ruby-position',
        (side === 'before') !== verticalLeft ? 'over' : 'under',
      );
      ruby.dataset.rubySide = side;
      const text = document.createElement('rt');
      text.append(...texts.map(span));
      ruby.append(content, text);
      content = ruby;
    }
    group.append(content);
  }
  return group;
}
