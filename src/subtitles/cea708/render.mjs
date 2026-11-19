// CEA-708 window coordinates: relative 0..99, absolute 0..209 (16:9),
// 0..159 (4:3) horizontally and 0..74 vertically. Anchor points form a 3x3 grid.
export function layout708Window(win, width, height, cellWidth) {
  const wide = width / height > 1.5;
  const rows = Math.max(1, Math.min(16, win.rowCount ?? 1));
  const columns = Math.max(
    1,
    Math.min(wide ? 42 : 32, win.columnCount ?? (wide ? 42 : 32)),
  );
  const scale = [0.75, 1, 1.25][win.pen?.penSize ?? 1] ?? 1;
  const lineHeight = ((height * 0.9) / 15) * scale,
    fontSize = lineHeight * 0.8;
  const windowWidth = columns * cellWidth,
    windowHeight = rows * lineHeight;
  const anchor = Math.max(0, Math.min(8, win.anchorPoint ?? 0));
  const x =
    (0.05 +
      0.9 *
        Math.max(
          0,
          Math.min(
            1,
            (win.anchorHorizontal ?? 0) /
              (win.relative ? 99 : wide ? 209 : 159),
          ),
        )) *
    width;
  const y =
    (0.05 +
      0.9 *
        Math.max(
          0,
          Math.min(1, (win.anchorVertical ?? 0) / (win.relative ? 99 : 74)),
        )) *
    height;
  const left = x - ((anchor % 3) / 2) * windowWidth,
    top = y - (Math.floor(anchor / 3) / 2) * windowHeight;
  const justify = win.attributes?.justify ?? 0;
  return {
    left,
    top,
    width: windowWidth,
    height: windowHeight,
    lineHeight,
    fontSize,
    columns,
    rows,
    align: justify === 1 ? 'right' : justify === 2 ? 'center' : 'left',
    justify,
  };
}

export function draw708(context, cue, width, height, appearance = {}) {
  let visible = false;
  // Lower numerical priority is on top; keep windows separate.
  for (const win of [...(cue.windows ?? [])].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) || (b.id ?? 0) - (a.id ?? 0),
  )) {
    const size = layout708Window(win, width, height, 1).fontSize;
    context.save();
    context.font = `${size}px ${appearance.font && appearance.font !== 'source' ? appearance.font : 'monospace'}`;
    context.textBaseline = 'top';
    const cellWidth = context.measureText('M').width;
    const box = layout708Window(win, width, height, cellWidth);
    context.beginPath();
    context.rect(box.left, box.top, box.width, box.height);
    context.clip();
    context.textAlign = box.align;
    const x =
      box.align === 'left'
        ? box.left
        : box.align === 'right'
          ? box.left + box.width
          : box.left + box.width / 2;
    for (let i = 0; i < Math.min(box.rows, win.rows.length); i++) {
      const line = win.rows[i].replace(/<\/?(?:i|u)>/g, '');
      if (!line.trim()) continue;
      const y = box.top + i * box.lineHeight;
      const textWidth = context.measureText(line).width;
      const left =
        box.align === 'left'
          ? x
          : box.align === 'right'
            ? x - textWidth
            : x - textWidth / 2;
      context.fillStyle =
        { transparent: 'transparent', dark: 'rgba(0,0,0,.75)', solid: '#000' }[
          appearance.background
        ] ?? 'rgba(0,0,0,.75)';
      context.fillRect(left, y, textWidth, box.lineHeight);
      context.fillStyle =
        appearance.color && appearance.color !== 'source'
          ? appearance.color
          : '#fff';
      if (appearance.outline) {
        context.shadowColor = '#000';
        context.shadowBlur = 3;
      }
      if (box.justify === 3 && /\S +\S/.test(line.trim())) {
        const words = line.trim().split(/ +/),
          total = words.reduce((n, w) => n + context.measureText(w).width, 0);
        const gap = Math.max(0, (box.width - total) / (words.length - 1));
        let at = box.left;
        for (const word of words) {
          context.fillText(word, at, y);
          at += context.measureText(word).width + gap;
        }
      } else context.fillText(line, x, y);
      if (
        y < height &&
        y + box.lineHeight > 0 &&
        left < width &&
        left + textWidth > 0
      )
        visible = true;
    }
    context.restore();
  }
  return visible;
}
