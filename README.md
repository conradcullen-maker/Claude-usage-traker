# Claude Usage tracker

## improvenets 

- **Fixed the usage graph** — the history chart was broken; it now renders correctly.
- **Time-scale buttons** — choose the graph's time range instead of being stuck with one fixed window. *(work in progress)*
- **Adjustable opacity** — control background and bar opacity, including in compact mode.
- **Actually-compact compact mode** — smaller footprint, and it now shows the reset time.
- **Reworked settings** — a cleaner, clearer settings panel.
- **Fixed sign-in** — more reliable Claude.ai login flow.
- **One-click uninstall** — a clear way to remove the app.
- **Automatic update checks** — checks for a newer release on startup and shows a one-click download banner.
- **Faster extra-usage data** — all usage data (including extra usage) is fetched in a single pass instead of a deferred second request.
- **Removed clutter** — dropped unused docs, begging button, leftover backup files, and dead code, and split the old ~2,000-line renderer into focused modules under `src/renderer/modules/`.

---
how to run 
cd "C:\Users\conra\Downloads\claude-usage-widget-0.8.1"
npm start
