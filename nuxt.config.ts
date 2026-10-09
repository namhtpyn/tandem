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
  modules: [
    '@vueuse/nuxt',
    '@nuxt/ui',
    '@nuxt/fonts',
    '@nuxt/icon',
    '@dxup/nuxt',
  ],
  css: ['~/assets/css/main.css'],
  compatibilityDate: '2026-01-01',
  nitro: {
    compatibilityDate: '2026-01-01',
    experimental: { openAPI: false },
    serverAssets: [
      { baseName: 'drizzle', dir: './drizzle' },
    ],
  },
  app: {
    head: {
      title: 'Tandem',
      meta: [{ name: 'description', content: 'Company workspace for human and AI employees' }],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
})
