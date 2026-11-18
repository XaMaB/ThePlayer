export { VERSION } from './version';
import { PlayerCore, type EngineRegistry } from './core/player';
import type { HlsSource } from './engines/hls/engine';
import { MoqEngine, type PlayerSource } from './engines/moq/engine';

export { PlayerCore } from './core/player';
export type {
  PlaybackEngine,
  PlaybackSource,
  EngineFactory,
  EngineRegistry,
  TimelineMarker,
} from './core/player';
export { MoqEngine } from './engines/moq/engine';
export type { PlayerSource } from './engines/moq/engine';
export { SubtitleRenderer } from './subtitles/renderer';
export { mountControls } from './ui/controls';
export type { ControlsOptions } from './ui/controls';

/** Default distribution includes MoQ. Use PlayerCore for a custom engine set. */
export class ThePlayer extends PlayerCore {
  constructor(
    video: HTMLVideoElement,
    private readonly initialSource?: PlayerSource | HlsSource,
    engines: EngineRegistry = {
      moq: (video, source) => new MoqEngine(video, source),
      hls: async (video, source) => {
        const { HlsEngine } = await import('./engines/hls/engine');
        return new HlsEngine(video, source);
      },
    },
  ) {
    super(video, engines);
  }
  async init() {
    if (!this.initialSource)
      throw new Error('Supply a source or call load(source)');
    await this.load({
      ...this.initialSource,
      protocol: this.initialSource.protocol ?? 'moq',
    });
  }
}

/** Legacy low-level API; new integrations should use ThePlayer. */
export { MoqEngine as MoqPlayer } from './engines/moq/engine';

export type { HlsSource } from './engines/hls/engine';

export type { Thumbnail } from './core/thumbnail';
