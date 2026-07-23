// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { expiredComparisonPaths } from './src/content/competitors';

/** @typedef {{ type: string, tagName?: string, properties?: Record<string, unknown>, children?: AstNode[] }} AstNode */
const focusableCodeBlocks = {
  name: 'focusable-code-blocks',
  hooks: {
    /** @param {{ renderData: { blockAst: AstNode } }} context */
    postprocessRenderedBlock: (context) => {
    /** @param {AstNode} node */
      const visit = (node) => {
        if (node.type === 'element' && node.tagName === 'pre') node.properties = { ...node.properties, tabindex: 0 };
        node.children?.forEach(visit);
      };
      visit(context.renderData.blockAst);
    },
  },
};

// https://astro.build/config
export default defineConfig({
  site: 'https://claxedo.com',
  trailingSlash: 'never',
  // Astro's own <Code> component (used by the framework landing) highlights
  // via Shiki's `css-variables` theme — the only theme in this build's bundle.
  // Token colors are set through --astro-code-* variables in the component CSS.
  markdown: {
    shikiConfig: { theme: 'css-variables' },
  },
  integrations: [
    sitemap({
      serialize: (item) => ({ ...item, url: item.url === 'https://claxedo.com' ? `${item.url}/` : item.url }),
      filter: (page) => {
        const pathname = new URL(page).pathname.replace(/\/$/, '') || '/';
        return pathname !== '/app' && !expiredComparisonPaths.includes(pathname);
      },
    }),
    starlight({
      title: 'Claxedo Framework',
      description: 'The open-source workspace and integration foundation behind Claxedo.',
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kyashrathore/Claxedo' }],
      customCss: ['./src/styles/framework.css'],
      expressiveCode: { plugins: [focusableCodeBlocks] },
      components: { Header: './src/components/framework/FrameworkHeader.astro' },
      lastUpdated: true,
      sidebar: [
        { label: 'Framework overview', link: '/framework' },
        { label: 'Guide', autogenerate: { directory: 'framework/guides' } },
        { label: 'Concepts', autogenerate: { directory: 'framework/concepts', collapsed: true } },
        { label: 'Deploy', autogenerate: { directory: 'framework/deploy', collapsed: true } },
        { label: 'SDK / Packages', autogenerate: { directory: 'framework/packages', collapsed: true } },
        { label: 'Reference', autogenerate: { directory: 'framework/api', collapsed: true } },
        { label: 'Cookbook', autogenerate: { directory: 'framework/cookbook', collapsed: true } },
        { label: 'Ecosystem', slug: 'framework/ecosystem' },
        { label: 'CLI', slug: 'framework/cli' },
      ],
    }),
  ],
});
