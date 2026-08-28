// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { expiredComparisonPaths } from './src/content/competitors';

// https://astro.build/config
export default defineConfig({
  site: 'https://claxedo.com',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      serialize: (item) => ({ ...item, url: item.url === 'https://claxedo.com' ? `${item.url}/` : item.url }),
      filter: (page) => {
        const pathname = new URL(page).pathname.replace(/\/$/, '') || '/';
        return pathname !== '/app' && !expiredComparisonPaths.includes(pathname);
      },
    }),
  ],
});
