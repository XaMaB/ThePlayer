import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({
  entryPoints: [new URL('../src/engines/hls/eme.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
});
const { EmeController } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(built.outputFiles[0].text).toString('base64')
);
const tick = () => new Promise((r) => setTimeout(r, 0));
const kid = Buffer.from('0123456789abcdef0123456789abcdef', 'hex').toString(
  'base64url',
);
const tracks = [
  {
    id: 1,
    kind: 'video',
    codec: 'avc1.42c00c',
    encryption: { scheme: 'cenc', kid: new Uint8Array(16) },
  },
];
class Session extends EventTarget {
  updates = [];
  closed = false;
  keyStatuses = new Map();
  async generateRequest() {
    const event = new Event('message');
    Object.assign(event, {
      message: new TextEncoder().encode(JSON.stringify({ kids: [kid] })).buffer,
      messageType: 'license-request',
    });
    this.dispatchEvent(event);
  }
  async update(bytes) {
    this.updates.push(JSON.parse(new TextDecoder().decode(bytes)));
  }
  async close() {
    this.closed = true;
  }
}
function setup() {
  const sessions = [],
    video = new EventTarget();
  video.mediaKeys = null;
  video.setMediaKeys = async (keys) => {
    video.mediaKeys = keys;
  };
  const keys = {
    createSession() {
      const s = new Session();
      sessions.push(s);
      return s;
    },
  };
  Object.defineProperty(navigator, 'requestMediaKeySystemAccess', {
    configurable: true,
    value: async () => ({ createMediaKeys: async () => keys }),
  });
  const encrypted = (value = 1) => {
    const e = new Event('encrypted');
    Object.assign(e, {
      initDataType: 'cenc',
      initData: Uint8Array.of(value).buffer,
    });
    video.dispatchEvent(e);
  };
  return { sessions, video, encrypted };
}
test('EME deduplicates initialization, supplies requested Clear Key and releases sessions/media keys', async () => {
  const { sessions, video, encrypted } = setup(),
    errors = [];
  const drm = new EmeController(
    video,
    {
      keySystem: 'org.w3.clearkey',
      clearKeys: {
        '0123456789abcdef0123456789abcdef': '39393939393939393939393939393939',
      },
    },
    (e) => errors.push(e),
  );
  await drm.ensure(tracks);
  encrypted();
  encrypted();
  await tick();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].updates[0].keys[0].kid, kid);
  assert.deepEqual(errors, []);
  await drm.destroy();
  assert.equal(sessions[0].closed, true);
  assert.equal(video.mediaKeys, null);
  encrypted(2);
  await tick();
  assert.equal(sessions.length, 1);
});
test('EME missing KID reports an error without submitting an unrelated key', async () => {
  const { sessions, video, encrypted } = setup(),
    errors = [];
  const drm = new EmeController(
    video,
    {
      keySystem: 'org.w3.clearkey',
      clearKeys: {
        '00000000000000000000000000000000': '39393939393939393939393939393939',
      },
    },
    (e) => errors.push(e),
  );
  await drm.ensure(tracks);
  encrypted();
  await tick();
  assert.match(errors[0].message, /No configured Clear Key/);
  assert.equal(sessions[0].updates.length, 0);
  await drm.destroy();
});
test('EME teardown aborts license callback and suppresses late updates/errors', async () => {
  const { sessions, video, encrypted } = setup(),
    errors = [];
  let resolve, signal;
  const drm = new EmeController(
    video,
    {
      keySystem: 'org.w3.clearkey',
      license: async (_message, _type, s) => {
        signal = s;
        return new Promise((r) => {
          resolve = r;
        });
      },
    },
    (e) => errors.push(e),
  );
  await drm.ensure(tracks);
  encrypted();
  await tick();
  assert.equal(signal.aborted, false);
  await drm.destroy();
  assert.equal(signal.aborted, true);
  resolve(new Uint8Array());
  await tick();
  assert.equal(sessions[0].updates.length, 0);
  assert.deepEqual(errors, []);
  assert.equal(video.mediaKeys, null);
});
test('EME validates clear-key configuration before opening a CDM', () => {
  const { video } = setup();
  assert.throws(
    () =>
      new EmeController(
        video,
        { keySystem: 'org.w3.clearkey', clearKeys: { bad: 'bad' } },
        () => {},
      ),
    /hexadecimal/,
  );
  assert.throws(
    () =>
      new EmeController(video, { keySystem: 'other', clearKeys: {} }, () => {}),
    /requires org.w3.clearkey/,
  );
  assert.throws(
    () => new EmeController(video, { keySystem: 'other' }, () => {}),
    /license callback/,
  );
});

