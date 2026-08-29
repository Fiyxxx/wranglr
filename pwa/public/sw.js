self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Wranglr", body: "" };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow("/dashboard");
    }),
  );
});
