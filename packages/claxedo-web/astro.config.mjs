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
