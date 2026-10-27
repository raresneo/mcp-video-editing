import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  resolvePublicUrl, isPrivateAddress, safeDownloadToTmp, UnsafeUrlError, MAX_REDIRECTS,
  type PinnedLookup, type PinnedResponse, type Transport,
} from '../src/media/safeUrl.js';

// Niciun apel de rețea real: DNS și transport sunt mock-uri. Nicio adresă privată nu e contactată.
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function fakeRes(status: number, headers: Record<string, string>, chunks: Buffer[] = []): PinnedResponse {
  const r = Readable.from(chunks) as unknown as PinnedResponse;
  (r as any).statusCode = status;
  (r as any).headers = headers;
  return r;
}

const videoRes = (bytes: number, extra: Record<string, string> = {}) =>
  fakeRes(200, { 'content-type': 'video/mp4', ...extra }, [Buffer.alloc(bytes)]);

// Apelează lookup-ul pinned exact cum l-ar apela http/https.
function callPinned(lookup: PinnedLookup, all: boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    lookup('ignored', { all }, (err: unknown, a: unknown, f?: unknown) => {
      if (err) reject(err);
      else resolve(all ? a : { address: a, family: f });
    });
  });
}

async function cleanupResult(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

test('non-http protocols and embedded credentials are rejected', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/a.mp4', 'gopher://example.com/', 'https://user:pw@example.com/a.mp4']) {
    await assert.rejects(resolvePublicUrl(u, publicDns), UnsafeUrlError, u);
  }
});

test('non-default ports are rejected', async () => {
  await assert.rejects(resolvePublicUrl('http://example.com:8080/a.mp4', publicDns), UnsafeUrlError);
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
    await assert.rejects(resolvePublicUrl(u, publicDns), UnsafeUrlError, u);
  }
});

test('a hostname resolving to any private address is rejected', async () => {
  await assert.rejects(resolvePublicUrl('https://cdn.example.com/a.mp4', async () => [{ address: '10.0.0.5', family: 4 }]), /privată/);
  await assert.rejects(resolvePublicUrl('https://cdn.example.com/a.mp4', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 },
  ]), UnsafeUrlError);
});

test('an unresolvable host or one without addresses is rejected', async () => {
  await assert.rejects(resolvePublicUrl('https://nope.example.com/a.mp4', async () => { throw new Error('ENOTFOUND'); }), UnsafeUrlError);
  await assert.rejects(resolvePublicUrl('https://nope.example.com/a.mp4', async () => []), UnsafeUrlError);
});

