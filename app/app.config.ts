export default defineAppConfig({
  ui: {
    colors: {
      primary: 'amber',
      neutral: 'zinc',
    },
    // modals: mobile keeps the edge-to-edge card (w-[calc(100vw-2rem)]); desktop
    // gets real width instead of the 512px library default (max-w-lg)
    modal: {
      variants: {
        fullscreen: {
          false: {
            content:
              'w-[calc(100vw-2rem)] sm:max-w-xl md:max-w-2xl lg:max-w-3xl rounded-lg shadow-lg ring ring-default',
          },
        },
      },
    },
  },
})
