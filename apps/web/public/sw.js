// Brio's service worker: shows web push notifications (M9) and opens the right page when one is clicked. It caches
// nothing and handles no requests.
self.addEventListener("push", (event) => {
  let data = { title: "Brio", body: "", url: "/inbox", tag: undefined };
  try {
    data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/brand/icon-192.png",
      badge: "/brand/icon-192.png",
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/inbox", self.location.origin);
  // Only ever open Brio's own pages.
  const target =
    url.origin === self.location.origin ? url.href : new URL("/inbox", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) if (w.url === target && "focus" in w) return w.focus();
      return self.clients.openWindow(target);
    }),
  );
});
