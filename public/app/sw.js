/* global importScripts */
// Service worker of the pro app, scope /app/ (ADR-0010 §5). It only imports OneSignal's v16
// worker: no fetch handler and no caching in Phase 1, so there is never a stale app version or
// offline client data on the device. Registered by the OneSignal page SDK
// (serviceWorkerPath 'app/sw.js', scope '/app/'), never by the booking page.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js')
