import { SubtitleRenderer } from '../src/subtitles/renderer';
import { mountControls } from '../src/ui/controls';
import { ThePlayer } from '../src/player';

const $ = (id: string) => document.getElementById(id)!;
const video = $('video') as HTMLVideoElement;
const canvas = $('subtitles') as HTMLCanvasElement;
mountControls(
  $('screen'),
  video,
  () => player,
  (message) => error(message),
);
const select = $('subtitle-select') as HTMLSelectElement;

const langs: Record<string, string> = {
  eng: 'English',
  ind: 'Indonesian',
  spa: 'Spanish',
  ara: 'Arabic',
  ben: 'Bengali',
  bul: 'Bulgarian',
  deu: 'German',
  fra: 'French',
  ita: 'Italian',
  und: 'Unknown',
};
let state: any;
let channel: any;
let player: any;
let client: any;
let activeNamespace = '';
let playing = false;
let opening = false;
let operation = 0;
const renderer = new SubtitleRenderer(
  video,
  canvas,
  updateSubtitleCounters,
  () => $('placeholder').hidden === true,
);
const subtitleCounters = renderer.counters;
let selectedLanguage = '';
let selectedChannelId = '';
let manual = false;
let connectedSource: any = null;
const diagnostics = {
  frames: 0,
  cuesReceived: 0,
  cuesRendered: 0,
  subtitleLanguage: '',
  errors: [] as string[],
};
(window as any).__moq = {
  diagnostics,
  video,
  get player() {
    return player;
  },
};
function error(message: string) {
  diagnostics.errors.push(message);
  diagnostics.errors = diagnostics.errors.slice(-20);
  $('player-message').textContent = message;
  $('retry').hidden = false;
  console.error(message);
}
function text(id: string, value: any) {
  $(id).textContent = String(value);
}
function updateSubtitleCounters() {
  diagnostics.cuesReceived = subtitleCounters.received;
  diagnostics.cuesRendered = subtitleCounters.displayed;
  text('cue-count', subtitleCounters.received);
  text('subtitle-displayed', subtitleCounters.displayed);
}

function escape(s: any) {
  const n = document.createElement('span');
  n.textContent = String(s ?? '—');
  return n.innerHTML;
}

async function stopSubtitles() {
  renderer.destroy();
}
async function chooseSubtitles() {
  selectedLanguage = select.value;
  diagnostics.subtitleLanguage = selectedLanguage;
  if (!client) return;
  try {
    client.selectSubtitleTrack(selectedLanguage);
  } catch (e: any) {
    error(e.message);
  }
}
select.addEventListener('change', () => void chooseSubtitles());

function updateSubtitleMenu(subs: any[]) {
  ($('cc-toggle') as HTMLButtonElement).disabled = subs.length === 0;
  select.innerHTML =
    '<option value="">Off</option>' +
    subs
      .map((s: any) => {
        const label = s.inband
          ? s.language && s.language !== 'und'
            ? (langs[s.language] ?? s.language) + ' · ' + s.label
            : s.label
          : (langs[s.language] ?? s.language);
        return `<option value="${escape(s.name)}" data-format="${escape(s.format)}">${escape(label)}</option>`;
      })
      .join('');
  select.value = selectedLanguage;
  selectedLanguage = select.value;
  diagnostics.subtitleLanguage = selectedLanguage;
  $('cc-toggle').classList.toggle('selected', !!selectedLanguage);
}

async function openChannel(next: any) {
  if (opening || !next.source || next.status !== 'live') return;
  opening = true;
  const token = ++operation;
  try {
    await stopSubtitles();
    await player?.destroy();
    if (token !== operation) return;
    player = null;
    client = null;
    channel = next;
    activeNamespace = next.namespace;
    playing = false;
    subtitleCounters.reset();
    updateSubtitleCounters();
    $('placeholder').hidden = false;
    $('retry').hidden = true;
    text('player-message', 'Connecting over WebTransport…');
    if (!('WebTransport' in window) || !window.isSecureContext)
      throw new Error(
        'A browser with WebTransport and HTTPS (or localhost) is required.',
      );
    player = new ThePlayer(video, {
      relayUrl: next.relayUrl,
      namespace: next.namespace,
      catalogTrack: next.catalogTrack,
      certificateHash: next.certificateHash ?? state?.certificateHash,
    });
    player.addEventListener('statechange', (e: any) => {
      if (token !== operation) return;
      text('playback-state', e.detail.toUpperCase());
      text(
        'transport-state',
        e.detail === 'playing' ? 'moq-dev · connected' : e.detail,
      );
    });
    player.addEventListener('error', (e: any) => {
      if (token !== operation) return;
      error(e.detail.message);
      activeNamespace = '';
    });
    player.addEventListener('autoplayblocked', () => {
      if (token !== operation) return;
      text('player-message', 'Press Play to start playback.');
      $('retry').hidden = false;
    });
    player.addEventListener('catalog', (e: any) => {
      if (token !== operation) return;
      updateSubtitleMenu(player.subtitleTracks);
      text(
        'details',
        JSON.stringify(
          {
            profile: e.detail.profile,
            tracks: e.detail.tracks,
            subtitles: player.subtitleTracks,
          },
          null,
          2,
        ),
      );
    });
    player.addEventListener('subtitletracks', (e: any) => {
      if (token === operation) updateSubtitleMenu(e.detail);
    });
    player.addEventListener('captionwarning', (e: any) => {
      if (token === operation) error(e.detail.message);
    });
    renderer.attach(player);
    await player.init();
    if (token !== operation) return;
    client = player;
    if (selectedLanguage) void chooseSubtitles();
  } catch (e: any) {
    if (token === operation) {
      error(e.message);
      activeNamespace = '';
    }
  } finally {
    if (token === operation) opening = false;
  }
}
video.addEventListener('playing', () => {
  playing = true;
  $('placeholder').hidden = true;
  $('retry').hidden = true;
});
video.addEventListener('error', () =>
  error(video.error?.message ?? 'Video decoder error'),
);
$('retry').addEventListener('click', () => {
  if (player && video.paused) void player.play();
  else if (channel) void openChannel(channel);
});
$('live-button').addEventListener('click', () => {
  if (video.buffered.length)
    video.currentTime = Math.max(
      video.buffered.start(video.buffered.length - 1),
      video.buffered.end(video.buffered.length - 1) -
        (player?.targetBuffer ?? 2.5),
    );
  void player?.play();
});

