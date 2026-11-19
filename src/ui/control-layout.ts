export const toolbarControls = {
  play: 'play-toggle',
  mute: 'mute-toggle',
  volume: 'volume',
  time: 'playback-time',
  seek: 'seek-bar',
  spacer: 'control-spacer',
  quality: 'quality-toggle',
  audio: 'audio-toggle',
  captions: 'cc-toggle',
  options: 'info-toggle',
  pip: 'pip-toggle',
  fullscreen: 'fullscreen',
} as const;
export type ToolbarControl = keyof typeof toolbarControls;
export type CenterControl = 'back' | 'play' | 'forward';
const centerControls = {
  back: 'skip-back',
  play: 'center-play',
  forward: 'skip-forward',
} as const;
export interface ControlLayout {
  toolbar?: readonly ToolbarControl[];
  center?: readonly CenterControl[];
}
export function applyControlLayout(screen: HTMLElement, config: ControlLayout) {
  for (const [entries, known] of [
    [config.toolbar, toolbarControls],
    [config.center, centerControls],
  ] as const) {
    if (!entries) continue;
    if (
      new Set(entries).size !== entries.length ||
      entries.some((name) => !Object.hasOwn(known, name))
    )
      throw new Error('Control layouts require unique, known control names');
  }
  const apply = (
    entries: readonly string[] | undefined,
    known: Record<string, string>,
    selector: string,
  ) => {
    const container = screen.querySelector(selector)!;
    const selected = entries ?? Object.keys(known);
    for (const [name, id] of Object.entries(known))
      screen
        .querySelector('#' + id)!
        .toggleAttribute('data-layout-hidden', !selected.includes(name));
    for (const name of selected)
      container.append(screen.querySelector('#' + known[name])!);
  };
  apply(config.toolbar, toolbarControls, '.video-controls');
  apply(config.center, centerControls, '.center-controls');
  screen
    .querySelector('#timeline-markers')!
    .toggleAttribute(
      'data-layout-hidden',
      !!config.toolbar && !config.toolbar.includes('seek'),
    );
}
