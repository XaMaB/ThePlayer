import test from 'node:test';
import assert from 'node:assert/strict';
import { demoDrm, drmSnippet } from '../demo/drm.mjs';

test('demo DRM validates enabled settings and supports local Clear Key', () => {
  assert.equal(demoDrm({ keySystem: '', url: 'bad' }), undefined);
  const keys = {
    '0123456789abcdef0123456789abcdef': '39393939393939393939393939393939',
  };
  assert.deepEqual(
    demoDrm({ keySystem: 'org.w3.clearkey', keys: JSON.stringify(keys) })
      .clearKeys,
    keys,
  );
  for (const settings of [
    { url: 'file:///secret' },
    { url: 'https://user:pass@example.test' },
    { timeout: '-1' },
    { timeout: 'NaN' },
    { headers: '[]' },
    { headers: '{"x": 1}' },
    { certificate: 'not base64!' },
    { credentials: 'bad' },
    { keySystem: 'org.w3.clearkey', keys: '{}' },
    { keySystem: 'org.w3.clearkey', keys: '{"bad":"bad"}' },
  ])
    assert.throws(() =>
      demoDrm({
        keySystem: 'com.widevine.alpha',
        url: 'https://license.test',
        ...settings,
      }),
    );
});

test('demo DRM sends the binary challenge, headers, credentials and abort signal', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, ...init };
    return new Response(new Uint8Array([4, 5]));
  });
  const drm = demoDrm({
    keySystem: 'com.widevine.alpha',
    url: 'https://license.test',
    headers: '{"Authorization":"Bearer test"}',
    credentials: 'include',
    certificate: 'AQI=',
  });
  const controller = new AbortController();
  const challenge = new Uint8Array([1, 2, 3]);
  assert.deepEqual(
    await drm.license(challenge, 'license-request', controller.signal),
    new Uint8Array([4, 5]),
  );
  assert.equal(request.body, challenge);
  assert.equal(request.signal, controller.signal);
  assert.equal(request.headers.get('authorization'), 'Bearer test');
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'include');
  assert.deepEqual(drm.serverCertificate, new Uint8Array([1, 2]));
  const snippet = drmSnippet(
    { protocol: 'dash', url: 'https://media.test/a.mpd' },
    drm,
  );
  assert.ok(snippet.includes('source.drm.license = async'));
  assert.ok(!snippet.includes('Bearer test'));
  assert.ok(!snippet.includes('https://license.test'));
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('secret response', { status: 403 }),
  );
  await assert.rejects(
    drm.license(challenge, 'license-request', controller.signal),
    { message: 'License request failed (HTTP 403)' },
  );
});
