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
    // the app shell pins UDashboardGroup in a fixed viewport wrapper, so each
    // panel must fill exactly that height — the stock min-h-svh lets the panel
    // grow past the viewport and the body's overflow-y-auto never engages
    // (every page stopped scrolling); h-full + min-h-0 cap it
    dashboardPanel: {
      slots: {
        root: 'relative flex flex-col min-w-0 h-full min-h-0 overflow-hidden',
      },
    },
  },
});
