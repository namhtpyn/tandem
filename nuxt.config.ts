export default defineNuxtConfig({
  experimental: {
    typescriptPlugin: true,
    viteEnvironmentApi: true,
    typedPages: true,
    appManifest: true,
    watcher: 'builder',
  },
  dxup: {
    features: {
      namedLayoutSlots: true,
    },
  },
  typescript: {
    typeCheck: true,
  },
  modules: ['@vueuse/nuxt', '@nuxt/ui', '@nuxt/fonts', '@nuxt/icon', '@dxup/nuxt'],
  css: ['~/assets/css/main.css'],
  compatibilityDate: '2026-01-01',
  nitro: {
    // bun runtime in dev, test and prod — the bun preset bundles bun-specific package
    // exports correctly (default node preset can mis-bundle them) and emits a leaner server
    preset: 'bun',
    compatibilityDate: '2026-01-01',
    // default es2019 target rejects top-level await; the bun runtime is modern
    esbuild: { options: { target: 'es2022' } },
    experimental: { openAPI: false },
    serverAssets: [{ baseName: 'drizzle', dir: './drizzle' }],
  },
  app: {
    head: {
      title: 'Tandem',
      meta: [{ name: 'description', content: 'Company workspace for human and AI employees' }],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
});
