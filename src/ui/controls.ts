/** In-video controls shared by the playground and standalone embed. No timeline for live TV. */
export function mountControls(
  screen: HTMLElement,
  video: HTMLVideoElement,
  getPlayer: () => any,
  report: (message: string) => void,
) {
  const originalChildren = new Set(screen.children);
  const abort = new AbortController();
  const listen = (
    target: EventTarget,
    type: string,
    handler: (event: any) => void,
  ) => target.addEventListener(type, handler, { signal: abort.signal });
  const icons = {
    audio:
      '<path class="stroke" d="M4 14v-3a8 8 0 0 1 16 0v3M4 12H2v7h5v-7zm16 0h2v7h-5v-7z"/>',
    play: '<path d="m9 5 11 7-11 7z"/>',
    pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
    volume:
      '<path d="m11 5-6 4H2v6h3l6 4z"/><path class="stroke" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    muted:
      '<path d="m11 5-6 4H2v6h3l6 4z"/><path class="stroke" d="m16 9 6 6m0-6-6 6"/>',
    fullscreen:
      '<path class="stroke" d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
    cc: '<rect class="stroke" x="2" y="5" width="20" height="14" rx="3"/><path class="stroke" d="M10 9H7v6h3m8-6h-3v6h3"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  };
  const svg = (name: keyof typeof icons) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  screen.insertAdjacentHTML(
    'beforeend',
    `
  <button id="live-button" hidden class="live-indicator" title="Return to live" aria-label="Return to live"><span></span>LIVE</button>
  <div class="video-controls" role="group" aria-label="Playback controls">
   <button id="play-toggle" class="icon-button" title="Play (K)" aria-label="Play">${svg('play')}</button>
   <button id="mute-toggle" class="icon-button" title="Unmute (M)" aria-label="Unmute">${svg('muted')}</button>
   <input id="volume" class="volume-slider" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
   <input id="seek-bar" class="seek-bar" type="range" min="0" max="0" step="0.1" value="0" aria-label="Playback position" hidden/><span id="playback-time" class="playback-time" hidden></span><span class="control-spacer"></span>
   <button id="audio-toggle" class="icon-button" title="Audio language" aria-label="Audio language" aria-expanded="false" aria-controls="audio-menu" disabled>${svg('audio')}</button>
   <button id="cc-toggle" class="icon-button" title="Subtitles (C)" aria-label="Subtitles" aria-expanded="false" aria-controls="cc-menu" disabled>${svg('cc')}</button>
   <button id="info-toggle" class="icon-button" title="Player options" aria-label="Player options" aria-haspopup="menu" aria-expanded="false">${svg('more')}</button>
   <button id="fullscreen" class="icon-button" title="Fullscreen (F)" aria-label="Fullscreen">${svg('fullscreen')}</button>
  </div>
  <div id="cc-menu" class="video-popup track-menu" hidden><strong>Subtitles</strong><select id="subtitle-select" hidden aria-hidden="true"><option value="">Off</option></select><div class="track-options" role="menu" aria-label="Subtitle tracks"></div></div>
  <div id="audio-menu" class="video-popup track-menu" hidden><strong>Audio language</strong><div class="track-options" role="menu" aria-label="Audio tracks"></div></div>
  <div id="player-menu" class="video-popup context-menu" role="menu" aria-label="Player options" hidden><button id="stats-toggle" role="menuitemcheckbox" aria-checked="false">mediainfo</button></div>
  <section id="stats-overlay" class="stats-overlay" aria-label="mediainfo" hidden>
   <div class="stats-title"><strong>mediainfo</strong><button id="stats-close" aria-label="Close stats" title="Close stats">×</button></div>
   <dl><dt>Resolution</dt><dd id="stats-resolution">—</dd><dt>Frames / dropped</dt><dd><span id="frames">0</span> / <span id="dropped">0</span></dd>
   <dt>Buffer health</dt><dd><span id="buffer">0.00</span> s <span id="buffer-detail">· cache reserve</span></dd>
   <dt>Received payload</dt><dd><span id="bitrate">—</span> Mb/s</dd><dt>First picture</dt><dd id="stats-first-picture">—</dd><dt>4 s reserve ready</dt><dd id="stats-reserve-ready">—</dd><dt>Media objects</dt><dd id="stats-objects">0</dd>
   <dt title="Received subtitle messages, including clears, refreshes and cached events. Counters reset on channel connect.">Received events</dt><dd id="cue-count">0</dd><dt title="Nonempty subtitle appearances drawn on the video. Unchanged refreshes and redraws are not counted again.">Displayed subtitles</dt><dd id="subtitle-displayed">0</dd><dt>Transport</dt><dd id="stats-transport">—</dd>
   <dt>Playback</dt><dd id="stats-state">idle</dd><dt>Codecs</dt><dd id="stats-codecs">—</dd><dt>Source</dt><dd id="stats-namespace">—</dd></dl><pre id="details" hidden></pre>
  </section>`,
  );
  const el = (id: string) => screen.querySelector<HTMLElement>('#' + id)!;
  const play = el('play-toggle'),
    mute = el('mute-toggle'),
    volume = el('volume') as HTMLInputElement,
    cc = el('cc-toggle'),
    ccMenu = el('cc-menu'),
    menu = el('player-menu'),
    options = el('info-toggle'),
    stats = el('stats-overlay');
  const audio = el('audio-toggle'),
    audioMenu = el('audio-menu');
  let hideTimer: ReturnType<typeof setTimeout>;
  let previous: any = null;
  screen.tabIndex = 0;
  screen.setAttribute('aria-label', 'Video player');
  const closeMenus = () => {
    ccMenu.hidden = true;
    audioMenu.hidden = true;
    audio.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    cc.setAttribute('aria-expanded', 'false');
    options.setAttribute('aria-expanded', 'false');
  };
  function showControls() {
    screen.classList.remove('controls-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (
        !video.paused &&
        ccMenu.hidden &&
        audioMenu.hidden &&
        menu.hidden &&
        !screen.querySelector(
          '.video-controls:focus-within, .live-indicator:focus-visible',
        )
      )
        screen.classList.add('controls-hidden');
    }, 3000);
  }
  async function togglePlay() {
    try {
      if (video.paused) {
        if (getPlayer()) await getPlayer().play();
        else await video.play();
      } else video.pause();
    } catch (e: any) {
      report(e.message);
    }
  }
  function sync() {
    play.innerHTML = svg(video.paused ? 'play' : 'pause');
    play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    play.title = video.paused ? 'Play (K)' : 'Pause (K)';
    mute.innerHTML = svg(
      video.muted || video.volume === 0 ? 'muted' : 'volume',
    );
    mute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    mute.title = video.muted ? 'Unmute (M)' : 'Mute (M)';
    volume.value = String(video.muted ? 0 : video.volume);
    showControls();
  }
  play.onclick = () => void togglePlay();
  listen(video, 'click', () => void togglePlay());
  mute.onclick = () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 1;
  };
  volume.oninput = () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
  };
  for (const e of ['play', 'pause', 'volumechange']) listen(video, e, sync);
  const select = el('subtitle-select') as HTMLSelectElement;
  function option(
    container: HTMLElement,
    value: string,
    label: string,
    checked: boolean,
    choose: () => void,
    format?: string,
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'menuitemradio';
    button.dataset.track = value;
    button.setAttribute('aria-checked', String(checked));
    const mark = document.createElement('span');
    mark.className = 'track-check';
    mark.textContent = checked ? '✓' : '';
    const text = document.createElement('span');
    text.textContent = label;
    button.append(mark, text);
    if (format) {
      const badge = document.createElement('span');
      badge.className = 'caption-format';
      const names: Record<string, string> = {
        dvb: 'DVB bitmap subtitles',
        teletext: 'Teletext subtitles',
        'cea-708': 'CEA-708 closed captions',
      };
      badge.title = names[format] ?? format;
      badge.setAttribute('aria-label', badge.title);
      const glyph =
        format === 'dvb'
          ? 'DVB'
          : format === 'teletext'
            ? 'TXT'
            : format === 'webvtt'
              ? 'VTT'
              : 'CC';
      const inner = `<text x="16" y="15" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-size="${glyph === 'CC' ? 12 : 9}" font-weight="700">${glyph}</text>`;
      badge.innerHTML = `<svg viewBox="0 0 32 22" aria-hidden="true"><rect x="1" y="1" width="30" height="20" rx="4" fill="none" stroke="currentColor" stroke-width="1.5"/>${inner}</svg>`;
      button.append(badge);
    }
    button.onclick = choose;
    container.append(button);
  }
  function renderSubtitles() {
    const list = ccMenu.querySelector<HTMLElement>('.track-options')!;
    list.replaceChildren();
    for (const o of select.options)
      option(
        list,
        o.value,
        o.text,
        select.value === o.value,
        () => {
          select.value = o.value;
          select.dispatchEvent(new Event('change'));
          renderSubtitles();
        },
        o.dataset.format,
      );
  }
  const observer = new MutationObserver(renderSubtitles);
  observer.observe(select, {
    childList: true,
    subtree: true,
  });
  listen(select, 'change', () => {
    cc.classList.toggle('selected', !!select.value);
    closeMenus();
    cc.focus();
  });
  cc.onclick = () => {
    const open = ccMenu.hidden;
    closeMenus();
    renderSubtitles();
    ccMenu.hidden = !open;
    cc.setAttribute('aria-expanded', String(open));
    showControls();
    if (open)
      ccMenu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };
  function renderAudio() {
    const p = getPlayer(),
      list = audioMenu.querySelector<HTMLElement>('.track-options')!;
    list.replaceChildren();
    for (const t of p?.audioTracks ?? []) {
      let language = t.language ?? 'und';
      try {
        language =
          new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ??
          language;
      } catch {}
      const peers = p.audioTracks.filter(
        (other: any) =>
          other.language === t.language && other.label === t.label,
      );
      const suffix = peers.length > 1 ? ' ' + (peers.indexOf(t) + 1) : '';
      const label = `${language === 'und' ? 'Unknown' : language}${suffix}${t.label ? ' · ' + t.label : ''}`;
      option(list, t.name, label, p.selectedAudioTrack === t.name, async () => {
        for (const b of list.querySelectorAll('button')) b.disabled = true;
        try {
          await p.selectAudioTrack(t.name);
          closeMenus();
          audio.focus();
        } catch (e: any) {
          if (p === getPlayer()) report(e.message);
        } finally {
          renderAudio();
        }
      });
    }
  }
  audio.onclick = () => {
    const open = audioMenu.hidden;
    closeMenus();
    renderAudio();
    audioMenu.hidden = !open;
    audio.setAttribute('aria-expanded', String(open));
    showControls();
    if (open)
      audioMenu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };
  for (const panel of [ccMenu, audioMenu])
    listen(panel, 'keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(e.key))
        return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        closeMenus();
        (panel === ccMenu ? cc : audio).focus();
        return;
      }
      const buttons = Array.from(
        panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? buttons.length - 1
            : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
              buttons.length;
      buttons[next]?.focus();
    });
  function openMenu(x?: number, y?: number) {
    closeMenus();
    menu.hidden = false;
    menu.style.left =
      x == null
        ? 'auto'
        : Math.max(8, Math.min(x, screen.clientWidth - menu.offsetWidth - 8)) +
          'px';
    menu.style.top =
      y == null
        ? 'auto'
        : Math.max(
            8,
            Math.min(y, screen.clientHeight - menu.offsetHeight - 8),
          ) + 'px';
    menu.style.right = x == null ? '48px' : 'auto';
    menu.style.bottom = y == null ? '60px' : 'auto';
    options.setAttribute('aria-expanded', 'true');
    showControls();
    el('stats-toggle').focus();
  }
  options.onclick = () => {
    if (menu.hidden) openMenu();
    else closeMenus();
  };
  listen(screen, 'contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('input,select')) return;
    e.preventDefault();
    const box = screen.getBoundingClientRect();
    openMenu(e.clientX - box.left, e.clientY - box.top);
  });
  function showStats(show: boolean) {
    stats.hidden = !show;
    el('stats-toggle').setAttribute('aria-checked', String(show));
    closeMenus();
  }
  el('stats-toggle').onclick = () => {
    showStats(stats.hidden === true);
    screen.focus();
  };
  el('stats-close').onclick = () => showStats(false);
  el('fullscreen').onclick = async () => {
    try {
      if (document.fullscreenElement === screen)
        await document.exitFullscreen();
      else await screen.requestFullscreen();
    } catch (e: any) {
      report(e.message);
    }
  };
  listen(document, 'fullscreenchange', () => {
    const full = document.fullscreenElement === screen;
    el('fullscreen').setAttribute(
      'aria-label',
      full ? 'Exit fullscreen' : 'Fullscreen',
    );
    el('fullscreen').title = full ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
  });
  listen(document, 'pointerdown', (e) => {
    if (
      !(e.target as HTMLElement).closest(
        '#cc-menu,#cc-toggle,#audio-menu,#audio-toggle,#player-menu,#info-toggle',
      )
    )
      closeMenus();
  });
  listen(screen, 'pointermove', showControls);
  listen(screen, 'focusin', showControls);
  listen(screen, 'pointerleave', () => {
    if (!video.paused && ccMenu.hidden && audioMenu.hidden && menu.hidden)
      screen.classList.add('controls-hidden');
  });
  listen(screen, 'keydown', (e) => {
    if ((e.target as HTMLElement).matches('input,select')) return;
    if (e.key === 'Escape') {
      closeMenus();
      showStats(false);
      return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (e.target !== screen && [' ', 'Enter'].includes(e.key)) return;
    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k':
        e.preventDefault();
        void togglePlay();
        break;
      case 'm':
        mute.click();
        break;
      case 'f':
        el('fullscreen').click();
        break;
      case 'c':
        if (!cc.hasAttribute('disabled')) cc.click();
        break;
    }
  });
  const seek = el('seek-bar') as HTMLInputElement;
  seek.oninput = () => {
    video.currentTime = Number(seek.value);
  };
  const clock = (seconds: number) => {
    const n = Math.max(0, Math.floor(seconds));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  const statsTimer = setInterval(() => {
    (audio as HTMLButtonElement).disabled = !getPlayer()?.audioTracks?.length;
    const p = getPlayer(),
      q = video.getVideoPlaybackQuality(),
      d = p?.diagnostics;
    el('live-button').hidden = !p?.isLive;
    seek.hidden = !p || p.isLive;
    el('playback-time').hidden = seek.hidden;
    if (!seek.hidden) {
      seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
      seek.value = String(video.currentTime);
      el('playback-time').textContent =
        `${clock(video.currentTime)} / ${clock(Number.isFinite(video.duration) ? video.duration : 0)}`;
    }
    el('frames').textContent = q.totalVideoFrames.toLocaleString('en-US');
    el('dropped').textContent = String(q.droppedVideoFrames);
    el('stats-resolution').textContent = video.videoWidth
      ? `${video.videoWidth} × ${video.videoHeight}`
      : '—';
    let ahead = 0;
    for (let i = 0; i < video.buffered.length; i++)
      if (
        video.currentTime >= video.buffered.start(i) &&
        video.currentTime <= video.buffered.end(i)
      )
        ahead = video.buffered.end(i) - video.currentTime;
    el('buffer').textContent = ahead.toFixed(2);
    el('buffer-detail').textContent = d?.buffer?.target
      ? `· target ${d.buffer.target.toFixed(1)} s${d.buffer.gop != null ? ' · GOP ' + d.buffer.gop.toFixed(1) + ' s' : ''}`
      : '';
    el('stats-first-picture').textContent =
      d?.startup?.firstFrameMs != null
        ? (d.startup.firstFrameMs / 1000).toFixed(2) + ' s'
        : '—';
    el('stats-reserve-ready').textContent =
      d?.startup?.reserveReadyMs != null
        ? (d.startup.reserveReadyMs / 1000).toFixed(2) + ' s'
        : '—';
    el('stats-objects').textContent = (d?.objects ?? 0).toLocaleString('en-US');
    el('stats-state').textContent =
      video.paused && d?.state === 'playing' ? 'paused' : (d?.state ?? 'idle');
    el('stats-transport').textContent =
      p?.protocol === 'moq'
        ? `WebTransport · ${d?.version ?? 'MoQ'}`
        : (p?.protocol ?? '—');
    el('stats-codecs').textContent =
      p?.catalog?.tracks?.map((t: any) => t.codec).join(' / ') ?? '—';
    el('stats-namespace').textContent =
      p?.source?.namespace ?? p?.source?.url ?? '—';
    const now = performance.now(),
      bytes = d?.bytes ?? 0;
    if (
      previous &&
      previous.player === p &&
      bytes >= previous.bytes &&
      now - previous.at >= 2000
    ) {
      el('bitrate').textContent = (
        ((bytes - previous.bytes) * 8) /
        (now - previous.at) /
        1000
      ).toFixed(2);
      previous = { player: p, bytes, at: now };
    }
    if (!previous || previous.player !== p) {
      previous = { player: p, bytes, at: now };
      el('bitrate').textContent = '—';
    }
  }, 500);
  sync();
  return {
    destroy() {
      abort.abort();
      observer.disconnect();
      clearTimeout(hideTimer);
      clearInterval(statsTimer);
      for (const child of Array.from(screen.children))
        if (!originalChildren.has(child)) child.remove();
      screen.classList.remove('controls-hidden');
    },
  };
}
