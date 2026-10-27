import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPublicUrl, isPrivateAddress, safeDownloadToTmp, UnsafeUrlError, MAX_REDIRECTS,
} from '../src/media/safeUrl.js';

// Niciun apel de rețea real: DNS și fetch sunt mock-uri.
const publicDns = async () => [{ address: '93.184.216.34' }];
const privateDns = (addr: string) => async () => [{ address: addr }];

function videoResponse(bytes: number, extraHeaders: Record<string, string> = {}) {
  const body = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4', ...extraHeaders } });
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}

test('non-http protocols and embedded credentials are rejected', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/a.mp4', 'gopher://example.com/', 'https://user:pw@example.com/a.mp4']) {
    await assert.rejects(assertPublicUrl(u, publicDns), UnsafeUrlError, u);
  }
});

test('non-default ports are rejected', async () => {
  await assert.rejects(assertPublicUrl('http://example.com:8080/a.mp4', publicDns), UnsafeUrlError);
});

test('literal private, loopback, link-local and metadata addresses are rejected', async () => {
  const hosts = [
    'http://127.0.0.1/a.mp4', 'http://0x7f.1/a.mp4', 'http://10.1.2.3/a.mp4', 'http://192.168.0.5/a.mp4',
    'http://172.16.0.1/a.mp4', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/a.mp4',
    'http://[::1]/a.mp4', 'http://[fd00::1]/a.mp4', 'http://[fe80::1]/a.mp4',
    'http://[::ffff:127.0.0.1]/a.mp4', 'http://[::ffff:7f00:1]/a.mp4', 'http://[::ffff:a9fe:a9fe]/a.mp4',
    'http://localhost/a.mp4', 'http://metadata.google.internal/computeMetadata/v1/',
    'http://service.internal/a.mp4',
  ];
  for (const u of hosts) {
    await assert.rejects(assertPublicUrl(u, publicDns), UnsafeUrlError, u);
  }
});

test('a public hostname that resolves to a private address is rejected', async () => {
  await assert.rejects(
    assertPublicUrl('https://cdn.example.com/a.mp4', privateDns('10.0.0.5')),
    /privată/,
  );
  await assert.rejects(
    assertPublicUrl('https://cdn.example.com/a.mp4', async () => [
      { address: '93.184.216.34' }, { address: '169.254.169.254' },
    ]),
    UnsafeUrlError,
  );
});

test('an unresolvable host or one without addresses is rejected', async () => {
  await assert.rejects(assertPublicUrl('https://nope.example.com/a.mp4', async () => { throw new Error('ENOTFOUND'); }), UnsafeUrlError);
  await assert.rejects(assertPublicUrl('https://nope.example.com/a.mp4', async () => []), UnsafeUrlError);
});

test('a public URL with a public resolution passes', async () => {
  const u = await assertPublicUrl('https://cdn.example.com/a.mp4', publicDns);
  assert.equal(u.hostname, 'cdn.example.com');
});

test('address classifier covers mapped, NAT64 and public IPv6 cases', () => {
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('224.0.0.1'), true);
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

test('a redirect to a private address is blocked before any request to it', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return redirect('http://169.254.169.254/latest/meta-data');
  }) as unknown as typeof fetch;
  await assert.rejects(
    safeDownloadToTmp('https://cdn.example.com/a.mp4', { lookup: publicDns, fetchImpl, tmpDir: tmpdir() }),
    /privată|blocat/,
  );
  assert.deepEqual(calls, ['https://cdn.example.com/a.mp4']);
});

test('every redirect hop is revalidated, and a hop to a private host stops the chain', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return url.includes('hop2') ? redirect('https://10.0.0.1/x.mp4') : redirect('https://hop2.example.com/a.mp4');
  }) as unknown as typeof fetch;
  const lookup = async () => [{ address: '93.184.216.34' }];
  await assert.rejects(safeDownloadToTmp('https://start.example.com/a.mp4', { lookup, fetchImpl, tmpDir: tmpdir() }));
  assert.equal(calls.length, 2);
});

test('the redirect chain is bounded', async () => {
  let n = 0;
  const fetchImpl = (async () => { n++; return redirect(`https://a.example.com/${n}`); }) as unknown as typeof fetch;
  await assert.rejects(
    safeDownloadToTmp('https://a.example.com/0', { lookup: publicDns, fetchImpl, tmpDir: tmpdir() }),
    /prea multe redirecturi/,
  );
  assert.equal(n, MAX_REDIRECTS + 1);
});

test('a non-media content type is rejected', async () => {
  const fetchImpl = (async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  await assert.rejects(
    safeDownloadToTmp('https://a.example.com/a', { lookup: publicDns, fetchImpl, tmpDir: tmpdir() }),
    /tip de conținut/,
  );
});

test('a declared size above the limit is rejected', async () => {
  const fetchImpl = (async () => videoResponse(10, { 'content-length': '999999' })) as unknown as typeof fetch;
  await assert.rejects(
    safeDownloadToTmp('https://a.example.com/a.mp4', { lookup: publicDns, fetchImpl, tmpDir: tmpdir(), maxBytes: 1000 }),
    /prea mare/,
  );
});

test('a streamed body over the limit fails and leaves no partial file behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-test-'));
  const fetchImpl = (async () => videoResponse(5000)) as unknown as typeof fetch;
  await assert.rejects(
    safeDownloadToTmp('https://a.example.com/a.mp4', { lookup: publicDns, fetchImpl, tmpDir: root, maxBytes: 1000 }),
  );
  assert.deepEqual(await readdir(root), []);
});

test('a successful download returns the file and its kind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-ok-'));
  const fetchImpl = (async () => videoResponse(100)) as unknown as typeof fetch;
  const d = await safeDownloadToTmp('https://a.example.com/a.mp4', { lookup: publicDns, fetchImpl, tmpDir: root, maxBytes: 1000 });
  assert.equal(d.kind, 'video');
  assert.equal(d.bytes, 100);
  assert.ok(d.path.endsWith('.mp4'));
});

test('errors never echo the signed query string', async () => {
  const fetchImpl = (async () => { throw new Error('socket hang up https://a.example.com/a.mp4?token=SECRET123'); }) as unknown as typeof fetch;
  await assert.rejects(
    safeDownloadToTmp('https://a.example.com/a.mp4?token=SECRET123', { lookup: publicDns, fetchImpl, tmpDir: tmpdir() }),
    (e: Error) => !e.message.includes('SECRET123') && !e.message.includes('token'),
  );
});