function sourceForm(next: any) {
  ($('relay-url') as HTMLInputElement).value = next.relayUrl;
  ($('namespace') as HTMLInputElement).value = next.namespace ?? '';
  ($('hash') as HTMLInputElement).value =
    next.certificateHash ?? state?.certificateHash ?? '';
  ($('catalog') as HTMLInputElement).value = next.catalogTrack ?? 'catalog';
  connectedSource = {
    relayUrl: next.relayUrl,
    namespace: next.namespace,
    catalogTrack: next.catalogTrack ?? 'catalog',
    certificateHash: next.certificateHash ?? state?.certificateHash,
  };
  text(
    'snippet',
    `import { ThePlayer } from './player.js';\n\nconst player = new ThePlayer(video, ${JSON.stringify(connectedSource, null, 2)});\nawait player.init();\n// await player.destroy();`,
  );
  text('channel-title', next.name ?? next.namespace);
}
$('source-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (opening) return;
  manual = true;
  selectedChannelId = '';
  const value = (id: string) => ($(id) as HTMLInputElement).value.trim();
  const next = {
    name: 'Custom source',
    status: 'live',
    source: true,
    relayUrl: value('relay-url'),
    namespace: value('namespace'),
    catalogTrack: value('catalog'),
    certificateHash: value('hash'),
  };
  try {
    if (new URL(next.relayUrl).protocol !== 'https:')
      throw new Error('WebTransport requires an https:// relay URL');
    if (next.certificateHash && !/^[a-fA-F0-9]{64}$/.test(next.certificateHash))
      throw new Error('SHA-256 fingerprint: 64 hexadecimal characters');
    sourceForm(next);
    void openChannel(next);
  } catch (e: any) {
    error(e.message);
  }
});
$('disconnect').addEventListener('click', async () => {
  manual = true;
  operation++;
  opening = true;
  await stopSubtitles();
  await player?.destroy();
  player = null;
  client = null;
  activeNamespace = '';
  playing = false;
  opening = false;
  text('playback-state', 'STOPPED');
  text('transport-state', 'Disconnected');
  text('player-message', 'Disconnected.');
  $('placeholder').hidden = false;
});
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('snippet').textContent ?? '');
    text('copy', 'Copied');
    setTimeout(() => text('copy', 'Copy'), 1800);
  } catch {
    error('Clipboard unavailable. Copy the example manually.');
  }
});
async function refresh() {
  try {
    const response = await fetch('/api/directory');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Directory unavailable');
    state = data;
    text('directory-message', data.error ?? '');
    text('channel-count', data.channels.length);
    $('channel-list').innerHTML = data.channels
      .map(
        (c: any) =>
          `<button class="channel ${selectedChannelId === c.id ? 'active' : ''}" data-id="${escape(c.id)}"><span class="letter">${escape(c.name[0])}</span><span class="name"><strong>${escape(c.name)}</strong><small>${escape(c.status)}</small></span><span>↗</span></button>`,
      )
      .join('');
    const connect = (c: any) => {
      manual = false;
      selectedChannelId = c.id;
      const next = {
        ...c,
        relayUrl: data.relayUrl,
        certificateHash: data.certificateHash,
        source: !!c.namespace,
      };
      sourceForm(next);
      void openChannel(next);
    };
    $('channel-list')
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const c = data.channels.find((c: any) => c.id === b.dataset.id);
            if (c) connect(c);
          }),
      );
    if (!manual && !opening) {
      const next =
        data.channels.find((c: any) => c.id === selectedChannelId) ??
        data.channels.find((c: any) => c.status === 'live');
      if (next && next.status === 'live' && next.namespace !== activeNamespace)
        connect(next);
    }
  } catch (e: any) {
    text(
      'directory-message',
      'Directory: ' + e.message + '. Manual connection is available.',
    );
  }
}
setInterval(() => {
  diagnostics.frames = video.getVideoPlaybackQuality().totalVideoFrames;
}, 500);
const query = new URLSearchParams(location.search);
if (query.has('relay') && query.has('namespace')) {
  manual = true;
  const next = {
    status: 'live',
    source: true,
    relayUrl: query.get('relay'),
    namespace: query.get('namespace'),
    certificateHash: query.get('hash') ?? '',
    catalogTrack: query.get('catalog') ?? 'catalog',
  };
  sourceForm(next);
  void openChannel(next);
}
if (!document.body.hasAttribute('data-embed')) {
  setInterval(() => void refresh(), 2000);
  void refresh();
}
Object.defineProperty(window, 'player', { get: () => player });
