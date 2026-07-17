import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

// Injects the Inter font <link> tags into <head> at BUILD time
// (Remediation plan Batch C / ext #17).
//
// Why a plugin and not index.html: Figma Make does not expose index.html for
// editing and regenerates it on push, so hand-edits to it in GitHub get
// clobbered. This config file IS Make-managed, and Vercel runs `vite build`,
// so the deployed HTML always carries the links regardless of what Make
// writes to index.html. The font declaration must live in the HTML head (not
// a CSS @import) so the preconnect can open the TLS handshake during HTML
// parse instead of waiting for the CSS bundle to download and parse.
//
// Idempotent: if index.html ever DOES contain a fonts.googleapis stylesheet
// link (e.g. Make starts emitting one), the plugin injects nothing.
function injectFontLinks() {
  const FONT_CSS =
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap'
  return {
    name: 'inject-font-links',
    transformIndexHtml(html) {
      if (html.includes('fonts.googleapis.com/css2')) return html
      return {
        html,
        tags: [
          { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'stylesheet', href: FONT_CSS }, injectTo: 'head' },
        ],
      }
    },
  }
}

export default defineConfig({
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    injectFontLinks(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})