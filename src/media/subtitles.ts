import type { Caption } from './transcribe.js';

export interface AssStyle {
  font_size?: number;
  color?: string; // #RRGGBB pentru textul principal
  highlight_color?: string; // #RRGGBB pentru cuvintele cheie
  outline?: number;
  shadow?: number;
  position?: 'bottom' | 'center' | 'top';
  uppercase?: boolean;
  highlight_words?: string[];
}

// Secunde -> H:MM:SS.cs (formatul cerut de ASS).
function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(rest).padStart(2, '0')}`;
}

// #RRGGBB -> &H00BBGGRR (ASS inverseaza ordinea canalelor).
function assColor(hex: string | undefined, fallback: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return fallback;
  const v = m[1]!.toUpperCase();
  return `&H00${v.slice(4, 6)}${v.slice(2, 4)}${v.slice(0, 2)}`;
}

// Escapare pentru corpul unui Dialogue: acoladele si backslash-ul sunt tag-uri.
function assEscape(text: string): string {
  return text
    .replace(/\\/g, '\u2216')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .replace(/\r?\n/g, '\\N');
}

function bareWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Construieste un fisier ASS complet din liniile de caption.
export function buildAss(
  captions: Caption[],
  width: number,
  height: number,
  style: AssStyle = {},
): string {
  const w = width > 0 ? width : 1080;
  const h = height > 0 ? height : 1920;

  const fontSize = style.font_size ?? Math.round(h * 0.045);
  const primary = assColor(style.color, '&H00FFFFFF');
  const accent = assColor(style.highlight_color, '&H0037AFD4'); // #D4AF37 auriu brand
  const outline = style.outline ?? 4;
  const shadow = style.shadow ?? 1;

  const alignment = style.position === 'center' ? 5 : style.position === 'top' ? 8 : 2;
  const marginV = style.position === 'center' ? 0 : Math.round(h * 0.14);
  const marginH = Math.round(w * 0.08);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Brand,DejaVu Sans,${fontSize},${primary},${primary},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},${shadow},${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const highlights = (style.highlight_words ?? []).map(bareWord).filter(Boolean);

  const events = captions.map((c) => {
    const raw = style.uppercase === false ? c.text : c.text.toUpperCase();

    // Escapam per cuvant, apoi adaugam tag-urile de culoare, ca sa nu escapam
    // chiar acoladele tag-urilor pe care le generam noi.
    const rendered = raw
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        const safe = assEscape(word);
        if (!highlights.length) return safe;
        return highlights.includes(bareWord(word))
          ? `{\\c${accent}}${safe}{\\c${primary}}`
          : safe;
      })
      .join(' ');

    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Brand,,0,0,0,,${rendered}`;
  });

  return `${header}\n${events.join('\n')}\n`;
}
