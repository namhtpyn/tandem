export default defineAppConfig({
  ui: {
    colors: {
      primary: 'amber',
      neutral: 'zinc',
    },
    // overlay scrim (verified against .nuxt/ui/{modal,slideover,drawer}.ts): the
    // library default bg-elevated/75 is a light veil — saturated amber CTAs in
    // the shell burn straight through it. Drop to the page bg + a slight blur
    // so background UI recedes while the open overlay owns the screen.
    // modal carries the scrim in an `overlay` boolean variant; slideover/drawer
    // bake it into the slot string, so those override the slot directly.
    modal: {
      variants: {
        overlay: {
          true: {
            overlay: 'bg-default/75 backdrop-blur-sm',
          },
        },
        // modals: mobile keeps the edge-to-edge card (w-[calc(100vw-2rem)]); desktop
        // gets real width instead of the 512px library default (max-w-lg)
        fullscreen: {
          false: {
            content:
              'w-[calc(100vw-2rem)] sm:max-w-xl md:max-w-2xl lg:max-w-3xl rounded-lg shadow-lg ring ring-default',
          },
        },
      },
    },
    slideover: {
      slots: {
        overlay: 'fixed inset-0 bg-default/75 backdrop-blur-sm',
      },
    },
    drawer: {
      slots: {
        overlay: 'fixed inset-0 bg-default/75 backdrop-blur-sm',
      },
    },
  },
});
