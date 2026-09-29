// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { expiredComparisonPaths } from './src/content/competitors';

// Sitemap lastmod is the build date: the site is deployed only when content changes.
const buildDate = new Date().toISOString().slice(0, 10);

// https://astro.build/config
export default defineConfig({
  site: 'https://claxedo.com',
  trailingSlash: 'never',
  // Cloudflare Pages 308s /x to /x/ when the page is x/index.html; x.html is served at /x.
  build: { format: 'file' },
  integrations: [
    sitemap({
      serialize: (item) => ({ ...item, url: item.url === 'https://claxedo.com' ? `${item.url}/` : item.url, lastmod: buildDate }),
      filter: (page) => {
        const pathname = new URL(page).pathname.replace(/\/$/, '') || '/';
        return pathname !== '/app' && !expiredComparisonPaths.includes(pathname);
      },
    }),
  ],
});
