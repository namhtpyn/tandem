export default defineAppConfig({
  ui: {
    colors: {
      primary: 'amber',
      neutral: 'zinc',
    },
    // solid primary rides amber-500 (light) / amber-400 (dark); the library's
    // white-on-primary label is 2.15:1 in light mode. Force the dark label in
    // BOTH modes — palette hue stays amber, only the foreground token moves.
    // tv merges this after the theme's own compound variant, so text-neutral-900
    // wins over text-inverted.
    button: {
      compoundVariants: [
        {
          color: 'primary',
          variant: 'solid',
          class: 'text-neutral-900 hover:bg-primary/90 active:bg-primary/90',
        },
      ],
    },
    // overlay scrim: the library default bg-elevated/75 is a light veil and
    // bg-default/75 equals the panel token — neither separates an open overlay
    // from the page. --ui-overlay (main.css) is a true dim in both modes.
    // modal carries the scrim in an `overlay` boolean variant; slideover/drawer
    // bake it into the slot string, so those override the slot directly.
    modal: {
      variants: {
        overlay: {
          true: {
            overlay: 'bg-(--ui-overlay) backdrop-blur-sm',
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
        overlay: 'fixed inset-0 bg-(--ui-overlay) backdrop-blur-sm',
      },
    },
    drawer: {
      slots: {
        overlay: 'fixed inset-0 bg-(--ui-overlay) backdrop-blur-sm',
      },
    },
  },
});
