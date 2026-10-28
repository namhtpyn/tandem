export default defineNuxtConfig({
  experimental: {
    typescriptPlugin: true,
    viteEnvironmentApi: true,
    typedPages: true,
    appManifest: true,
    // poll builds/latest.json for a newer deployed build; app.vue offers reload
    checkOutdatedBuildInterval: 60_000,
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
  modules: ['@nuxt/test-utils/module', '@vueuse/nuxt', '@nuxt/ui', '@nuxt/fonts', '@nuxt/icon', '@dxup/nuxt'],
  css: ['~/assets/css/main.css'],
  compatibilityDate: '2026-01-01',
  vite: {
    // server code imports the bun builtin (Bun SQL client) — the bundler must leave it alone
    build: { rollupOptions: { external: ['bun'] } },
  },
  nitro: {
    // bun runtime in dev, test and prod — the bun preset bundles bun-specific package
    // exports correctly (default node preset can mis-bundle them) and emits a leaner server
    preset: 'bun',
    // `import { SQL } from 'bun'` (native db client) is a runtime builtin, not a package
    externals: { external: ['bun'] },
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
  // devtools disabled: its plugin chain imports h3 v2's 'H3' under `bun --bun nuxt dev`, which h3 v1.15 doesn't export
  devtools: { enabled: false },
});
