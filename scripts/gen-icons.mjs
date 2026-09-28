// Renders the pro app's PNG icons from public/app/icon.svg with Playwright's Chromium (step 1.1).
// Run it after changing the SVG (`npm run gen:icons`) and commit the PNGs: they are static files.
//
// - apple-touch-icon.png (180): iOS fills transparent pixels with black and rounds the corners
//   itself, so it gets a square, full-bleed background.
// - icon-192/512.png ("any"): the SVG as drawn, rounded corners and all.
// - icon-maskable-192/512.png ("maskable"): full-bleed background; the glyph already sits inside
//   the 80 % safe zone, so launchers may crop any shape.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const APP_DIR = new URL('../public/app/', import.meta.url)
const svg = await readFile(new URL('icon.svg', APP_DIR), 'utf8')

// The background of the full-bleed icons is the SVG's own tile colour, never a second copy.
const background = /<rect\b[^>]*\bfill="(#[0-9a-fA-F]{3,8})"/.exec(svg)?.[1]
if (!background) throw new Error('icon.svg: expected a <rect fill="#…"> background tile')

const ICONS = [
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true },
  { file: 'icon-192.png', size: 192, fullBleed: false },
  { file: 'icon-512.png', size: 512, fullBleed: false },
  { file: 'icon-maskable-192.png', size: 192, fullBleed: true },
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true },
]

const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const browser = await chromium.launch()
try {
  for (const { file, size, fullBleed } of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${fullBleed ? background : 'transparent'}">` +
        `<img src="${dataUrl}" width="${size}" height="${size}" style="display:block" alt=""></body></html>`,
    )
    await page.locator('img').evaluate((img) => /** @type {HTMLImageElement} */ (img).decode())
    await page.screenshot({
      path: fileURLToPath(new URL(file, APP_DIR)),
      omitBackground: !fullBleed,
      clip: { x: 0, y: 0, width: size, height: size },
    })
    await page.close()
    console.log(`public/app/${file} (${size}×${size})`)
  }
} finally {
  await browser.close()
}
