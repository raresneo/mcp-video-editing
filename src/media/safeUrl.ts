import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Descărcare sigură pentru URL-uri furnizate de utilizator (SSRF guard).
// Permis: doar http/https, porturi standard, fără credențiale, doar adrese publice
// (inclusiv adresele rezolvate prin DNS), fiecare redirect revalidat, limită de redirecturi.
// Limitare cunoscută: conexiunea nu e fixată pe IP-ul validat (rebinding DNS rămâne un risc rezidual).

export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 209_715_200;
export const DEFAULT_TIMEOUT_MS = 300_000;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export type Lookup = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, include metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224; // multicast, rezervat, broadcast
}

// Întoarce cele 8 grupuri de 16 biți ale unei adrese IPv6 (sau null dacă e invalidă).
function ipv6Hextets(ip: string): number[] | null {
  let s = ip;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const q = v4[1]!.split('.').map(Number);
    if (q.some((n) => n > 255)) return null;
    const hex = `${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`;
    s = s.slice(0, s.length - v4[1]!.length) + hex;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const parts = [...head, ...new Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map((h) => parseInt(h, 16));
  return nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}

// true = adresa NU e publică (sau nu poate fi clasificată: fail closed).
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  const v = isIP(ip);
  if (v === 4) return isPrivateIPv4(ip);
  if (v !== 6) return true;
  const h = ipv6Hextets(ip);
  if (!h) return true;
  const embedded = (hi: number, lo: number) =>
    isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  const zeroTo4 = h.slice(0, 5).every((x) => x === 0);
  if (zeroTo4 && h[5] === 0xffff) return embedded(h[6]!, h[7]!); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeroTo4 && h[5] === 0) return true; // :: , ::1 , ::a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return embedded(h[6]!, h[7]!); // NAT64
  if (h[0] === 0x2002) return embedded(h[1]!, h[2]!); // 6to4
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  return !(h[0]! >= 0x2000 && h[0]! <= 0x3fff); // doar unicast global
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog']);

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

// Validare sintactică, fără DNS.
export function parsePublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError('URL invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('doar http și https sunt permise');
  if (u.username || u.password) throw new UnsafeUrlError('credențiale în URL nepermise');
  if (u.port !== '') throw new UnsafeUrlError('doar porturile standard sunt permise');
  const host = hostOf(u);
  if (!host) throw new UnsafeUrlError('host lipsă');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('host blocat');
  }
  if (isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError('adresă privată blocată');
  return u;
}

// Validare completă: sintaxă + toate adresele DNS trebuie să fie publice.
export async function assertPublicUrl(raw: string, lookup: Lookup = defaultLookup): Promise<URL> {
  const u = parsePublicUrl(raw);
  const host = hostOf(u);
  if (isIP(host)) return u;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new UnsafeUrlError('host-ul nu poate fi rezolvat');
  }
  if (addrs.length === 0) throw new UnsafeUrlError('host-ul nu are adrese');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('host rezolvat la adresă privată');
  return u;
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface SafeDownloaded {
  path: string;
  dir: string;
  kind: MediaKind;
  contentType: string;
  bytes: number;
}

export interface SafeDownloadOptions {
  lookup?: Lookup;
  fetchImpl?: typeof fetch;
  tmpDir?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

const EXT_BY_CT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

function kindOf(ct: string): MediaKind {
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('audio/')) return 'audio';
  throw new UnsafeUrlError('tip de conținut nepermis');
}

// Erorile nu includ URL-ul (poate avea token semnat în query).
export async function safeDownloadToTmp(rawUrl: string, opts: SafeDownloadOptions = {}): Promise<SafeDownloaded> {
  const lookup = opts.lookup ?? defaultLookup;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let current = await assertPublicUrl(rawUrl, lookup);
    let res = await doFetch(current.href, { redirect: 'manual', signal });
    for (let hop = 0; res.status >= 300 && res.status < 400 && res.headers.get('location'); hop++) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new UnsafeUrlError('prea multe redirecturi');
      current = await assertPublicUrl(new URL(res.headers.get('location')!, current).href, lookup);
      res = await doFetch(current.href, { redirect: 'manual', signal });
    }
    if (!res.ok || !res.body) throw new Error(`download eșuat (status ${res.status})`);

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const kind = (() => {
      try {
        return kindOf(contentType);
      } catch (e) {
        void res.body?.cancel();
        throw e;
      }
    })();
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await res.body.cancel();
      throw new UnsafeUrlError('fișier prea mare');
    }

    const dir = await mkdtemp(join(opts.tmpDir ?? '/tmp', 'src-'));
    const path = join(dir, `in${EXT_BY_CT[contentType] ?? '.bin'}`);
    let received = 0;
    const body = Readable.fromWeb(res.body as any);
    body.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) body.destroy(new UnsafeUrlError('depășită limita de dimensiune'));
    });
    try {
      await pipeline(body, createWriteStream(path));
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e instanceof UnsafeUrlError ? e : new Error('download eșuat în timpul transferului');
    }
    return { path, dir, kind, contentType, bytes: received };
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw e;
    throw new Error('download eșuat');
  }
}
