// service-worker.js

// This is the name of our cache (our offline storage box)
const CACHE_NAME = 'chat-camp-cache-v1';

// These are the files we want to save for offline use (the "App Shell")
// service-worker.js

const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.png',
  '/socket.io/socket.io.js'
];

// Event: The service worker is being installed
self.addEventListener('install', event => {
  // We wait until the installation is complete
  event.waitUntil(
    // Open our cache box
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        // Add all the files we specified to the cache box
        return cache.addAll(urlsToCache);
      })
  );
});

// Event: A file is being requested from the network (e.g., the user opens the app)
self.addEventListener('fetch', event => {
  event.respondWith(
    // We check if the requested file is already in our cache box
    caches.match(event.request)
      .then(response => {
        // If we find a copy in the cache, we give that back immediately (this is the offline magic!)
        if (response) {
          return response;
        }
        // If it's not in the cache, we get it from the internet like normal
        return fetch(event.request);
      })
  );
});
