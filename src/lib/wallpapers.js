export const WALLPAPERS = [
  { id: 'aurora', name: 'Aurora', file: 'assets/wallpapers/aurora.svg' },
  { id: 'sunrise', name: 'Sunrise Ridge', file: 'assets/wallpapers/sunrise.svg' },
  { id: 'ocean', name: 'Deep Ocean', file: 'assets/wallpapers/ocean.svg' },
  { id: 'forest', name: 'Misty Forest', file: 'assets/wallpapers/forest.svg' },
  { id: 'minimal', name: 'Minimal Dark', file: 'assets/wallpapers/minimal.svg' },
];

export const DEFAULT_WALLPAPER_ID = 'aurora';

export function wallpaperSrc(config) {
  const wp = config && config.wallpaper;
  if (!wp) return chromeWallpaperUrl(DEFAULT_WALLPAPER_ID);
  if (wp.mode === 'url' && typeof wp.value === 'string' && /^https?:\/\//.test(wp.value)) return wp.value;
  const found = WALLPAPERS.find((w) => w.id === wp.value);
  return chromeWallpaperUrl(found ? found.id : DEFAULT_WALLPAPER_ID);
}

function chromeWallpaperUrl(id) {
  const found = WALLPAPERS.find((w) => w.id === id) || WALLPAPERS[0];
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(found.file);
  }
  return `/${found.file}`;
}
