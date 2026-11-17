import { VERSION } from '../version';

let keyboardOwner: HTMLElement | undefined;

/** In-video controls shared by the playground and standalone embed. No timeline for live TV. */
export function mountControls(
  screen: HTMLElement,
  video: HTMLVideoElement,
  getPlayer: () => any,
  report: (message: string) => void,
) {
  // The existing ThePlayer mark, inline so embeds do not need an asset URL.
  const brand =
    '<span class="player-brand"><svg viewBox="0 0 256 256" aria-hidden="true"><path d="M42 48h148v32h-58v128H98V80H42zM150 100l70 44-70 44z" fill="currentColor"/><path d="M42 112h28m-28 32h18m-18 32h28" stroke="currentColor" stroke-width="8" stroke-linecap="round" opacity=".55"/></svg><strong>ThePlayer</strong></span>';
  const version = `<small class="player-version">v${VERSION}</small>`;
  const originalChildren = new Set(screen.children);
  const abort = new AbortController();
  const listen = (
    target: EventTarget,
    type: string,
    handler: (event: any) => void,
  ) => target.addEventListener(type, handler, { signal: abort.signal });
  const icons = {
    quality:
      '<rect class="stroke" x="1" y="5" width="22" height="14" rx="3"/><text id="quality-badge" x="12" y="15" text-anchor="middle" class="quality-badge">—</text>',
    back: '<path class="stroke" d="M5 8a8 8 0 1 1-1 7M5 3v5h5"/><text x="12" y="15" text-anchor="middle" class="skip-number">10</text>',
    forward:
      '<path class="stroke" d="M19 8a8 8 0 1 0 1 7m-1-12v5h-5"/><text x="12" y="15" text-anchor="middle" class="skip-number">10</text>',
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
  <div id="audio-only-label" class="audio-only-label" hidden>Audio only</div>
  <div class="center-controls" role="group" aria-label="Quick playback controls">
   <button id="skip-back" class="icon-button center-button" title="Back 10 seconds (←)" aria-label="Back 10 seconds">${svg('back')}</button>
   <button id="center-play" class="icon-button center-button center-play" title="Play / Pause (Space)" aria-label="Play">${svg('play')}</button>
   <button id="skip-forward" class="icon-button center-button" title="Forward 10 seconds (→)" aria-label="Forward 10 seconds">${svg('forward')}</button>
   <span id="seek-feedback" class="seek-feedback" role="status" aria-live="polite"></span>
  </div>
  <div class="video-controls" role="group" aria-label="Playback controls">
   <button id="play-toggle" class="icon-button" title="Play (K)" aria-label="Play">${svg('play')}</button>
   <button id="mute-toggle" class="icon-button" title="Unmute (M)" aria-label="Unmute">${svg('muted')}</button>
   <input id="volume" class="volume-slider" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
   <span id="playback-time" class="playback-time" hidden></span><input id="seek-bar" class="seek-bar" type="range" min="0" max="0" step="any" value="0" aria-label="Playback position" hidden/><span id="control-spacer" class="control-spacer"></span>
   <button id="quality-toggle" class="icon-button" title="Quality" aria-label="Quality" aria-expanded="false" aria-controls="quality-menu" disabled>${svg('quality')}<span class="quality-copy"><span id="quality-mode">Auto</span><span id="quality-resolution">—</span></span></button>
   <button id="audio-toggle" class="icon-button" title="Audio language" aria-label="Audio language" aria-expanded="false" aria-controls="audio-menu" disabled>${svg('audio')}</button>
   <button id="cc-toggle" class="icon-button" title="Subtitles (C)" aria-label="Subtitles" aria-expanded="false" aria-controls="cc-menu" disabled>${svg('cc')}</button>
   <button id="info-toggle" class="icon-button" title="Player options" aria-label="Player options" aria-haspopup="menu" aria-expanded="false">${svg('more')}</button>
   <button id="fullscreen" class="icon-button" title="Fullscreen (F)" aria-label="Fullscreen">${svg('fullscreen')}</button>
  </div>
  <div id="cc-menu" class="video-popup track-menu" hidden><strong>Subtitles</strong><select id="subtitle-select" hidden aria-hidden="true"><option value="">Off</option></select><div class="track-options" role="menu" aria-label="Subtitle tracks"></div></div>
  <div id="quality-menu" class="video-popup track-menu" hidden><strong>Quality</strong><div class="track-options" role="menu" aria-label="Quality levels"></div></div>
  <div id="audio-menu" class="video-popup track-menu" hidden><strong>Audio language</strong><div class="track-options" role="menu" aria-label="Audio tracks"></div></div>
  <div id="player-menu" class="video-popup context-menu" role="menu" aria-label="Player options" hidden><div class="context-brand">${brand}${version}</div><button id="stats-toggle" role="menuitemcheckbox" aria-checked="false">mediainfo</button></div>
  <section id="stats-overlay" class="stats-overlay" aria-label="mediainfo" hidden>
   <div class="stats-title">${brand}${version}<span>mediainfo</span><button id="stats-close" aria-label="Close stats" title="Close stats">×</button></div>
   <dl><dt>Quality</dt><dd id="stats-quality">—</dd><dt>Resolution</dt><dd id="stats-resolution">—</dd><dt>Frames / dropped</dt><dd><span id="frames">0</span> / <span id="dropped">0</span></dd>
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
  const quality = el('quality-toggle'),
    qualityMenu = el('quality-menu');
  let hideTimer: ReturnType<typeof setTimeout>;
  let previous: any = null;
  let feedbackTimer: ReturnType<typeof setTimeout>;
  keyboardOwner ??= screen;
  screen.tabIndex = 0;
  screen.setAttribute('aria-label', 'Video player');
  const closeMenus = () => {
    qualityMenu.hidden = true;
    quality.setAttribute('aria-expanded', 'false');
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
        qualityMenu.hidden &&
        menu.hidden &&
        !screen.querySelector(
          '.video-controls:focus-within, .center-controls:focus-within, .live-indicator:focus-visible',
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
    play.title = video.paused ? 'Play (Space / K)' : 'Pause (Space / K)';
    el('center-play').innerHTML = svg(video.paused ? 'play' : 'pause');
    el('center-play').setAttribute(
      'aria-label',
      video.paused ? 'Play' : 'Pause',
    );
    mute.innerHTML = svg(
      video.muted || video.volume === 0 ? 'muted' : 'volume',
    );
    mute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    mute.title = video.muted ? 'Unmute (M)' : 'Mute (M)';
    volume.value = String(video.muted ? 0 : video.volume);
    showControls();
  }
  play.onclick = () => void togglePlay();
  el('center-play').onclick = () => void togglePlay();
  listen(video, 'click', () => {
    screen.focus({ preventScroll: true });
    void togglePlay();
  });
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
    if (container.closest('#quality-menu')) {
      text.className = 'quality-option-label';
      const [primary, secondary] = label.split(' · ');
      const first = document.createElement('span'),
        second = document.createElement('span');
      first.className = value === '-1' ? 'quality-mode' : 'quality-resolution';
      second.className =
        value === '-1' ? 'quality-resolution' : 'quality-bitrate';
      first.textContent = primary;
      second.textContent = secondary ?? '';
      text.replaceChildren(first, second);
    }
    button.append(mark, text);
    if (format) {
      const badge = document.createElement('span');
      badge.className = 'caption-format';
      const names: Record<string, string> = {
        dvb: 'DVB bitmap subtitles',
        teletext: 'Teletext subtitles',
        'cea-708': 'CEA-708 closed captions',
        'cea-608': 'CEA-608 closed captions',
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
  const qualityName = (p: any) => {
    const level = p?.qualityLevels?.[p.currentQuality];
    return level?.resolution
      ? `${level.resolution.split('x')[1]}p`
      : (level?.label ?? '—');
  };
  quality.onclick = () => {
    const open = qualityMenu.hidden;
    closeMenus();
    const p = getPlayer(),
      list = qualityMenu.querySelector<HTMLElement>('.track-options')!;
    list.replaceChildren();
    for (const level of [...(p?.qualityLevels ?? [])].sort(
      (a, b) =>
        (Number(b.resolution?.split('x')[1]) || 0) -
          (Number(a.resolution?.split('x')[1]) || 0) ||
        b.bandwidth - a.bandwidth,
    ))
      option(
        list,
        String(level.id),
        level.label,
        !p.autoQuality && p.selectedQuality === level.id,
        async () => {
          for (const button of list.querySelectorAll('button'))
            button.disabled = true;
          try {
            await p.selectQuality(level.id);
            syncQuality();
            closeMenus();
            quality.focus();
          } catch (e: any) {
            if (p === getPlayer()) report(e.message);
            closeMenus();
          }
        },
      );
    if (p?.qualityLevels?.length)
      option(
        list,
        '-1',
        `Auto · ${qualityName(p)}`,
        p.autoQuality,
        async () => {
          await p.selectQuality(-1);
          syncQuality();
          closeMenus();
          quality.focus();
        },
      );
    for (const mode of p?.availableMediaModes ?? []) {
      if (mode === p.mediaMode) continue;
      option(
        list,
        'media-' + mode,
        mode === 'audio' ? 'Audio only' : 'Video',
        false,
        async () => {
          for (const button of list.querySelectorAll('button'))
            button.disabled = true;
          try {
            await p.selectMediaMode(mode);
          } catch (e: any) {
            report(e.message);
          }
          closeMenus();
        },
      );
    }
    qualityMenu.hidden = !open;
    quality.setAttribute('aria-expanded', String(open));
    showControls();
    if (open)
      qualityMenu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };
  for (const panel of [ccMenu, audioMenu, qualityMenu])
    listen(panel, 'keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(e.key))
        return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        closeMenus();
        (panel === qualityMenu
          ? quality
          : panel === ccMenu
            ? cc
            : audio
        ).focus();
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
        '#quality-menu,#quality-toggle,#cc-menu,#cc-toggle,#audio-menu,#audio-toggle,#player-menu,#info-toggle',
      )
    )
      closeMenus();
  });
  listen(screen, 'pointerenter', () => {
    keyboardOwner = screen;
    showControls();
  });
  listen(screen, 'pointerdown', () => {
    keyboardOwner = screen;
  });
  listen(screen, 'pointermove', showControls);
  listen(screen, 'focusin', () => {
    keyboardOwner = screen;
    showControls();
  });
  listen(screen, 'pointerleave', () => {
    if (
      !video.paused &&
      ccMenu.hidden &&
      audioMenu.hidden &&
      qualityMenu.hidden &&
      menu.hidden
    )
      screen.classList.add('controls-hidden');
  });
  listen(document, 'keydown', (e) => {
    if (
      keyboardOwner !== screen ||
      !getPlayer() ||
      e.defaultPrevented ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey
    )
      return;
    const target = e.target as HTMLElement;
    if (target !== document.body && !screen.contains(target)) return;
    if (
      target.closest(
        'input,select,textarea,[contenteditable="true"],[role="textbox"]',
      )
    )
      return;
    if (
      target.closest('.video-popup') &&
      [' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(e.key)
    )
      return;
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
    if (e.target !== screen && e.key === 'Enter') return;
    switch (e.key.toLowerCase()) {
      case ' ':
      case 'k':
        e.preventDefault();
        if (!e.repeat) void togglePlay();
        break;
      case 'arrowleft':
        e.preventDefault();
        skipBy(-10);
        break;
      case 'arrowright':
        e.preventDefault();
        skipBy(10);
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
  function seekBounds() {
    const p = getPlayer();
    if (!p || !video.readyState) return;
    if (!p.isLive && Number.isFinite(video.duration))
      return { start: 0, end: video.duration };
    const ranges = p.protocol === 'hls' ? video.seekable : video.buffered;
    if (!ranges.length) return;
    const start = ranges.start(0),
      end = ranges.end(ranges.length - 1) - 0.1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return;
    return { start, end };
  }
  function skipBy(seconds: number) {
    const bounds = seekBounds();
    if (!bounds) return;
    const target = Math.max(
      bounds.start,
      Math.min(bounds.end, video.currentTime + seconds),
    );
    const delta = target - video.currentTime;
    video.currentTime = target;
    el('seek-feedback').textContent =
      `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(Math.abs(delta) < 9.9 ? 1 : 0)} s`;
    el('seek-feedback').classList.add('visible');
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(
      () => el('seek-feedback').classList.remove('visible'),
      900,
    );
    showControls();
  }
  el('skip-back').onclick = () => skipBy(-10);
  el('skip-forward').onclick = () => skipBy(10);
  const seek = el('seek-bar') as HTMLInputElement;
  seek.oninput = () => {
    video.currentTime = Number(seek.value);
  };
  const clock = (seconds: number) => {
    const n = Math.max(0, Math.floor(seconds));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  };
  function syncQuality() {
    const p = getPlayer();
    el('audio-only-label').hidden = p?.mediaMode !== 'audio';
    const qualityLabel = p?.qualityLevels?.length
      ? `${p.autoQuality ? 'Auto · ' : ''}${qualityName(p)}`
      : '—';
    el('stats-quality').textContent = qualityLabel;
    quality.classList.toggle('unavailable', !p?.qualityLevels?.length);
    el('quality-mode').textContent = p?.autoQuality ? 'Auto' : 'Quality';
    el('quality-resolution').textContent = p?.qualityLevels?.length
      ? qualityName(p)
      : '—';
    const level = p?.qualityLevels?.[p.currentQuality];
    const height =
      video.videoHeight || Number(level?.resolution?.split('x')[1]) || 0;
    el('quality-badge').textContent =
      p?.mediaMode === 'audio'
        ? '♪'
        : height >= 4320
          ? '8K'
          : height >= 2160
            ? '4K'
            : height >= 1440
              ? 'QHD'
              : height >= 1080
                ? 'FHD'
                : height >= 720
                  ? 'HD'
                  : height > 0
                    ? 'SD'
                    : '—';
    quality.title = `Quality: ${qualityLabel}`;
    const autoOption =
      qualityMenu.querySelector<HTMLElement>('[data-track="-1"]');
    if (autoOption) {
      autoOption.querySelector('.quality-resolution')!.textContent =
        qualityName(p);
      autoOption.setAttribute('aria-checked', String(p?.autoQuality));
      autoOption.firstElementChild!.textContent = p?.autoQuality ? '✓' : '';
    }
  }
  const statsTimer = setInterval(() => {
    (quality as HTMLButtonElement).disabled =
      (getPlayer()?.qualityLevels?.length ?? 0) < 2 &&
      (getPlayer()?.availableMediaModes?.length ?? 0) < 2;
    (audio as HTMLButtonElement).disabled = !getPlayer()?.audioTracks?.length;
    const p = getPlayer(),
      q = video.getVideoPlaybackQuality(),
      d = p?.diagnostics;
    syncQuality();
    const bounds = seekBounds();
    (el('skip-back') as HTMLButtonElement).disabled =
      !bounds || video.currentTime <= bounds.start + 0.1;
    (el('skip-forward') as HTMLButtonElement).disabled =
      !bounds || video.currentTime >= bounds.end - 0.1;
    audio.title = p?.audioTracks?.length
      ? 'Audio language'
      : 'No alternate audio tracks';
    cc.title = p?.subtitleTracks?.length
      ? 'Subtitles (C)'
      : 'No subtitles available';
    el('live-button').hidden = !p?.isLive;
    seek.hidden = !p || p.isLive;
    el('playback-time').hidden = seek.hidden;
    el('control-spacer').hidden = !seek.hidden;
    if (!seek.hidden) {
      seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
      seek.value = String(video.currentTime);
      el('playback-time').textContent =
        `${clock(video.currentTime)} / ${clock(Number.isFinite(video.duration) ? video.duration : 0)}`;
    }
    el('frames').textContent =
      p?.mediaMode === 'audio'
        ? '—'
        : q.totalVideoFrames.toLocaleString('en-US');
    el('dropped').textContent =
      p?.mediaMode === 'audio' ? '—' : String(q.droppedVideoFrames);
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
      clearTimeout(feedbackTimer);
      if (keyboardOwner === screen) keyboardOwner = undefined;
      clearInterval(statsTimer);
      for (const child of Array.from(screen.children))
        if (!originalChildren.has(child)) child.remove();
      screen.classList.remove('controls-hidden');
    },
  };
}
