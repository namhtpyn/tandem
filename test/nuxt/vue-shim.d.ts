// Literal `.vue` imports (test/nuxt mounts real components) resolve through
// vue-tsc's SFC loader only inside the app project — the root project has no
// .vue wildcard, so give it one. The vitest nuxt project still type-checks the
// mounts with full SFC types; this shim only silences TS2307 there.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