test('address classifier covers mapped, NAT64 and public IPv6 cases', () => {
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('224.0.0.1'), true);
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

test('DNS rebinding mock: connection is pinned to the validated IP, DNS queried once, private answer never used', async () => {
  let dnsCalls = 0;
  // Prima interogare: publică. A doua: privată (rebinding). Trebuie să nu se ajungă la a doua.
  const rebinding = async () => (++dnsCalls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '10.0.0.9', family: 4 }]);
  let seen: PinnedLookup | undefined;
  const transport: Transport = async (_url, o) => {
    seen = o.lookup;
    return videoRes(50);
  };
  const r = await safeDownloadToTmp('https://cdn.example.com/a.mp4', { lookup: rebinding, transport, tmpDir: tmpdir() });
  assert.equal(dnsCalls, 1);
  assert.deepEqual(await callPinned(seen!, false), { address: '93.184.216.34', family: 4 });
  assert.deepEqual(await callPinned(seen!, true), [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(dnsCalls, 1);
  await cleanupResult(r.dir);
});

test('IPv6 mapped address validated as public is pinned as-is; mapped private is blocked before transport', async () => {
  let seen: PinnedLookup | undefined;
  const transport: Transport = async (_u, o) => { seen = o.lookup; return videoRes(10); };
  const ok = await safeDownloadToTmp('https://v6.example.com/a.mp4', {
    lookup: async () => [{ address: '::ffff:8.8.8.8', family: 6 }], transport, tmpDir: tmpdir(),
  });
  assert.deepEqual(await callPinned(seen!, false), { address: '::ffff:8.8.8.8', family: 6 });
  await cleanupResult(ok.dir);

  let transportCalls = 0;
  await assert.rejects(safeDownloadToTmp('https://v6.example.com/a.mp4', {
    lookup: async () => [{ address: '::ffff:10.0.0.1', family: 6 }],
    transport: async () => { transportCalls++; return videoRes(10); },
    tmpDir: tmpdir(),
  }), UnsafeUrlError);
  assert.equal(transportCalls, 0);
});

test('redirect is revalidated and pinned to the new validated address; private target never reaches transport', async () => {
  const dns: Record<string, string> = { 'a.example.com': '93.184.216.34', 'b.example.com': '1.1.1.1', 'priv.example.com': '192.168.1.1' };
  const dnsCalls: string[] = [];
  const lookup = async (host: string) => { dnsCalls.push(host); return [{ address: dns[host]!, family: 4 }]; };
  const pins: Array<{ url: string; lookup: PinnedLookup }> = [];
  const transport: Transport = async (url, o) => {
    pins.push({ url: url.href, lookup: o.lookup });
    if (url.hostname === 'a.example.com') return fakeRes(302, { location: 'https://b.example.com/x.mp4' });
    return videoRes(20);
  };
  const r = await safeDownloadToTmp('https://a.example.com/a.mp4', { lookup, transport, tmpDir: tmpdir() });
  assert.deepEqual(dnsCalls, ['a.example.com', 'b.example.com']);
  assert.equal(pins.length, 2);
  assert.deepEqual(await callPinned(pins[1]!.lookup, false), { address: '1.1.1.1', family: 4 });
  await cleanupResult(r.dir);

  let t = 0;
  await assert.rejects(safeDownloadToTmp('https://a.example.com/a.mp4', {
    lookup,
    transport: async (url) => { t++; return url.hostname === 'a.example.com' ? fakeRes(302, { location: 'https://priv.example.com/x' }) : videoRes(1); },
    tmpDir: tmpdir(),
  }), /privată/);
  assert.equal(t, 1);
});

test('a redirect to a literal private IP is blocked before transport', async () => {
  let t = 0;
  await assert.rejects(safeDownloadToTmp('https://a.example.com/a.mp4', {
    lookup: publicDns,
    transport: async () => { t++; return fakeRes(302, { location: 'http://169.254.169.254/latest/meta-data' }); },
    tmpDir: tmpdir(),
  }), UnsafeUrlError);
  assert.equal(t, 1);
});

test('the redirect chain is bounded', async () => {
  let n = 0;
  await assert.rejects(safeDownloadToTmp('https://a.example.com/0', {
    lookup: publicDns,
    transport: async () => { n++; return fakeRes(302, { location: `https://a.example.com/${n}` }); },
    tmpDir: tmpdir(),
  }), /prea multe redirecturi/);
  assert.equal(n, MAX_REDIRECTS + 1);
});

test('a non-media content type is rejected', async () => {
  await assert.rejects(safeDownloadToTmp('https://a.example.com/a', {
    lookup: publicDns,
    transport: async () => fakeRes(200, { 'content-type': 'text/html' }, [Buffer.from('<html>')]),
    tmpDir: tmpdir(),
  }), /tip de conținut/);
});

test('a declared size above the limit is rejected', async () => {
  await assert.rejects(safeDownloadToTmp('https://a.example.com/a.mp4', {
    lookup: publicDns, transport: async () => videoRes(10, { 'content-length': '999999' }), tmpDir: tmpdir(), maxBytes: 1000,
  }), /prea mare/);
});

test('a streamed body over the limit fails and leaves no directory behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-test-'));
  await assert.rejects(safeDownloadToTmp('https://a.example.com/a.mp4', {
    lookup: publicDns, transport: async () => videoRes(5000), tmpDir: root, maxBytes: 1000,
  }));
  assert.deepEqual(await readdir(root), []);
});

test('a successful download returns the file, kind and its own dir (caller removes it)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dl-ok-'));
  const d = await safeDownloadToTmp('https://a.example.com/a.mp4', {
    lookup: publicDns, transport: async () => videoRes(100), tmpDir: root, maxBytes: 1000,
  });
  assert.equal(d.kind, 'video');
  assert.equal(d.bytes, 100);
  assert.ok(d.path.endsWith('.mp4'));
  assert.deepEqual(await readdir(root), [d.dir.split('/').pop()]);
  await rm(d.dir, { recursive: true, force: true });
  assert.deepEqual(await readdir(root), []);
});

test('errors never echo the signed query string', async () => {
  await assert.rejects(safeDownloadToTmp('https://a.example.com/a.mp4?token=SECRET123', {
    lookup: publicDns,
    transport: async () => { throw new Error('socket hang up https://a.example.com/a.mp4?token=SECRET123'); },
    tmpDir: tmpdir(),
  }), (e: Error) => !e.message.includes('SECRET123') && !e.message.includes('token'));
});