test('EME bounds a stalled license callback and aborts its signal', async () => {
  const { video, encrypted } = setup(),
    errors = [];
  let signal;
  const drm = new EmeController(
    video,
    {
      keySystem: 'org.w3.clearkey',
      licenseTimeoutMs: 15,
      license: async (_message, _type, s) => {
        signal = s;
        return new Promise(() => {});
      },
    },
    (e) => errors.push(e),
  );
  await drm.ensure(tracks);
  encrypted();
  await new Promise((r) => setTimeout(r, 40));
  assert.match(errors[0].message, /timed out/);
  assert.equal(signal.aborted, true);
  await drm.destroy();
});

test('EME retires known unbuffered keys across more than 64 rotations and reacquires on rewind', async () => {
  const { sessions, video } = setup(),
    errors = [];
  const drm = new EmeController(
    video,
    {
      keySystem: 'org.w3.clearkey',
      license: async () => new TextEncoder().encode('{"keys":[]}'),
    },
    (e) => errors.push(e),
  );
  await drm.ensure(tracks);
  for (let n = 1; n <= 80; n++) {
    const id = new Uint8Array(16).fill(n);
    await drm.retainKeys(
      [{ ...tracks[0], encryption: { scheme: 'cenc', kid: id } }],
      n + 1,
      Math.max(0, n - 3),
    );
    await drm.requestInitData(Uint8Array.of(n));
    sessions.at(-1).keyStatuses.set(id.buffer, 'usable');
    await tick();
    assert.ok(sessions.filter((s) => !s.closed).length <= 33);
  }
  assert.equal(sessions.length, 80);
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions.at(-1).closed, false);
  sessions[0].keyStatuses.set(new Uint8Array(16).fill(1).buffer, 'expired');
  sessions[0].dispatchEvent(new Event('keystatuseschange'));
  await drm.retainKeys(
    [
      {
        ...tracks[0],
        encryption: { scheme: 'cenc', kid: new Uint8Array(16).fill(1) },
      },
    ],
    2,
    0,
  );
  await drm.requestInitData(Uint8Array.of(1));
  assert.equal(sessions.length, 81);
  await tick();
  assert.deepEqual(errors, []);
  await drm.destroy();
  assert.ok(sessions.every((s) => s.closed));
});
test('EME retains buffered keys and unknown sample-group keys', async () => {
  const { sessions, video } = setup();
  const drm = new EmeController(
    video,
    {
      keySystem: 'org.w3.clearkey',
      license: async () => new TextEncoder().encode('{"keys":[]}'),
    },
    () => {},
  );
  await drm.ensure(tracks);
  for (let n = 1; n <= 64; n++) {
    await drm.retainKeys(tracks, 100, 0);
    await drm.requestInitData(Uint8Array.of(n));
    sessions
      .at(-1)
      .keyStatuses.set(
        new Uint8Array(16).fill(n % 2 ? 0 : 255).buffer,
        'usable',
      );
    await tick();
  }
  await assert.rejects(drm.requestInitData(Uint8Array.of(65)), /Too many/);
  assert.ok(sessions.every((s) => !s.closed));
  await drm.retainKeys(tracks, 100, 110);
  assert.ok(sessions.filter((s, i) => i % 2 === 1).every((s) => !s.closed));
  await drm.destroy();
});
