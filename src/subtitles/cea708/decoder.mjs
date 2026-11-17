import CaptionParser from '../../../vendor/mux.js/caption-parser.cjs';
import probe from 'mux.js/lib/mp4/probe.js';

// Decode CEA-708 carried in AVC SEI, preserving the video's absolute PTS domain.
// No HTTP fetches: these bytes are already delivered by the selected MoQ video track.
export class Cea708Decoder {
  constructor(initialization, services = {}) {
    this.ids = probe.videoTrackIds(initialization);
    this.timescales = probe.timescale(initialization);
    this.services = services;
    this.parser = new CaptionParser();
    this.parser.init({ captionServices: services });
    this.tracks = new Map();
    this.cues = new Map();
  }
  push(fragment) {
    const parsed = this.parser.parse(fragment, this.ids, this.timescales);
    const events = [];
    try {
      for (const c of parsed?.captions ?? []) {
        const match = /^cc708_([1-9][0-9]?)$/.exec(c.stream);
        if (!match || !c.snapshot || !Number.isFinite(c.startTime)) continue;
        const service = Number(match[1]);
        if (service > 63) continue;
        const name = 'cea708-' + service;
        const settings = this.services['SERVICE' + service] ?? {};
        const track = {
          name,
          service,
          format: 'cea-708',
          language: settings.language ?? 'und',
          label: settings.label ?? 'Service ' + service,
          inband: true,
        };
        this.tracks.set(name, track);
        // Plain text only. The canvas never interprets broadcast content as HTML.
        const cue = {
          pts: c.startTime,
          duration: 30,
          text: c.text.replace(/<\/?(?:i|u)>/g, '').slice(0, 8192),
          windows: c.windows ?? [],
          rects: [],
          width: 0,
          height: 0,
        };
        const history = this.cues.get(name) ?? [];
        history.push(cue);
        history.sort((a, b) => a.pts - b.pts);
        this.cues.set(name, history.slice(-200));
        events.push({ track, cue });
      }
    } finally {
      this.parser.clearParsedCaptions();
    }
    return events;
  }
  history(name) {
    return this.cues.get(name) ?? [];
  }
}
