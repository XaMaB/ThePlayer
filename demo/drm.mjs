/** Demo-only adapter for binary EME license endpoints. No settings are persisted. */
export function demoDrm(settings) {
  if (!settings.keySystem) return undefined;
  const timeout = Number(settings.timeout || 15000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
    throw new Error('License timeout must be between 1 and 120000 ms');
  const options = {
    keySystem: settings.keySystem,
    licenseTimeoutMs: timeout,
    videoRobustness: settings.videoRobustness || undefined,
    audioRobustness: settings.audioRobustness || undefined,
  };
  if (settings.certificate) {
    try {
      const bytes = atob(settings.certificate.replace(/\s/g, ''));
      options.serverCertificate = Uint8Array.from(bytes, (c) =>
        c.charCodeAt(0),
      );
    } catch {
      throw new Error('Server certificate must be base64-encoded binary data');
    }
  }
  if (settings.keySystem === 'org.w3.clearkey' && settings.keys) {
    const keys = object(settings.keys, 'Clear Key keys');
    if (
      !Object.keys(keys).length ||
      Object.entries(keys).some(
        ([id, key]) =>
          !/^[a-f\d]{32}$/i.test(id) ||
          typeof key !== 'string' ||
          !/^[a-f\d]{32}$/i.test(key),
      )
    )
      throw new Error(
        'Clear Key requires 32-digit hexadecimal key IDs and keys',
      );
    options.clearKeys = keys;
    return options;
  }
  let url;
  try {
    url = new URL(settings.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    throw new Error(
      'Enter an HTTP(S) license server URL without embedded credentials',
    );
  }
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' });
  for (const [name, value] of Object.entries(
    object(settings.headers || '{}', 'License headers'),
  )) {
    if (typeof value !== 'string')
      throw new Error('License header values must be strings');
    headers.set(name, value);
  }
  const credentials = settings.credentials || 'omit';
  if (!['omit', 'same-origin', 'include'].includes(credentials))
    throw new Error('Invalid license credentials mode');
  options.license = async (message, _type, signal) => {
    const response = await fetch(url.href, {
      method: 'POST',
      headers,
      body: message,
      credentials,
      signal,
    });
    if (!response.ok)
      throw new Error(`License request failed (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  return options;
}
function object(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${label} must be a JSON object`);
  return parsed;
}

export function readDrmForm(document) {
  const value = (id) => document.getElementById(id).value.trim();
  return demoDrm({
    keySystem: value('drm-system'),
    url: value('drm-url'),
    headers: value('drm-headers'),
    credentials: value('drm-credentials'),
    timeout: value('drm-timeout'),
    certificate: value('drm-certificate'),
    keys: value('drm-keys'),
    videoRobustness: value('drm-video-robustness'),
    audioRobustness: value('drm-audio-robustness'),
  });
}

/** Keep tokens and keys out of the visible/copied integration example. */
export function drmSnippet(source, drm) {
  const base = JSON.stringify(source, null, 2);
  if (!drm) return `await player.load(${base});`;
  const config = JSON.stringify(
    {
      keySystem: drm.keySystem,
      licenseTimeoutMs: drm.licenseTimeoutMs,
      videoRobustness: drm.videoRobustness,
      audioRobustness: drm.audioRobustness,
    },
    null,
    2,
  );
  return (
    `const source = ${base};\nsource.drm = ${config};\n` +
    (drm.serverCertificate
      ? '// Supply your certificate bytes as a Uint8Array.\nsource.drm.serverCertificate = serverCertificate;\n'
      : '') +
    (drm.clearKeys
      ? '// Supply your authorized test keys: { "hexKeyId": "hexKey" }.\nsource.drm.clearKeys = clearKeys;\n'
      : '// Supply licenseUrl, licenseHeaders and licenseCredentials in your application.\nsource.drm.license = async (message, type, signal) => {\n  const response = await fetch(licenseUrl, {\n    method: "POST", body: message, headers: licenseHeaders,\n    credentials: licenseCredentials, signal,\n  });\n  if (!response.ok) throw new Error(`License HTTP ${response.status}`);\n  return new Uint8Array(await response.arrayBuffer());\n};\n') +
    'await player.load(source);'
  );
}
