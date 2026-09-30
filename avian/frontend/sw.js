// AvianVisitors service worker - served from the site root (/sw.js) so it
// controls the page. It exists for two reasons, both down to the Pi's slow,
// sometimes-absent Wi-Fi:
//   - speed: a return visit paints from the last data this device saw, then
//     apt.js swaps in fresh data quietly (see bootFromCache in apt.js);
//   - resilience: with the Pi unreachable the page still opens and shows the
//     last collage / atlas / timeline, marked as offline.
//
// Caches (apt.js reads API_CACHE directly - keep the names in step):
//   av-shell-v1  the page (served at once, refreshed in the background) and
//                ?v= versioned JS/CSS (immutable, so cache-first)
//   av-api-v1    the last good response for each birdnet-api.php URL; the
//                network always goes first, this answers only when it fails
//   av-img-v1    bird images (URLs carry &v=, so cache-first), capped
//
// Deploys: the page is stale-while-revalidate, so a new index.html lands in
// the cache on the next visit; apt.js asks which version that is and offers
// a reload. This file only needs editing when its own logic changes.
'use strict';

var SHELL = 'av-shell-v1';
var API_CACHE = 'av-api-v1';
var IMG = 'av-img-v1';
var IMG_MAX = 1000;       // ~ every species at every size, a few MB at most
var API_TIMEOUT = 8000;   // a dropped Wi-Fi link can hang rather than fail

// The last background refresh of the page, so a version question waits for it.
var pageRefresh = Promise.resolve();

// Take the page and the versioned JS/CSS it loads on install, so the very
// next visit opens from the cache.
self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(refreshPage().then(function (res) { return res.clone().text(); }).then(function (html) {
    var urls = [];
    html.replace(/(?:src|href)="\.?\/?([^"]+\.(?:js|css)\?v=[^"]+)"/g, function (_, u) { urls.push('/' + u); });
    return caches.open(SHELL).then(function (c) { return c.addAll(urls); });
  }).catch(function () {}));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return /^av-/.test(k) && [SHELL, API_CACHE, IMG].indexOf(k) < 0;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  if (req.mode === 'navigate') {
    // Only the collage page; the e-ink kiosk always wants live data.
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    if (url.searchParams.has('kiosk')) return;
    var net = refreshPage();
    e.waitUntil(pageRefresh);
    e.respondWith(caches.open(SHELL).then(function (c) { return c.match('/'); })
      .then(function (hit) { return hit || net; }));
    return;
  }

  if (url.pathname === '/avian/api/birdnet-api.php') { e.respondWith(api(req, url)); return; }
  if (url.pathname === '/avian/api/cutout.php') { e.respondWith(cacheFirst(IMG, req, IMG_MAX)); return; }
  if (/\.(js|css)$/.test(url.pathname) && url.searchParams.has('v')) {
    e.respondWith(cacheFirst(SHELL, req));
  }
});

// Fetch the page and keep it as the copy to serve next time.
function refreshPage() {
  var net = fetch('/', { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (!res.ok) return res;
    var copy = res.clone();
    return caches.open(SHELL).then(function (c) { return c.put('/', copy); }).then(function () { return res; });
  });
  pageRefresh = net.catch(function () {});
  return net;
}

// Network first; the cached copy only when the Pi can't be reached, flagged
// with X-AV-Cached so the page can say it's showing old data.
function api(req, url) {
  var action = url.searchParams.get('action');
  var keep = /^(stats|lifelist|timeseries|firstseen|recent|visits|masks)$/.test(action)
    || (action === 'species' && !url.searchParams.has('from'));
  var net = new Promise(function (resolve, reject) {
    setTimeout(function () { reject(new Error('timeout')); }, API_TIMEOUT);
    fetch(req).then(resolve, reject);
  });
  return net.then(function (res) {
    // A 5xx (tailscale serve's 502 with Caddy down, PHP failing) counts as
    // unreachable too.
    if (res.status >= 500) throw new Error('status ' + res.status);
    if (keep && res.ok) {
      var copy = res.clone();
      caches.open(API_CACHE).then(function (c) { return c.put(url.href, copy); });
    }
    return res;
  }).catch(function (err) {
    return caches.open(API_CACHE).then(function (c) { return c.match(url.href); }).then(function (hit) {
      if (!hit) throw err;
      var headers = new Headers(hit.headers);
      headers.set('X-AV-Cached', '1');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: headers });
    });
  });
}

// Keyed by URL string, so the images' Vary: Accept never splits the cache.
// A newer ?v= of a script or stylesheet replaces the older one.
function cacheFirst(name, req, max) {
  var key = req.url;
  return caches.open(name).then(function (c) {
    return c.match(key).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res.status >= 500) throw new Error('status ' + res.status);
        if (res.ok && res.type === 'basic') {
          var copy = res.clone();
          c.put(key, copy).then(function () { return tidy(c, key, max); });
        }
        return res;
      }).catch(function (err) {
        return name === IMG ? anyCachedBird(c, key, err) : Promise.reject(err);
      });
    });
  });
}
// Offline, a bird drawn at a size (or pose) not seen before still gets a
// picture: the same pose at another size, else any pose of that bird.
function anyCachedBird(c, key, err) {
  var want = new URL(key).searchParams;
  return c.keys().then(function (keys) {
    var same = keys.filter(function (k) {
      return new URL(k.url).searchParams.get('sci') === want.get('sci');
    });
    var pose = same.filter(function (k) {
      return new URL(k.url).searchParams.get('pose') === want.get('pose');
    });
    var pick = pose[0] || same[0];
    if (!pick) throw err;
    return c.match(pick);
  });
}
function tidy(c, key, max) {
  return c.keys().then(function (keys) {
    if (max) {
      // Oldest first (insertion order); drop the overflow.
      return Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map(function (k) { return c.delete(k); }));
    }
    var path = new URL(key).pathname;
    return Promise.all(keys.filter(function (k) {
      return k.url !== key && new URL(k.url).pathname === path;
    }).map(function (k) { return c.delete(k); }));
  });
}

// apt.js asks which apt.js version the newest page loads (on load, and when
// a long-open tab comes back); if it differs from the running one, a deploy
// has landed and it offers a reload. Re-fetch the page first so a tab left
// open for days still finds out.
self.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'version?' || !e.ports[0]) return;
  var port = e.ports[0];
  e.waitUntil(refreshPage().catch(function () {}).then(function () { return caches.open(SHELL); })
    .then(function (c) { return c.match('/'); })
    .then(function (hit) { return hit ? hit.text() : ''; })
    .then(function (html) {
      var m = html.match(/apt\.js\?v=([\w.-]+)/);
      port.postMessage({ v: m ? m[1] : null });
    }, function () { port.postMessage({ v: null }); }));
});
