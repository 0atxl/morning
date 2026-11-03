# Morning landing page

The landing page opens at `/`. **Try Morning** is an ordinary link to `/app`, which mounts the guest dashboard. A separate Vite development entry is available at `/landing.html`.

`LandingPage` takes a `guestHref` so route integration only needs to supply the agreed dashboard URL. The page reuses the existing shadcn/ui Button. Its styles are scoped to `.morning-landing`; the dashboard and recorder are separate.

The shared bootstrap loads each page and its styles separately. Vite's SPA fallback supports direct navigation and refresh at `/app`. Production hosting must serve `index.html` for `/app` after handling `/api/*`.

The example is static. It creates no reminder, accesses no microphone and calls no provider.

## Cursor vapour

`vapour/vapour.js`, `vapour/vapour-shaders.js` and `vapour/page-scene.js` are copied from Frost's landing page. The simulation, shaders, cursor response and scene painter are unchanged. `vapour/page-vapour.js` adapts Frost's mount logic for a React component and removes its listeners and GPU resources on unmount or page exit. Settings remain `intensity: 1`, `lifetime: 1.2`, `refraction: 1`, `flowSpeed: 0.7`, and `minRadius: 6`.

The MIT notice is bundled in [`public/licenses/frost-vapour.txt`](../../public/licenses/frost-vapour.txt). There are no imports from the Frost checkout or remote assets. Reduced-motion and touch visitors get normal HTML without loading the simulation. WebGL failures leave HTML visible. Frost's pointer-press, keyboard, selection, hidden-tab and print fallbacks are retained.
