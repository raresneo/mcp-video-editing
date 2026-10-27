import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Descărcare sigură pentru URL-uri furnizate de utilizator (SSRF guard).
// Fiecare hop: DNS o singură dată, toate adresele trebuie publice, apoi conexiunea
// e FIXATĂ pe prima adresă validată (lookup personalizat în request). Nu există a doua
// rezoluție DNS. TLS folosește hostname-ul original (SNI și verificare certificat).
// Redirecturile sunt tratate manual: fiecare țintă e revalidată și fixată separat.

export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 209_715_200;
export const DEFAULT_TIMEOUT_MS = 300_000;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export type Lookup = (host: string) => Promise<Array<{ address: string; family?: number }>>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

// Lookup compatibil cu opțiunea `lookup` din http/https: întoarce mereu adresa validată.
export type PinnedLookup = (host: string, opts: any, cb: (...args: any[]) => void) => void;

export interface PinnedResponse {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  resume(): unknown;
  [Symbol.asyncIterator](): AsyncIterator<any>;
}

export interface TransportOptions {
  lookup: PinnedLookup;
  headers: Record<string, string>;
  signal: AbortSignal;
}
export type Transport = (url: URL, opts: TransportOptions) => Promise<PinnedResponse>;

export function pinnedLookup(address: string, family: number): PinnedLookup {
  return (_host, opts, cb) => {
    if (opts && opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

const defaultTransport: Transport = (url, o) =>
  new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      headers: o.headers,
      lookup: o.lookup as any,
      signal: o.signal,
      ...(isHttps && !isIP(url.hostname.replace(/^\[|\]$/g, '')) ? { servername: url.hostname } : {}),
    }, (res) => resolve(res as unknown as PinnedResponse));
    req.on('error', reject);
    req.end();
  });

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

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: number;
}

// Validare + rezolvare UNICĂ. Adresa întoarsă e cea care se conectează (pinning).
export async function resolvePublicUrl(raw: string, lookup: Lookup = defaultLookup): Promise<ResolvedTarget> {
  const u = parsePublicUrl(raw);
  const host = hostOf(u);
  const literal = isIP(host);
  if (literal) return { url: u, address: host, family: literal };
  let addrs: Array<{ address: string; family?: number }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new UnsafeUrlError('host-ul nu poate fi rezolvat');
  }
  if (addrs.length === 0) throw new UnsafeUrlError('host-ul nu are adrese');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeUrlError('host rezolvat la adresă privată');
  const first = addrs[0]!;
  return { url: u, address: first.address, family: first.family ?? isIP(first.address) };
}

export type MediaKind = 'image' | 'video' | 'audio';

// dir e directorul temporar al descărcării: apelantul îl șterge în finally (rm recursiv).
export interface SafeDownloaded {
  path: string;
  dir: string;
  kind: MediaKind;
  contentType: string;
  bytes: number;
}

export interface SafeDownloadOptions {
  lookup?: Lookup;
  transport?: Transport;
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
  const transport = opts.transport ?? defaultTransport;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const dir = await mkdtemp(join(opts.tmpDir ?? '/tmp', 'src-'));
  try {
    let target = rawUrl;
    let res: PinnedResponse;
    for (let hop = 0; ; hop++) {
      const r = await resolvePublicUrl(target, lookup);
      res = await transport(r.url, {
        lookup: pinnedLookup(r.address, r.family),
        headers: { accept: 'video/*,image/*,audio/*,*/*;q=0.5' },
        signal,
      });
      const loc = res.headers['location'];
      if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && typeof loc === 'string') {
        res.resume();
        if (hop >= MAX_REDIRECTS) throw new UnsafeUrlError('prea multe redirecturi');
        target = new URL(loc, r.url).href;
        continue;
      }
      break;
    }
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`download eșuat (status ${status})`);
    }

    const ctHeader = res.headers['content-type'];
    const contentType = (typeof ctHeader === 'string' ? ctHeader : '').split(';')[0]!.trim().toLowerCase();
    let kind: MediaKind;
    try {
      kind = kindOf(contentType);
    } catch (e) {
      res.resume();
      throw e;
    }
    const lenHeader = res.headers['content-length'];
    const declared = Number(typeof lenHeader === 'string' ? lenHeader : '0');
    if (declared > maxBytes) {
      res.resume();
      throw new UnsafeUrlError('fișier prea mare');
    }

    const path = join(dir, `in${EXT_BY_CT[contentType] ?? '.bin'}`);
    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > maxBytes) return cb(new UnsafeUrlError('depășită limita de dimensiune'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res as unknown as NodeJS.ReadableStream, counter, createWriteStream(path));
    } catch (e) {
      throw e instanceof UnsafeUrlError ? e : new Error('download eșuat în timpul transferului');
    }
    return { path, dir, kind, contentType, bytes: received };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    if (e instanceof UnsafeUrlError) throw e;
    throw new Error('download eșuat');
  }
}
