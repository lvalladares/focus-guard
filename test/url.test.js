import { describe, it, expect } from 'vitest';
import { parseHashTarget, safeParseUrl } from '../src/lib/url.js';
import { QUOTES, randomQuoteIndex } from '../src/lib/quotes.js';
import { WALLPAPERS, DEFAULT_WALLPAPER_ID, wallpaperSrc } from '../src/lib/wallpapers.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('parseHashTarget', () => {
  it('reads a raw URL from the fragment', () => {
    expect(parseHashTarget('#https://reddit.com/r/all')).toBe('https://reddit.com/r/all');
    expect(parseHashTarget('#https://x.com/a?b=1#frag')).toBe('https://x.com/a?b=1#frag');
  });

  it('decodes percent-encoded fragments', () => {
    expect(parseHashTarget('#' + encodeURIComponent('https://reddit.com/r/x'))).toBe('https://reddit.com/r/x');
  });

  it('tolerates malformed percent sequences', () => {
    expect(parseHashTarget('#https://x.com/50%off')).toBe('https://x.com/50%off');
  });

  it('returns null for empty or invalid fragments', () => {
    expect(parseHashTarget('')).toBeNull();
    expect(parseHashTarget('#')).toBeNull();
    expect(parseHashTarget('#not a url')).toBeNull();
    expect(parseHashTarget(null)).toBeNull();
  });
});

describe('safeParseUrl', () => {
  it('parses valid URLs and rejects garbage', () => {
    expect(safeParseUrl('https://x.com/').hostname).toBe('x.com');
    expect(safeParseUrl('nope')).toBeNull();
    expect(safeParseUrl(null)).toBeNull();
  });
});

describe('quotes', () => {
  it('has a healthy collection of unique quotes', () => {
    expect(QUOTES.length).toBeGreaterThanOrEqual(25);
    const texts = new Set(QUOTES.map((q) => q.text));
    expect(texts.size).toBe(QUOTES.length);
    for (const q of QUOTES) {
      expect(q.text).toBeTruthy();
      expect(q.author).toBeTruthy();
    }
  });

  it('picks quotes and avoids the excluded one', () => {
    expect(randomQuoteIndex()).toBeGreaterThanOrEqual(0);
    expect(randomQuoteIndex(3)).not.toBe(3);
  });
});

describe('wallpapers', () => {
  it('lists built-in wallpapers with existing SVG files', () => {
    expect(WALLPAPERS.length).toBeGreaterThanOrEqual(4);
    for (const wp of WALLPAPERS) {
      const path = resolve(process.cwd(), wp.file);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain('<svg');
      expect(wp.id).toBeTruthy();
      expect(wp.name).toBeTruthy();
    }
  });

  it('resolves wallpaper sources with fallbacks', () => {
    expect(wallpaperSrc({ wallpaper: { mode: 'builtin', value: 'aurora' } })).toContain('aurora.svg');
    expect(wallpaperSrc({ wallpaper: { mode: 'builtin', value: 'bogus' } })).toContain(`${DEFAULT_WALLPAPER_ID}.svg`);
    expect(wallpaperSrc({ wallpaper: { mode: 'url', value: 'https://img.example.com/bg.jpg' } })).toBe('https://img.example.com/bg.jpg');
    expect(wallpaperSrc(null)).toContain('aurora.svg');
  });
});
