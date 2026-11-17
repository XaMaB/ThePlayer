import { PlayerCore, type EngineRegistry } from './core/player';
import { MoqEngine, type PlayerSource } from './engines/moq/engine';

export { PlayerCore } from './core/player';
export type {
  PlaybackEngine,
  PlaybackSource,
  EngineFactory,
  EngineRegistry,
} from './core/player';
export { MoqEngine } from './engines/moq/engine';
export type { PlayerSource } from './engines/moq/engine';
export { SubtitleRenderer } from './subtitles/renderer';
export { mountControls } from './ui/controls';

/** Default distribution includes MoQ. Use PlayerCore for a custom engine set. */
export class ThePlayer extends PlayerCore {
  constructor(
    video: HTMLVideoElement,
    private readonly initialSource?: PlayerSource,
    engines: EngineRegistry = {
      moq: (video, source) => new MoqEngine(video, source),
    },
  ) {
    super(video, engines);
  }
  async init() {
    if (!this.initialSource)
      throw new Error('Supply a source or call load(source)');
    await this.load({ ...this.initialSource, protocol: 'moq' });
  }
}

/** Legacy low-level API; new integrations should use ThePlayer. */
export { MoqEngine as MoqPlayer } from './engines/moq/engine';
