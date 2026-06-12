(function () {
  var PLACEHOLDER = [{"sci":"Calypte anna","com":"Anna's Hummingbird","featured":true},{"sci":"Passer domesticus","com":"House Sparrow"},{"sci":"Haemorhous mexicanus","com":"House Finch"},{"sci":"Turdus migratorius","com":"American Robin"},{"sci":"Zenaida macroura","com":"Mourning Dove"},{"sci":"Spinus psaltria","com":"Lesser Goldfinch"},{"sci":"Zonotrichia leucophrys","com":"White-crowned Sparrow"},{"sci":"Aphelocoma californica","com":"California Scrub-Jay"},{"sci":"Mimus polyglottos","com":"Northern Mockingbird"},{"sci":"Sayornis nigricans","com":"Black Phoebe"},{"sci":"Larus occidentalis","com":"Western Gull"},{"sci":"Corvus brachyrhynchos","com":"American Crow"}];
  // Bumped whenever the offline sketch build changes, so the browser
  // doesn't keep a stale cache after we regenerate the sketches.
  var SKETCH_VERSION = 'r11'; // pruned to East Sussex species (168); non-local
                              // birds, legacy sketches, and photo cutouts dropped.
  // Cache-bust for /api/img - bump whenever a bird gets re-rendered via
  // /api/regen or whenever you need every CF DC to drop its cached copy.
  // Cloudflare keys on the full URL incl. query, so bumping this is
  // equivalent to a global cache purge for /api/img. (caches.default
  // .delete() in the worker only affects ONE colo at a time, so a
  // versioned URL is the only reliable way to invalidate everywhere.)
  var IMG_VERSION = 'r11'; // pruned to East Sussex species; drop cached copies
                           // of removed birds everywhere.

  // ---- Sliding pill helper ----
  // Each segmented control has a single .seg-pill element that we move via
  // transform/width to whichever button currently has aria-current="true".
  // This gives an iOS-style smooth slide instead of a hard snap.
  function syncPill(container) {
    var pill = container.querySelector('.seg-pill');
    var active = container.querySelector('button[aria-current="true"]');
    if (!pill || !active) return;
    // offsetLeft is relative to the container (we set position:relative on it).
    pill.style.width = active.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
  }

  // Clicking the open space of a segmented toggle (not a specific option)
  // advances to the next available option, cycling. Clicking an option
  // still jumps straight to it - we just synthesize a click on the next
  // button so its existing handler runs.
  function wireToggleAdvance(container) {
    if (!container || container.__advanceWired) return;
    container.__advanceWired = true;
    container.addEventListener('click', function (ev) {
      if (ev.target.closest('button')) return;   // a specific option was clicked
      var btns = [].slice.call(container.querySelectorAll('button')).filter(function (b) {
        return !b.disabled && b.getAttribute('data-unavailable') !== 'true';
      });
      if (btns.length < 2) return;
      var cur = -1;
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('aria-current') === 'true') { cur = i; break; }
      }
      btns[(cur + 1) % btns.length].click();
    });
  }

  // ---- Slider ----
  var views = document.getElementById('views');
  var slider = document.getElementById('slider');
  var btns = [].slice.call(slider.querySelectorAll('button'));
  var winPick = document.getElementById('winPick');

  // Each view's title text. The shared static-head shows one of these
  // based on the current view; identical adjacent values mean the title
  // stays put with no fade (collage and stats both say Heard Recently).
  var VIEW_TITLES = ['Heard Recently', 'Heard Recently', 'Avian Visitors'];
  var staticHead = document.querySelector('.static-head');
  var staticTitle = document.getElementById('staticTitle');
  function setTitleForView(i) {
    var next = VIEW_TITLES[i];
    if (!staticTitle || staticTitle.textContent === next) return;
    // Fade out -> swap text -> fade in. The opacity transition is 240ms;
    // we swap at ~half that so the eye doesn't catch the text change.
    staticHead.classList.add('swap-out');
    setTimeout(function () {
      staticTitle.textContent = next;
      // Force reflow before removing class so the transition restarts.
      void staticHead.offsetWidth;
      staticHead.classList.remove('swap-out');
    }, 220);
  }

  // The views slide horizontally over SLIDE_MS (see .views transition). For
  // stats + atlas we hold the load-in hidden until the slide has essentially
  // settled, so you watch the content populate *in* the view rather than it
  // finishing mid-slide. The lead is a touch under SLIDE_MS so the cascade
  // begins just as the view arrives - no dead pause, still snappy. Collage's
  // bloom reads fine mid-slide, so it starts immediately (no lead). Stats
  // reads as starting a hair slower than atlas, so it gets a shorter lead.
  var SLIDE_MS = 480;
  var SWITCH_LEAD = SLIDE_MS - 100;   // atlas
  var STATS_LEAD = SLIDE_MS - 200;    // stats - begin a touch sooner
  var currentView = 0;                // collage shows first (no go() needed)
  function go(i) {
    i = Math.max(0, Math.min(2, i));
    // Only a genuine view *switch* replays the entrance. go() also fires when
    // a card is expanded (it sets the #sci= hash, which routes through go(2))
    // while already on the atlas - that must not retrigger the load-in.
    var switching = (i !== currentView);
    currentView = i;
    views.style.transform = 'translateX(-' + (i * 100) + '%)';
    btns.forEach(function (b, j) { b.setAttribute('aria-current', j === i ? 'true' : 'false'); });
    syncPill(slider);
    setTitleForView(i);
    if (!switching) return;
    // Replay the view's entrance animation on switch (collage bloom,
    // stats left-to-right, atlas row-by-row).
    if (i === 0) playCollageEntrance();
    else if (i === 1) playStatsEntrance(STATS_LEAD);
    else if (i === 2) playAtlasEntrance(SWITCH_LEAD);
  }
  btns.forEach(function (b) { b.addEventListener('click', function () { go(+b.dataset.i); }); });

  // ---- Window picker ----
  // Persist selections across reloads so a returning visitor lands on the
  // same view they left. Keys are namespaced so a future schema change
  // can be invalidated by bumping the prefix.
  function readLS(k, fallback) { try { return localStorage.getItem(k) || fallback; } catch (e) { return fallback; } }
  function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  // ---- Single-audio coordinator ----
  // Only one source plays at a time across the whole app: atlas-card
  // playback, modal recording playback, and the live stream each call
  // audioClaim(theirStopFn) the moment they start, which stops whatever
  // else was playing, and audioRelease(theirStopFn) when they stop on
  // their own. Keeps "start a new one -> the old one pauses" true even
  // across those three independent players.
  var __audioActiveStop = null;
  function audioClaim(stopSelf) {
    if (__audioActiveStop && __audioActiveStop !== stopSelf) {
      var prev = __audioActiveStop;
      __audioActiveStop = null;
      try { prev(); } catch (e) {}
    }
    __audioActiveStop = stopSelf;
  }
  function audioRelease(stopSelf) {
    if (__audioActiveStop === stopSelf) __audioActiveStop = null;
  }

  // ---- Theme (light / charcoal dark) ----
  // A per-device preference (localStorage), applied as data-theme on
  // <html>. An inline script in index.html sets it before first paint to
  // avoid a flash; this keeps it in sync and powers the Settings switcher.
  function applyTheme(name) {
    var t = name === 'dark' ? 'dark' : 'light';
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    writeLS('bird:theme', t);
  }
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  applyTheme(readLS('bird:theme', 'light'));
  var winBtns = [].slice.call(winPick.querySelectorAll('button'));
  var currentHours = +readLS('bird:window', '24') || 24;
  winBtns.forEach(function (b) {
    b.setAttribute('aria-current', (+b.dataset.h === currentHours) ? 'true' : 'false');
  });
  winBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      winBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
      currentHours = +b.dataset.h;
      writeLS('bird:window', String(currentHours));
      syncPill(winPick);
      // Actual data refresh is wired below via refreshRecent().
    });
  });

  // Initial pill placement (after layout settles) + on resize.
  // Atlas sort segmented control - same pill-on-recess pattern.
  var atlasSortEl = document.getElementById('atlasSort');
  var atlasSortBtns = atlasSortEl ? [].slice.call(atlasSortEl.querySelectorAll('button')) : [];
  window.__atlasSort = readLS('bird:atlasSort', 'count');
  atlasSortBtns.forEach(function (b) {
    b.setAttribute('aria-current', (b.dataset.sort === window.__atlasSort) ? 'true' : 'false');
  });
  atlasSortBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      atlasSortBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
      window.__atlasSort = b.dataset.sort;
      writeLS('bird:atlasSort', window.__atlasSort);
      syncPill(atlasSortEl);
      // Re-render the atlas with new sort, replaying the row-by-row
      // cascade so a filter change reads as a fresh stack load-in.
      renderAtlas(true);
    });
  });

  // Open-space click advances these segmented toggles to the next option.
  wireToggleAdvance(slider);
  wireToggleAdvance(winPick);
  wireToggleAdvance(atlasSortEl);
  wireToggleAdvance(document.getElementById('modalPoseToggle'));
  function syncAllPills() { syncPill(slider); syncPill(winPick); if (atlasSortEl) syncPill(atlasSortEl); }
  // The buttons size from text content; wait for fonts so width is correct.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncAllPills);
  }
  // Also sync after layout is definitely done.
  requestAnimationFrame(function () { requestAnimationFrame(syncAllPills); });
  var pillTimer;
  window.addEventListener('resize', function () {
    clearTimeout(pillTimer);
    pillTimer = setTimeout(syncAllPills, 80);
  });

  // ---- Raster-bitmask collage with bird-shaped nesting ----
  // Each species ships a low-res binary alpha mask (cutout_masks.ts) that
  // matches the bird's actual outline. The layout maintains an occupancy
  // grid at viewport resolution; for each tile we spiral outward from the
  // cluster centre and pick the closest position where the tile's mask
  // doesn't overlap any already-placed mask. Result: birds nest into each
  // other's concavities (wing arc cradles tail, etc.) with a small visual
  // gap baked into the mask via Python-side dilation. No bbox overlap, no
  // rectangles touching - actual polygon-aware packing.

  var collage = document.getElementById('collage');
  var DIMS = {"acanthis-flammea-2":[560,398],"acanthis-flammea":[560,400],"accipiter-nisus-2":[560,445],"accipiter-nisus":[330,560],"acrocephalus-schoenobaenus-2":[560,491],"acrocephalus-schoenobaenus":[560,387],"acrocephalus-scirpaceus-2":[554,560],"acrocephalus-scirpaceus":[560,433],"actitis-hypoleucos-2":[560,550],"actitis-hypoleucos":[560,492],"actitis-macularius-2":[560,544],"actitis-macularius":[560,469],"aegithalos-caudatus-2":[523,560],"aegithalos-caudatus":[346,560],"aix-galericulata-2":[524,560],"aix-galericulata":[560,542],"aix-sponsa-2":[560,444],"aix-sponsa":[560,503],"alauda-arvensis-2":[560,501],"alauda-arvensis":[560,443],"alcedo-atthis-2":[560,479],"alcedo-atthis":[560,465],"alectoris-rufa-2":[526,560],"alectoris-rufa":[460,560],"alopochen-aegyptiaca-2":[549,560],"alopochen-aegyptiaca":[560,547],"anas-acuta-2":[560,390],"anas-acuta":[560,338],"anas-crecca-2":[544,560],"anas-crecca":[560,398],"anas-platyrhynchos-2":[560,404],"anas-platyrhynchos":[556,560],"anser-albifrons-2":[560,427],"anser-albifrons":[499,560],"anser-anser-2":[555,560],"anser-anser":[535,560],"anthus-petrosus-2":[560,501],"anthus-petrosus":[560,429],"anthus-pratensis-2":[460,560],"anthus-pratensis":[560,434],"anthus-trivialis-2":[560,485],"anthus-trivialis":[560,510],"apus-apus-2":[560,411],"apus-apus":[560,497],"ardea-alba-2":[488,560],"ardea-alba":[283,560],"ardea-cinerea-2":[560,505],"ardea-cinerea":[388,560],"arenaria-interpres-2":[495,560],"arenaria-interpres":[560,404],"asio-flammeus-2":[560,484],"asio-flammeus":[335,560],"asio-otus-2":[490,560],"asio-otus":[324,560],"aythya-affinis-2":[560,408],"aythya-affinis":[560,469],"aythya-collaris-2":[560,442],"aythya-collaris":[560,405],"aythya-ferina-2":[560,507],"aythya-ferina":[560,363],"aythya-fuligula-2":[543,560],"aythya-fuligula":[560,380],"bombycilla-garrulus-2":[560,459],"bombycilla-garrulus":[560,555],"branta-bernicla-2":[560,381],"branta-bernicla":[526,560],"branta-canadensis-2":[560,485],"branta-canadensis":[522,560],"branta-leucopsis-2":[560,408],"branta-leucopsis":[499,560],"bucephala-clangula-2":[560,486],"bucephala-clangula":[560,509],"buteo-buteo-2":[560,461],"buteo-buteo":[464,560],"buteo-lagopus-2":[480,560],"buteo-lagopus":[452,560],"calidris-alba-2":[473,560],"calidris-alba":[560,485],"calidris-alpina-2":[531,560],"calidris-alpina":[560,443],"calidris-pugnax-2":[560,553],"calidris-pugnax":[524,560],"carduelis-carduelis-2":[560,461],"carduelis-carduelis":[497,560],"certhia-familiaris-2":[560,453],"certhia-familiaris":[292,560],"cettia-cetti-2":[560,534],"cettia-cetti":[530,560],"charadrius-hiaticula-2":[482,560],"charadrius-hiaticula":[560,449],"chloris-chloris-2":[560,503],"chloris-chloris":[560,523],"chroicocephalus-ridibundus-2":[560,515],"chroicocephalus-ridibundus":[560,450],"circus-aeruginosus-2":[560,510],"circus-aeruginosus":[369,560],"columba-livia-2":[560,408],"columba-livia":[525,560],"columba-oenas-2":[560,499],"columba-oenas":[528,560],"columba-palumbus-2":[512,560],"columba-palumbus":[560,511],"corvus-corax-2":[351,560],"corvus-corax":[492,560],"corvus-corone-2":[560,319],"corvus-corone":[548,560],"corvus-frugilegus-2":[354,560],"corvus-frugilegus":[560,478],"cuculus-canorus-2":[560,422],"cuculus-canorus":[348,560],"curruca-communis-2":[560,472],"curruca-communis":[560,436],"curruca-curruca-2":[483,560],"curruca-curruca":[560,515],"cyanistes-caeruleus-2":[551,560],"cyanistes-caeruleus":[560,417],"cygnus-olor-2":[560,407],"cygnus-olor":[491,560],"delichon-urbicum-2":[540,560],"delichon-urbicum":[560,443],"dendrocopos-major-2":[560,457],"dendrocopos-major":[341,560],"egretta-garzetta-2":[466,560],"egretta-garzetta":[394,560],"emberiza-calandra-2":[528,560],"emberiza-calandra":[540,560],"emberiza-citrinella-2":[560,516],"emberiza-citrinella":[560,430],"emberiza-schoeniclus-2":[546,560],"emberiza-schoeniclus":[560,423],"eremophila-alpestris-2":[560,425],"eremophila-alpestris":[560,437],"erithacus-rubecula-2":[505,560],"erithacus-rubecula":[560,469],"falco-columbarius-2":[463,560],"falco-columbarius":[353,560],"falco-peregrinus-2":[560,499],"falco-peregrinus":[393,560],"falco-subbuteo-2":[560,448],"falco-subbuteo":[260,560],"falco-tinnunculus-2":[560,433],"falco-tinnunculus":[285,560],"fringilla-coelebs-2":[457,560],"fringilla-coelebs":[560,384],"fulica-atra-2":[560,266],"fulica-atra":[560,518],"fulmarus-glacialis-2":[388,560],"fulmarus-glacialis":[560,323],"gallinago-gallinago-2":[560,511],"gallinago-gallinago":[560,511],"gallinula-chloropus-2":[560,557],"gallinula-chloropus":[546,560],"garrulus-glandarius-2":[560,413],"garrulus-glandarius":[560,560],"gavia-immer-2":[560,512],"gavia-immer":[560,228],"gavia-stellata-2":[560,536],"gavia-stellata":[560,368],"haematopus-ostralegus-2":[560,543],"haematopus-ostralegus":[560,434],"hirundo-rustica-2":[520,560],"hirundo-rustica":[420,560],"ichthyaetus-melanocephalus-2":[560,455],"ichthyaetus-melanocephalus":[560,443],"larus-argentatus-2":[560,372],"larus-argentatus":[560,501],"larus-cachinnans-2":[560,197],"larus-cachinnans":[560,489],"larus-canus-2":[506,560],"larus-canus":[560,427],"larus-delawarensis-2":[560,490],"larus-delawarensis":[560,421],"larus-fuscus-2":[490,560],"larus-fuscus":[560,440],"larus-marinus-2":[560,481],"larus-marinus":[560,533],"larus-michahellis-2":[560,256],"larus-michahellis":[560,473],"leucophaeus-atricilla-2":[539,560],"leucophaeus-atricilla":[536,560],"limosa-lapponica-2":[560,494],"limosa-lapponica":[560,306],"limosa-limosa-2":[552,560],"limosa-limosa":[560,504],"linaria-cannabina-2":[560,456],"linaria-cannabina":[560,501],"loxia-curvirostra-2":[560,492],"loxia-curvirostra":[560,393],"lullula-arborea-2":[560,404],"lullula-arborea":[560,384],"luscinia-megarhynchos-2":[560,536],"luscinia-megarhynchos":[560,451],"mareca-penelope-2":[482,560],"mareca-penelope":[560,338],"mareca-strepera-2":[560,495],"mareca-strepera":[560,463],"melanitta-nigra-2":[462,560],"melanitta-nigra":[560,409],"mergus-merganser-2":[560,464],"mergus-merganser":[370,560],"milvus-milvus-2":[333,560],"milvus-milvus":[369,560],"mniotilta-varia-2":[497,560],"mniotilta-varia":[560,330],"morus-bassanus-2":[507,560],"morus-bassanus":[560,427],"motacilla-alba-2":[560,506],"motacilla-alba":[560,348],"motacilla-cinerea-2":[560,512],"motacilla-cinerea":[560,454],"motacilla-flava-2":[560,404],"motacilla-flava":[560,364],"muscicapa-striata-2":[519,560],"muscicapa-striata":[524,560],"numenius-arquata-2":[560,443],"numenius-arquata":[485,560],"numenius-phaeopus-2":[485,560],"numenius-phaeopus":[560,510],"nycticorax-nycticorax-2":[473,560],"nycticorax-nycticorax":[472,560],"oenanthe-oenanthe-2":[560,449],"oenanthe-oenanthe":[482,560],"oenanthe-pleschanka-2":[560,274],"oenanthe-pleschanka":[438,560],"pandion-haliaetus-2":[495,560],"pandion-haliaetus":[501,560],"parus-major-2":[560,503],"parus-major":[560,415],"passer-domesticus-2":[541,560],"passer-domesticus":[560,457],"periparus-ater-2":[463,560],"periparus-ater":[560,409],"phalacrocorax-carbo-2":[444,560],"phalacrocorax-carbo":[337,560],"phasianus-colchicus-2":[432,560],"phasianus-colchicus":[326,560],"phoenicurus-ochruros-2":[560,467],"phoenicurus-ochruros":[370,560],"phoenicurus-phoenicurus-2":[491,560],"phoenicurus-phoenicurus":[560,551],"phylloscopus-collybita-2":[560,388],"phylloscopus-collybita":[560,470],"phylloscopus-trochilus-2":[560,490],"phylloscopus-trochilus":[528,560],"pica-pica-2":[537,560],"pica-pica":[360,560],"picus-viridis-2":[530,560],"picus-viridis":[331,560],"pluvialis-apricaria-2":[560,545],"pluvialis-apricaria":[510,560],"pluvialis-squatarola-2":[501,560],"pluvialis-squatarola":[560,531],"podiceps-cristatus-2":[560,494],"podiceps-cristatus":[491,560],"podiceps-nigricollis-2":[560,486],"podiceps-nigricollis":[560,553],"poecile-palustris-2":[560,477],"poecile-palustris":[560,466],"prunella-modularis-2":[560,559],"prunella-modularis":[560,397],"pyrrhula-pyrrhula-2":[560,271],"pyrrhula-pyrrhula":[560,551],"rallus-aquaticus-2":[513,560],"rallus-aquaticus":[560,542],"recurvirostra-avosetta-2":[451,560],"recurvirostra-avosetta":[446,560],"regulus-ignicapilla-2":[560,463],"regulus-ignicapilla":[560,398],"regulus-regulus-2":[449,560],"regulus-regulus":[560,336],"riparia-riparia-2":[546,560],"riparia-riparia":[533,560],"rissa-tridactyla-2":[560,416],"rissa-tridactyla":[560,436],"saxicola-rubetra-2":[560,466],"saxicola-rubetra":[560,435],"saxicola-rubicola-2":[560,455],"saxicola-rubicola":[560,481],"sitta-europaea-2":[466,560],"sitta-europaea":[560,367],"spatula-clypeata-2":[560,455],"spatula-clypeata":[532,560],"spinus-spinus-2":[560,544],"spinus-spinus":[560,444],"stercorarius-parasiticus-2":[382,560],"stercorarius-parasiticus":[560,444],"stercorarius-pomarinus-2":[379,560],"stercorarius-pomarinus":[560,389],"sterna-hirundo-2":[324,560],"sterna-hirundo":[560,282],"sternula-albifrons-2":[560,438],"sternula-albifrons":[560,387],"streptopelia-decaocto-2":[560,423],"streptopelia-decaocto":[560,394],"sturnus-vulgaris-2":[560,494],"sturnus-vulgaris":[560,549],"sylvia-atricapilla-2":[560,546],"sylvia-atricapilla":[560,373],"sylvia-borin-2":[560,526],"sylvia-borin":[560,398],"tachybaptus-ruficollis-2":[560,479],"tachybaptus-ruficollis":[560,466],"tadorna-tadorna-2":[560,389],"tadorna-tadorna":[560,486],"thalasseus-sandvicensis-2":[443,560],"thalasseus-sandvicensis":[560,345],"tringa-nebularia-2":[480,560],"tringa-nebularia":[519,560],"tringa-ochropus-2":[560,530],"tringa-ochropus":[560,444],"tringa-totanus-2":[504,560],"tringa-totanus":[545,560],"troglodytes-troglodytes-2":[560,555],"troglodytes-troglodytes":[560,483],"turdus-iliacus-2":[560,329],"turdus-iliacus":[560,444],"turdus-merula-2":[560,504],"turdus-merula":[560,434],"turdus-migratorius-2":[560,472],"turdus-migratorius":[541,560],"turdus-philomelos-2":[560,521],"turdus-philomelos":[560,412],"turdus-pilaris-2":[486,560],"turdus-pilaris":[560,497],"turdus-torquatus-2":[560,319],"turdus-torquatus":[560,424],"turdus-viscivorus-2":[506,560],"turdus-viscivorus":[544,560],"tyto-alba-2":[538,560],"tyto-alba":[359,560],"vanellus-vanellus-2":[397,560],"vanellus-vanellus":[535,560],"zonotrichia-albicollis-2":[560,337],"zonotrichia-albicollis":[560,347],"zonotrichia-leucophrys-2":[560,435],"zonotrichia-leucophrys":[461,560]};
  var MASKS = {"acanthis-flammea-2":{"w":93,"h":66,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAOAAAAAAAAAAAAAAHmAAAAAAAAAAAAAD7gAAAAAAAAAAAAB/4AAAAAAAAAAAAA/+gAAAAAAAAAAAAf/8AAAAAAAAAAAAP/+AAAAAAAAAAAAD//gAAAAAAAAAAAB//4AAAAAAAAAAAA///gAAAAAAAAAAAP//4AAAAAAAAAAAP//+AAAAAAAAAAAD///AAAAAAAAAAAB///4AAAAAAAAAAAf///AAAAAAAAAAAP///gAAAAAAAAAAD///4AAAAAAAAAAB///+AAAAAAAAAAAf///wAAAAAAAAAAH///4AAAAAAAAAAA///+AAAAAAAAH+AP///gAAAAAAAD/8D///wAAAAAAAA//4///8AAAAAAAAP//////AAAAAAAAD//////4AAAAAAAA//////+AAAAAAAAH//////4AAAAAAAAH//////AAAAAAAAAf/////wAAAAAAAAB//////AAAAAAAAP//////4AAAAAAAf//////+AAAAAAAP///////wAAAAAAP///////+AAAAAAP////////gAAAAAP////////8AAAAAH////////uAAAAAH////////8AAAAAH/////////wAAAAH/////////+AAAAD//////////4AAAAD//////////AAAAB9/////////8AAAAAe/////////gAAAAOP//4X////+AAAAABHOwAAp///wAAAAAAAAAAAD///AAAAAAAAAAAAf//8AAAAAAAAAAAB///gAAAAAAAAAAAP8/+AAAAAAAAAAAA8B/4AAAAAAAAAAAAAD/gAAAAAAAAAAAAAP+AAAAAAAAAAAAAB/8AAAAAAAAAAAAAH/wAAAAAAAAAAAAAf/AAAAAAAAAAAAAD/8AAAAAAAAAAAAAPvwAAAAAAAAAAAAB8PAAAAAAAAAAAAAHgAAAAAAAAAAAAAAcAAAAAAAAAAAAAADAAAAAAAAAAAAAAAIAAAA"},"acanthis-flammea":{"w":93,"h":66,"bits":"AAAAAAAAAAAAAAAAAP+AAAAAAAAAAAAAH/8AAAAAAAAAAAAB//4AAAAAAAAAAAA///gAAAAAAAAAAAP//+AAAAAAAAAAAD///4AAAAAAAAAAA////gAAAAAAAAAAf///+AAAAAAAAAAD////4AAAAAAAAAAD////gAAAAAAAAAAH///+AAAAAAAAAAA////8AAAAAAAAAAH////8AAAAAAAAAA/////8AAAAAAAAAH/////4AAAAAAAAAf/////wAAAAAAAAD//////gAAAAAAAAf//////AAAAAAAAD//////8AAAAAAAAf//////4AAAAAAAD///////gAAAAAAAf///////AAAAAAAD///////+AAAAAAAP///////4AAAAAAB////////gAAAAAAP////////AAAAAAB////////8AAAAAAP////////wAAAAAA/////////AAAAAAH////////8AAAAAAf////////wAAAAAD/////////AAAAAAP////////+AAAAAA/////////4AAAAAH/////////wAAAAAf/////////AAAAAB/////////+AAAAAH/////////4AAAAAf/////////wAAAAB/////////7AAAAAD/////////AAAAAAH////////+AAAAAAf///////+QAAAAAA////////4AAAAAAA////8H//gAAAAAAD///+AH//AAAAAAA///+AAH/8AAAAAAPD/4AAAD/4AAAAABwE/AAAAH/wAAAAAMAB4AAAAf/AAAAABwAPAAAAB/+AAAAAHADAAAAAD/4AAAAAAAwAAAAAP/wAAAAAAcAAAAAA//AAAAAAGAAAAAAB/8AAAAADgAAAAAAH/wAAAAA8AAAAAAAf4AAAAB//wAAAAAA/AAAAAfgAAAAAAAD8AAAAF4AAAAAAAAHgAAAAaAAAAAAAAAcAAAADwAAAAAAAAAAAAAACAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAA"},"accipiter-nisus-2":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAQ4AAAAAAAAAAAAADzgAAAAAAAAAAAAAHvAAAAAAAAAAAAAOf/gAAAAAAAAAAAA///AAAAAAAAAAAAB//8AAAAAAAAAAAAH//4AAAAAAAAAAAD///gAAAAAAAAAAAP///AAAAAAAAAAAA///8AAAAAAAAAAAB///4AAAAAAAAAAAP///wAAAAAAAAAAB////gAAAAAAAAAAD///+AAAAAAAAAAAP///8AAAAAAAAAAB////wAAAAAAAAAAH////AAAAAAAAAAAf///8AAAAAAAAAAA////wAAAAAAAAAAH///+AAAAAAAAAAAf///4AAAAAAAAAAA////AAAAAAAAAAAD///8AAAAAAAAAAAP///gAAAAAAAAAAA///+AAAAAAAAAAAH///4AAAAAAAAAAAf///gAAAAAAAAAAD///+HgAAAAAAAAAP/////AAAAAAAAAB/////8AAAAAAAAAH/////wAAAAAAAAAf/////AAAAAAAAAD/////4AAAAAAAAAP////+AAAAAAAAAA/////wAAAAAAAAAD////+AAAAAAAAAAH////wAAAAAAAAAAf////wAAAAAAAAAB/////8AAAAAAAAAP/////8AAAAAAAAD//////wAAAAAAAD///////AAAAAAAD///////8AAAAAAD////////wAAAAAD/////////AAAAAD/////////8AAAAB//////////wAAAAP/////////+AAAAB////8/////4AAAAP///8D/////gAAAB///+AP////+AAAAP///gAf////4AAAA///8AA/////gAAAH///AAA////+AAAAf//wAAB////4AAAA//+AAAB////AAAAH//gAAAD///8AAAAf/4AAAAD///wAAAAf+AAAAAP///AAAAD/wAAAAAf//8AAAAD8AAAAAB//+gAAAAAAAAAAAH//4AAAAAAAAAAAAH//gAAAAAAAAAAAAf/+AAAAAAAAAAAAAP+wAAAAAAAAAAAAA37AAAAAAAAAAAAACbgAAAAAAAAAAAAABsAAAAAAAAAAAAAAEQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"accipiter-nisus":{"w":55,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAA+AAAAAAAD/4AAAAAAD//AAAAAAD//wAAAAAD//4AAAAAD//+AAAAAD///AAAAAD///gAAAAB///4AAAAB///8AAAAB///2AAAAB///4AAAAB///8AAAAB///8AAAAB///+AAAAB////AAAAB////wAAAB////4AAAB////8AAAB////+AAAB/////AAAB/////wAAB/////wAAA/////4AAA/////8AAAf////+AAAf/////AAAP/////AAAP/////gAAH/////gAAD/////wAAD/////wAAB/////4AAA/////4AAA/////8AAAf////8AAAP////+AAAH/////AAAH/////AAAD/////gAAB/////gAAB/////gAAA/////wAAAf////wAAAP////wAAAP////4AAAH////4AAAD////8AAAB////+AAAA/////AAAAf////gAAAP////gAAAP////wAAAH////+AAAH/////gAAD/////wAAB/////4AAB///8/8AAA///+f8AAA///zn8AAAf//wwcAAAf//wYAAAAP//x+AAAAO//53AAAAG//4xwAAAHf/4T4AAADd/4H8AAABM/8B+AAAAEf8A+AAAAAP+AcAAAAAP/AAAAAAAH/gAAAAAAD/gAAAAAAB/wAAAAAAA/4AAAAAAA/4AAAAAAAf8AAAAAAAP+AAAAAAAH+AAAAAAAH/AAAAAAAD/gAAAAAAB/gAAAAAAA/wAAAAAAA/4AAAAAAAf4AAAAAAAP8AAAAAAAH8AAAAAAAD8AAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"acrocephalus-schoenobaenus-2":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAADAAAAAAAAAAAAAAGfAAAAAAAAAAAAAAf+AAAAAAAAAAAAAB/4AAAAAAAAAAAABv/wAAAAAAAAAAAAH//gAAAAAAAAAAAAf//AAAAAAAAAAAAB//8AAAAAAAAAAAAH//4AAAAAAAAAAAD///gAAAAAAAAAAAP///AAAAAAAAAAAAf//8AAAAAAAAAAAD///wAAAAAAAAAAAf///gAAAAAAAAAAD////AAAAAAAAAAAH///8AAAAAAAAAAA////wAAAAAAAAAAH////AAAAAAAAAAAf///+AAAAAAAAAAB////wAAAAAAAAAAH////AAH4AAAAAAAf///8AD/wAAAAAAB////gB//gAAAAAAH///+Af/+AAAAAAAf///4P//+AAAAAAB////j///8AAAAAAH///////8AAAAAAA///////+AAAAAAAH///////gAAAAAAA///////4AAAAAAAD///////AAAAAAAA///////wAAAAAAAD//////8AAAAAAAAf//////gAAAAAAAD//////4AAAAAAAAf//////AAAAAAAAB///////AAAAAAAAP///////4AAAAAAA////////wAAAAAAH////////AAAAAAAf///////8AAAAAAB////////wAAAAAAHz///////AAAAAAAAf//////4AAAAAAAD///////gAAAAAAA///////+AAAAAAAH///////wAAAAAAB////////AAAAAAAP///////8AAAAAAB////////wAAAAAAP////////AAAAAAD////////4AAAAAAf////////gAAAAAH////////+AAAAAB/////////4AAAAAf/////////AAAAAH/////////8AAAAB//+/P/////wAAAAf//HwAAf//+AAAAH//A4AAA///4AAAB//wAAAAD///gAAAf/+AAAAAP//8AAAH//gAAAAAf//wAAB//4AAAAAB///AAAf//AAAAAAH//YAAH//wAAAAAAH/dgAB//8AAAAAAA3ZgAAP//gAAAAAAAbmAAD//4AAAAAAABOQAA//+AAAAAAAAAQAAAA/wAAAAAAAAAAAAAH8AAAAAAAAAAAAAA/AAAAAAAAAAAAAAHwAAAAAAAAAAAAAAeAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"acrocephalus-schoenobaenus":{"w":93,"h":64,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAB/8AAAAAAAAAAAAA//4AAAAAAAAAAAAf//gAAAAAAAAAAAH//+AAAAAAAAAAAB////gAAAAAAAAAAf////AAAAAAAAAAH////gAAAAAAAAAB////AAAAAAAAAAD////wAAAAAAAAAB////8AAAAAAAAAA/////AAAAAAAAAAf////4AAAAAAAAAP////+AAAAAAAAAD/////wAAAAAAAAB/////8AAAAAAAAA//////gAAAAAAAAf/////8AAAAAAAAP//////gAAAAAAAD//////8AAAAAAAB///////AAAAAAAAf//////4AAAAAAAH///////AAAAAAAB///////4AAAAAAAf//////+AAAAAAAH///////wAAAAAAD///////8AAAAAAA////////gAAAAAAf///////4AAAAAAf///////+AAAAAAf////////wAAAAAf////////8AAAAAP////////+AAAAAP/////////gAAAAH//z//////4AAAAH//4AD////8AAAAD//8AAH///+AAAAA//8AAAP///gAAAAA/+AAAA///wAAAAAP/AAAAAf/wAAAAAD/gAAAADv+AAAAAAfgAAAAAcB+AAAAADwAAAAABw/4AAAAAAAAAAAAH8OAAAAAAAAAAAAAOBwAAAAAAAAAAAAA4eAAAAAAAAAAAAAEywAAAAAAAAAAAAATEAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAf4AAAAAAAAAAAAAeHwAAAAAAAAAAAADAeAAAAAAAAAAAAAQDwAAAAAAAAAAAADAMAAAAAAAAAAAAAADgAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"acrocephalus-scirpaceus-2":{"w":92,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAQwAAAAAAAAAAAAAMcQAAAAAAAAAAAAHOMAAAAAAAAAAAADnmAAAAAAAAAAAAA5zgAAAAAAAAAAAAe9wAAAAAAAAAAAAPe8wAAAAAAAAAAAH/+YAAAAAAAAAAAD//uAAAAAAAAAAAA///AAAAAAAAAAAAf//wAAAAAAAAAAAP//6AAAAAAAAAAAH///gAAAAAAAAAAB///wAAAAAAAAAAA///8AAAAAAAAAAAf//+AAAAAAAAAAAP///gAAAAAAAAAAD///4AAAAAAAAAAB///+AAAAAAAAAAA////gAAAAAAAAAAf///wAAAAAAAAAAP///4AAAAAAAAAAD///+AAAAAAAAAAB////gAAAAAAAAAA////wAAAAAAAAAAf///8AAAAAAAAAAH///+AAAAAAAAAAD////AAAAAAAAAAA////wAAAAAAAAAAf///4AAAAAAAAAAP///8AAAAAAAAfwD///+AAAAAAAA//g////gAAAAAAAf/+f///wAAAAAAAf//////8AAAAAAAP///////gAAAAAAP///////wAAAAAAf///////8AAAAAAP////////gAAAAAAD///////4AAAAAAAf//////8AAAAAAAD///////gAAAAAAAf//////4AAAAAAAD//////+AAAAAAAAf//////AAAAAAAAH//////wAAAAAAAA//////8AAAAAAAAP//////AAAAAAAAD//////gAAAAAAAP//////4AAAAAAAP//////+AAAAAAAH/////+eAAAAAAAH//////jAAAAAAAD//////8AAAAAAAB///////gAAAAAAA///////4AAAAAAAf///////AAAAAAAP///////wAAAAAAH///////8AAAAAAD////////gAAAAAB////////4AAAAAA////////+AAAAAAf////////wAAAAAP////////8AAAAAH/////////gAAAAD//////z//8AAAAB//////4///gAAAB//////8f//4AAAA//////8H5//AAAAf/////4HnP/4AAAP////+QD4T//AAAH////wAB/Af/4AAD////4AAJ8H//AAB////4AADJA//4AB////+AAAzAP//AA////8AAAOYB//wAd////AAABxAf/+AA////gAAAMAD//wAe9/uAAAAAgA//+AOed7AAAAAAAH//gGPOcgAAAAAAB//4ADnMAAAAAAAAP/8ABjCAAAAAAAAB/gAAAAAAAAAAAAAfwAAAAAAAAAAAAAD4AAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"acrocephalus-scirpaceus":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAAAAAAH/4AAAAAAAAAAAAD//wAAAAAAAAAAAB///AAAAAAAAAAAA///8AAAAAAAAAAAP///wAAAAAAAAAAD////8AAAAAAAAAA/////4AAAAAAAAAP/////AAAAAAAAAD////8AAAAAAAAAB/////AAAAAAAAAB/////wAAAAAAAAA/////+AAAAAAAAAf/////gAAAAAAAAP/////8AAAAAAAAD//////AAAAAAAAB//////4AAAAAAAAf/////+AAAAAAAAH//////wAAAAAAAD//////+AAAAAAAA///////gAAAAAAAf//////8AAAAAAAP///////gAAAAAAD///////8AAAAAAA////////gAAAAAAP///////4AAAAAAD////////AAAAAAA////////4AAAAAAP///////+AAAAAAB////////wAAAAAAf///////8AAAAAAD////////gAAAAAAf///////4AAAAAAH///////+AAAAAAB////////wAAAAAAf///////8AAAAAAH////////AAAAAAD////////wAAAAAAH///////8AAAAAAB////////AAAAAAA////////gAAAAAAP///////4AAAAAAD///////8AAAAAAB//8P////AAAAAAAf/8Af///gAAAAAAH/4AAP//gAAAAAAD/4AAB//4AAAAAAA/+AAAP+B4AAAAAAP/gAAB8ADwAAAAAD/4AAAHgADwAAAAA/+AAAAOAAfAAAAAP/gAAAA4A/8AAAAD/4AAAABgPDwAAAA/+AAAAAHCAeAAAAH/AAAAAAcQDwAAAB/wAAAAABwCcAAAAHwAAAAAADgPAAAAAAAAAAAAAeB4AAAAAAAAAAAAP4bAAAAAAAAAAAAfHgQAAAAAAAAAAADgcEAAAAAAAAAAAAgTgAAAAAAAAAAAAAC8AAAAAAAAAAAAAAfAAAAAAAAAAAAAADwAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"actitis-hypoleucos-2":{"w":93,"h":91,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAeAAAAAAAAAAAAAADgAAAAAAAAAAAAAA8AAAAAAAHAAAAAAPwAAAAAAHwAAAAAB+AAAAAAH8AAAAAAfwAAAAAH/wAAAAAH/AAAAAD/8AAAAAA/4AAAAB//AAAAAAP+AAAAA//wAAAAAB/4AAAAf/+AAAAAAf/AAAAP//gAAAAAD/4AAAH//4AAAAAA//AAAD//+AAAAAAH/4AAA///gAAAAAB//AAAf//8AAAAAAP/4AAP///AAAAAAB//AAD///wAAAAAAf/4AB///8AAAAAAD//AAf///AAAAAAA//4AH///4AAAAAAH//AB///+AAAAAAA//4A////gAAAAAAP//AP///4AAAAAAB//4D////AAAAAAAP/+A////wAAAAAAB//wP///4AAAAAAAf/+D///+AAAAAAAD//4////gAAAAAAAf//P///wAAAAAAAH//9///8AAAAAAAA///////AAAAAAAAH//////gAAAAAAAA//////8AAAAAAAAD//////gAAAAAAAAf/////4AAAAAAAAB//////gAAAAAAAAH/////8AAAAAAAAAf/////AAAAAAAAAB/////8AAAAAAAAAH/////gAAAAAAAAA/////4AAAAAAAAAH/////gAAAAAAAf4f////8AAAAAAAP///////AAAAAAAD///////4AAAAAAA////////AAAAAAAH///////4AAAAAAB////////AAAAAAAP///////4AAAAAAH////////AAAAAAB////////4AAAAAB/////////AAAAAA+A///////8AAAAAeAB///////gAAAAHAAD//////+AAAAAAAAP//////4AAAAAAAA///////AAAAAAAAD//////8AAAAAAAAP//////wAAAAAAAA/////z/gAAAAAAAD////4B+AAAAAAAAP///+AB8AAAAAAAAf///gAD8AAAAAAAA///wGAP+AAAAAAAB//wAwAf+AAAAAAAB/2AAAA/8AAAAAAAB+GAEAB/gAAAAAAAAZvg4HH4AAAAAAAAAAf/gf+AAAAAAAAAAADuAfgAAAAAAAAAAAM4AMAAAAAAAAAAAAzAAAAAAAAAAAAAADEAAAAAAAAAAAAAAMQAAAAAAAAAAAAAAzAAAAAAAAAAAAAADMAAAAAAAAAAAAAAI/gAAAAAAAAAAAAA/gAAAAAAAAAAAAAHPgAAAAAAAAAAAAAefAAAAAAAAAAAAAA88AAAAAAAAAAAAABw4AAAAAAAAAAAAADBgAAAAAAAAAAAAAOAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"actitis-hypoleucos":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAf4AAAAAAAAAAAAAP/gAAAAAAAAAAAAD//AAAAAAAAAAAAA//4AAAAAAAAAAAAH//gAAAAAAAAAAAB//8AAAAAAAAAAAAP//wAAAAAAAAAAAH//+AAAAAAAAAAAH///4AAAAAAAAAAD+D//gAAAAAAAAAD8AH//wAAAAAAAAD4AAf///wAAAAAAA4AAB////4AAAAAAAAAAH////8AAAAAAAAAA/////4AAAAAAAAAH/////wAAAAAAAAA//////wAAAAAAAAH//////wAAAAAAAA///////4AAAAAAAH///////8AAAAAAA//////////4AAAAH//////////gAAAA//////////4AAAAH//////////AAAAAf/////////AAAAAD/////////AAAAAAf////////8AAAAAD/////////AAAAAAf////////AAAAAAB////////AAAAAAAP///////wAAAAAAB///////4AAAAAAAP//////8AAAAAAAA///////AAAAAAAAP//////gAAAAAAAA//////4AAAAAAAAB/////+AAAAAAAAAH/////gAAAAAAAAAP////wAAAAAAAAAAP///wAAAAAAAAAAAP//4AAAAAAAAAAAAH/8gAAAAAAAAAAAAD+OAAAAAAAAAAAAAPwwAAAAAAAAAAAAAAOAAAAAAAAAAAAAAXgAAAAAAAAAAAAAPgAAAAAAAAAAAAADwAAAAAAAAAAAAADzAAAAAAAAAAAAAD4YAAAAAAAAAAAAA8DAAAAAAAAAAAAAPgYAAAAAAAAAAAAB0DAAAAAAAAAAAAAewYAAAAAAAAAAAADwCAAAAAAAAAAAAAeAQAAAAAAAAAAAADcGAAAAAAAAAAAAAYAwAAAAAAAAAAAADAGAAAAAAAAAAAAAYAwAAAAAAAAAAAABAGAAAAAAAAAAAAAEAgAAAAAAAAAAAAAAEAAAAAAAAAAAAAABgAAAAAAAAAAAAAAMAAAAAAAAAAAAAABwAAAAAAAAAAAAAAfgAAAAAAAAAAAAAfgAAAAAAAAAAAAA/4AAAAAAAAAAAAAAPAAAAAAAAAAAAAAGQAAAAAAAAAAAAADmAAAAAAAAAAAAABwgAAAAAAAAAAAAB4IAAAAAAAAAAAAAACAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"actitis-macularius-2":{"w":93,"h":90,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAf/+AAAAAAAAAAAD///gAAAAAAAAAAP///4AAAAAAAAAAf///8AAAAAAAAAA////+AAAAAAAAAA/////gAAAAAAAAAf////wAAAAAAAAAf////8AAAAAAAAAP////+AAAAAAAAAH/////AAAAAAAAAB/////wAAAAAAAAA/////4AAAAAAAAAP////4AAAAAAAAAD////8AAAAAAAAAA////8AAAAAAAAAAD///+AAAAAAAAAAAf///4AAAAAAAAAAB////AAAAAAAAAAAH///4AAAAAAAAAAA////AAAAAAAD+AAH///4AAAAAAB/+AA////AAAAAAAf/4AH///4AAAAAAD//wD////AAAAAAA///3////4AAAAAAH////////AAAAAAB////////4AAAAAA/////////gAAAAAf////////8AAAAAP/////////gAAAAPwH///////+AAAADwAP///////wAAABwAAf//////8AAAAYAAB///////4AAAAAAAH///////wAAAAAAA////////AAAAAAAD///////+AAAAAAAP///////+AAAAAAA/////////gAAAAAD/////////4AAAAAP/////////4AAAAA//////////AAAAAB/////////4AAAAAP/////////AAAAAD/////////4AAAAA/////////+AAAAAH/////////4AAAAA///////Af+AAAAAH//////+APwAAAAA///////4AAAAAAAH///4AB9wAAAAAAA///+AADj/AAAAAAD///gAAHPwAAAAAAf//8AAAcf4AAAAAD///AAAAw/wAAAAAf//wAAAD+PgAAAAB//+AAAAPgAAAAAAP//wAAAAfwAAAAAB//+AAAAB/gAAAAAH//4AAAAA/AAAAAA///AAAAAAIAAAAAD//4AAAAAAAAAAAAf//gAAAAAAAAAAAB//8AAAAAAAAAAAAP//gAAAAAAAAAAAA//+AAAAAAAAAAAAD//wAAAAAAAAAAAAf/+AAAAAAAAAAAAB//wAAAAAAAAAAAAP/+AAAAAAAAAAAAA//4AAAAAAAAAAAAH//AAAAAAAAAAAAAf/4AAAAAAAAAAAAB//AAAAAAAAAAAAAP/4AAAAAAAAAAAAA//gAAAAAAAAAAAAD/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAB/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAAf8AAAAAAAAAAAAAB/gAAAAAAAAAAAAAH4AAAAAAAAAAAAAA/AAAAAAAAAAAAAAD8AAAAAAAAAAAAAAOgAAAAAAAAAAAAAA4AAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAA"},"actitis-macularius":{"w":93,"h":78,"bits":"AAABwAAAAAAAAAAAAAB/wAAAAAAAAAAAAAf/gAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAP//AAAAAAAAAAAAD//8AAAAAAAAAAAAf//gAAAAAAAAAAAH//8AAAAAAAAAAAB///wAAAAAAAAAAAf//+AAAAAAAAAAAP///4AAAAAAAAAAH////gAAAAAAAAAB+P///AAAAAAAAAA+Af///4AAAAAAAAfAB////8AAAAAAAHAAH////8AAAAAADgAA/////8AAAAAAQAAH/////4AAAAAAAAA//////4AAAAAAAAH//////wAAAAAAAB///////AAAAAAAAP//////+AAAAAAAB///////8AAAAAAAP///////wAAAAAAB////////gAAAAAAH////////AAAAAAA/////////AAAAAAH////////+AAAAAA/////////+AAAAAD//////////8AAAAf//////////gAAAB//////////gAAAAP//////////AAAAA///////////gAAAD//////////+AAAAf//////////wAAAB//////////8AAAAD////////8AAAAAAP///////wAAAAAAA///////gAAAAAAAB//////wAAAAAAAAD/////4AAAAAAAAAP////+AAAAAAAAAAf////AAAAAAAAAAA////wAAAAAAAAAAA///wAAAAAAAAAAAA//gAAAAAAAAAAAAD/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAA/8AAAAAAAAAAAAAD/gAAAAAAAAAAAAAP+AAAAAAAAAAAAAA/gAAAAAAAAAAAAAHgAAAAAAAAAAAAAD4AAAAAAAAAAAAADzAAAAAAAAAAAAAB4QAAAAAAAAAAAAB8GAAAAAAAAAAAAAfAwAAAAAAAAAAAADoGAAAAAAAAAAAAA5gwAAAAAAAAAAAAHEGAAAAAAAAAAAAB5AgAAAAAAAAAAAAOAEAAAAAAAAAAAABYBgAAAAAAAAAAAANAMAAAAAAAAAAAAAgBgAAAAAAAAAAAAEAOAAAAAAAAAAAAAED8AAAAAAAAAAAAAf8AAAAAAAAAAAAAA/AAAAAAAAAAAAAf8wAAAAAAAAAAAABAMAAAAAAAAAAAAAADAAAAAAAAAAAAAABwAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAA=="},"aegithalos-caudatus-2":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAEYAAAAAAAAAAAABjAAAAAAAAAAAAAMxAAAAAAAAAAAADOYAAAAAAAAAAAA7mAAAAAAAAAAAAG9wAAAAAAAAAAAB/8gAAAAAAAAAAAf/cAAAAAAAAAAAH//AAAAAAAAAAAA//wAAAAAAAAAAAP/+AAAAAAAAAAAD//sAAAAAAAAAAA///AAAAAAAAAAAH//4AAAAAAAAAAB//+AAAAAAAAAAAf//4AAAAAAAAAAH//+AAAAAAAAAAB///gAAAAAAAAAAf//4AAAAAAAAAAD///gAAAAAAAAAA///4AAAAAAAAAAP//+AAAAAAAAHAD///wAAAAAAAP/A///+AAAAAAAD/+H///AAAAAAAA//9///4AAAAAAAP/////+AAAAAAAB//////gAAAAAAAP/////8AAAAAAAB//////AAAAAAAAP/////8AAAAAAAD//////AAAAAAAAH/////8AAAAAAAA//////gAAAAAAAD/////8AAAAAAAD//////gAAAAAAD//////4AAAAAAH///////AAAAAAH///////4AAAAAf///////+AAAH//////////wAAAP/////////4AAAAH////////gAAAA/////////+AAAAD/////////4AAAAA/////////AAAAB/////////4AAAAP/////////AAAAAD////////4AAAAB7////////AAAAAA/////9//8AAAAAOP/+//P//gAAAAADv6AvRv/8AAAAAABmAAAGD/wAAAAAAAAAAAQP/AAAAAAAAAAAAA/4AAAAAAAAAAAAD/gAAAAAAAAAAAAf8AAAAAAAAAAAAD/wAAAAAAAAAAAAP/AAAAAAAAAAAAB/4AAAAAAAAAAAAP/gAAAAAAAAAAAA/+AAAAAAAAAAAAH/wAAAAAAAAAAAAf/AAAAAAAAAAAAD/8AAAAAAAAAAAAf/wAAAAAAAAAAAB/+AAAAAAAAAAAAP/4AAAAAAAAAAAA//gAAAAAAAAAAAH/8AAAAAAAAAAAA/vwAAAAAAAAAAAD8/AAAAAAAAAAAAfj4AAAAAAAAAAAB8PgAAAAAAAAAAAPx+AAAAAAAAAAAA+HwAAAAAAAAAAAHwfAAAAAAAAAAAAeB8AAAAAAAAAAADwHwAAAAAAAAAAAeAeAAAAAAAAAAAB4B4AAAAAAAAAAAPAHAAAAAAAAAAAB4AcAAAAAAAAAAAHAAAAAAAAAAAAAAwAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"aegithalos-caudatus":{"w":58,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAeAAAAAAAAf/AAAAAAAH//AAAAAAB//+AAAAAAP//8AAAAAB///4AAAAAP///gAAAAA///+AAAAAH///+AAAAA////4AAAAH///+AAAAA////4AAAAD////gAAAAf///+AAAAD////4AAAAP////AAAAB////+AAAAH////4AAAA/////gAAAD////+AAAAf////4AAAB/////gAAAP////+AAAA/////wAAAH/////AAAAf////8AAAD/////gAAAP////+AAAB/////wAAAH/////AAAA/////4AAAD/////gAAAP////8AAAA/////gAAAH////8AAAAf////gAAAB/////AAAAH/////AAAAf////8AAAB////5wAAAP////CAAAA3///E4AAADf//wRgAAAZ//4AEAAABv/7AAAAAAE/+HAAAAAAQ/gGAAAAAAH8APAAAAAAfgB+AAAAAD8AM4AAAAAPwBjAAAAAA/AEcAAAAAH4ATgAAAAAfgAiAAAAAD8AAQAAAAAPwAAAAAAAA/AAAAAAAAH4AAAAAAAAfgAAAAAAAD+AAAAAAAAPwAAAAAAAA/AAAAAAAAH4AAAAAAAAfgAAAAAAAD+AAAAAAAAPwAAAAAAAA/AAAAAAAAH8AAAAAAAAfgAAAAAAAB+AAAAAAAAP4AAAAAAAA/AAAAAAAAH8AAAAAAAAfwAAAAAAAB+AAAAAAAAP4AAAAAAAA/AAAAAAAAD8AAAAAAAAfwAAAAAAAB+AAAAAAAAH4AAAAAAAA+AAAAAAAAD4AAAAAAAAPgAAAAAAAB8AAAAAAAAHwAAAAAAAAeAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"aix-galericulata-2":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAGwAAAAAAAAAAAAA2AAAAAAAAAAAAAGyAAAAAAAAAAAAA2wAAAAAAAAAAAAH2AAAAAAAAAAAAA+wAAAAAAAAAAAAP+wAAAAAgAAAAAB/2AAAAAMAAAAAAP/wAAAADAAAAAAB/8gAAAAYgAAAAAP/sAAAAHMAAAAAB//gAAABzAAAAAAf/9AAAAe5AAAAAD//4AAAH+4AAAAAf//AAAB/+AAAAAD//4AAAP/gAAAAA//+gAAD/5gAAAAH//8AAA//4AAAAA///AAAP/+AAAAAH//4AAD//gAAAAA///gAA//9AAAAAP//8AAf//4AAAAB///AAH//+AAAAAP//8AB///gAAAAB///gAf//4AAAAAP//4AH///wAAAAD///AB///8AAAAAf//4Af///AAAAAD///AP///wAAAAA///wD///+AAAAAH//+A////wAAAAA///gP///8AAAAAH//8D////AAAAAA///w////4AAAfgH//+P////AAAf/g///7////wAAH//D///////8AAB//8f///////AAAf//x///////4AAD//Pn//////8AAAf/++///////AAAD//////////wAAAf/////////8AAAH/////////wAAAB/////////+AAAA//////////wAAAPAf///////+AAABAB////////wAAAAAH///////8AAAAAA////////gAAAAAH///////8AAAAAA////////gAAAAAH///////8AAAAAA////////wAAAAAH///////+AAAAAA////////4AAAAAH////////AAAAAAf///////8AAAAAD////////gAAAAAf///////8AAAAAD////////gAAAAAP///////8AAAAAB////////AAAAAAH///////4AAAAAA////////AAAAAAD///////wAAAAAAP//////+AAAAAAA///////4AAAAAAD///////gAAAAAAH///////AAAAAAAP//////+AAAAAAAf//////4AAAAAAB///////wAAAAAAD///////AAAAAAAH//////8AAAAAAAP//////AAAAAAAAf/////8AAAAAAAAf/////4AAAAAAAAf/////wAAAAAAAAP/////AAAAAAAAAA//B/4AAAAAAAAAD/wAfAAAAAAAAAAP+AAAAAAAAAAAAAf/AAAAAAAAAAAAA/8AAAAAAAAAAAAA/wAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"aix-galericulata":{"w":93,"h":90,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAA//wAAAAAAAAAAAAf//gAAAAAAAAAAAH//+AAAAAAAAAAAB///4AAAAAAAAAAAf///gAAAAAAAAAAD///8AAAAAAAAAAAf///wAAAAAAAAAAD///+AAAAAAAAAAAf///4AAAAAAAAAAD////gAAAAAAAAAAf///+AAAAAAAAAAD////4AAAAAAAAAAf////gAAAAAAAAAD////+AAAAAAAAAAf////4AAAAAAAAAH/////AAAAAAAAAB/////8AAAAAAAAAP/////gAAAAAAAAH/////+ADwAAAAAB+/////wAfgAAAAAPP/////AH+AAAAABj/////wA/4AAAAAA/////8AP/gAAAAAP////4AD/8AAAAAB/////AA//wAAAAAf/////wP//AAAAAD//////3//4AAAAA//////////gAAAAP/////////8AAAAD//////////wAAAAf/////////+AAAAH//////////wAAAA//////////+AAAAH//////////wAAAA//////////+AAAAP//////////gAAAB//////////8AAAAP//////////gAAAB///////////AAAAP//////////8AAAB///////////wAAAH///////////AAAA////////////AAAH////////////gAAf////////////gAD////////////+AAP////////////gAA///////////+AAAH///////////4AAAf///////////4AAA////////////wAAD////////////wAAH////////5///gAAP////////B///AAAf///////4B//8AAB////////AD//AAAD///////4DA/gAAAP///////AAAAAAAAP//////4AAAAAAAAP/////4AAAAAAAAA/////+AAAAAAAAAf////+AAAAAAAAAP/gA/AAAAAAAAAAH/0ADwAAAAAAAAAB/+AAOAAAAAAAAAAf/wABwAAAAAAAAAAf+AAMAAAAAAAAAAB/wABgAAAAAAAAAAP8AAcAAAAAAAAAABwgADgAAAAAAAAAAMAAAcAAAAAAAAAAAAAAHwAAAAAAAAAAAAAA+AAAAAAAAAAAAB//gAAAAAAAAAAAAP/4AAAAAAAAAAAAA//AAAAAAAAAAAAAH/4AAAAAAAAAAAAA/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAD/8AAAAAAAAAAAAAh/AAAAAAAAAAAAAAHwAAAAAAAAAAAAAAcAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"aix-sponsa-2":{"w":93,"h":74,"bits":"AAABMAAAAAAAAAAAAAAMgAAAAAAAAAAAAAA2gAAAAAAAADAAAAH+AAAAAAAABwAAAA/8AAAAAAAA+IAAAH/wAAAAAAA//AAAAf+gAAAAAAf/gAAAD/+AAAAAAf/8AAAAf/0AAAAAP//4AAAD//gAAAAH//+AAAAf//AAAAD///gAAAD//4AAAB///8AAAAf//AAAA////gAAAD//8AAAf///wAAAAf//wAAP///8AAAAB//+AAH////wAAAAP//wAD////8AAAAB///AA/////AAAAAP//wAf////gAAAAB///AH////8AAAAAP//4B/////AAAAAB///A/////wAAAAAP//8P////8AAAAAA///z/////AAAAAAH////////wAAADwAf///////8AAAH/4D////////AAAB//wP///////gAAAf//Af//////4AAAH//+B//////8AAAA///4H/////+AAAAH///gf/////AAAAA////D/////wAAAAP///+f////+AAAAH////7/////4AAAB////AP////+AAAA/Af/+D/////wAAAGAAP///////+AAAAAAA////////wAAAAAAD///////+AAAAAAAP///////wAAAAAAB///////8AAAAAAAP///////gAAAAAAA///////8AAAAAAAH///////AAAAAAAA///////4AAAAAAAD//////+AAAAAAAAf//////gAAAAAAAB//////8AAAAAAAAH//////gAAAAAAAA///////AAAAAAAAB//////8AAAAAAAAH//////wAAAAAAAAf//////AAAAAAAAA//////8AAAAAAAAB//////wAAAAAAAAD//////AAAAAAAAAP/////+AAAAAAAAAf//////AAAAAAAAA///////AAAAAAAAB//////8AAAAAAAAD//////wAAAAAAAAD//////AAAAAAAAAD/////4AAAAAAAAAA/////AAAAAAAAAAH/8D/wAAAAAAAAAA//ABoAAAAAAAAAAD/4AAAAAAAAAAAAAP/gAAAAAAAAAAAAA//AAAAAAAAAAAAADz+AAAAAAAAAAAAAPP8AAAAAAAAAAAAAMcAAAAAAAAAAAAAABgAAAA"},"aix-sponsa":{"w":93,"h":83,"bits":"AAH/gAAAAAAAAAAAAH//gAAAAAAAAAAAB///AAAAAAAAAAAAf//8AAAAAAAAAAAH///wAAAAAAAAAAB////AAAAAAAAAAAP///8AAAAAAAAAAD////gAAAAAAAAAAf///+AAAAAAAAAAD////wAAAAAAAAAAf////AAAAAAAAAAD////4AAAAAAAAAAf////gAAAAAAAAAD////8AAAAAAAAAA/////gAAAAAAAAAP////+AAAAAAAAAD/////wAAAAAAAAA/////+AAAAAAAAAf8f///wAAAAAAAAH8B///+AAAAAAAAA+AP///4AAAAAAAAGAB////AAAAAAAAAAAf////4AAAAAAAAAD//////gAAAAAAAA///////gAAAAAAAP////////gAAAAAD/////////gAAAAA///////////gAAAP///////////4AAD////////////wAA////////////+AAP/////////////wB//////////////wf//////////////D//////////////4///////////////H//////////////w//////////////8P//////////////B//////////////wP/////////////4B/////////////wAP////////////wAB////////////4AAP///////////+AAA////////////gAAH///////////4AAA///////////+AAAH///////////wAAAf//////////8AAAD///////////AAAAP//////////wAAAA//////////8AAAAD//////////AAAAAP/////////wAAAAA/////////4AAAAAD////////+AAAAAAH////////AAAAAAAP//////8AAAAAAAAP/////+AAAAAAAAAP/////AAAAAAAAAAf///94AAAAAAAAAAP//8OAAAAAAAAAAH/4ABwAAAAAAAAAH/6AAOAAAAAAAAAD//AABwAAAAAAAAB//4AAeAAAAAAAAAP//AADwAAAAAAAAAP/wAAfAAAAAAAAAA/+AAHgAAAAAAAAAD4gA/8AAAAAAAAAAYAD//gAAAAAAAAACAA//8AAAAAAAAAAAAA//gAAAAAAAAAAAAH/8AAAAAAAAAAAAA//AAAAAAAAAAAAAH/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/wAAAAAAAAAAAACB8AAAAAAAAAAAAAAHgAAAAAAAAAAAAAAYAAAAAAAAAAAAAACAAAAAAAA="},"alauda-arvensis-2":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAcAAAAAAAAAAAAAAfPAAAAAAAAAAAAAP/gAAAAAAAAAAAAP/xAAAAAAAAAAAAP//4AAAAAAAAAAAH//8AAAAAAAAAAAD//+AAAAAAAAAAAB///8AAAAAAAAAAA////AAAAAAAAAAAf///gAAAAAAAAAAP///8AAAAAAAAAAH////gAAAAAAAAAD////wAAAAAAAAAB////8AAAAAAAAAA/////gAAAAAAAAAP////4AAAAAAAAAD////8AAAAAAAAAA/////gAAAAAB8AAf////4AAAAAA/8AD////8AAAAAAf/wA/////AAAAAA///AP////wAAAAAP//8B////4AAAAAAP//wP///+AAAAAAAf//D////AAAAAAAB//8f///4AAAAAAAP///////AAAAAAAA///////wAAAAAAAH//////+AAAAAAAAf//////wAAAAAAAD//////+AAAAAAAAP//////4AAAAAAAB//////+AAAAAAAAP//////wAAAAAAAB//////+AAAAAAAAP//////wAAAAAAAP//////+AAAAAAAH///////wAAAAAAB///////+AAAAAAAf///////wAAAAAAH///////+AAAAAAA////////gAAAAAAP///////+AAAAAAD////////gAAAAAA///////z4AAAAAAH///////DAAAAAAB///////8AAAAAAAP///////gAAAAAAD///////+AAAAAAA////////wAAAAAAH////////AAAAAAB////////4AAAAAAf////////gAAAAAD////////+AAAAAA///v/7///wAAAAAP//8AA////AAAAAB//8AAff//4AAAAAf//gAH9///gAAAAD//4AA8/v/8AAAAA//6AAHiIH/gAAAAH//AAA+MAP+AAAAB/+wAADQgA/4AAAAP9kAAAcAAH/gAAADbsAAABgAAf8AAAA3ZAAAAAAAB/wAAAEyAAAAAAAAP/AAAAMgAAAAAAAA/8AAAAAAAAAAAAAD/wAAAAAAAAAAAAAf/AAAAAAAAAAAAAB/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAA/+AAAAAAAAAAAAAD/4AAAAAAAAAAAAAP/gAAAAAAAAAAAAB8+AAAAAAAAAAAAAHBwAAAAAAAAAAAAAYAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"alauda-arvensis":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAH/gAAAAAAAAAAAAD/+AAAAAAAAAAAAA//4AAAAAAAAAAAAP//4AAAAAAAAAAAD///4AAAAAAAAAAAf//+AAAAAAAAAAAH//8AAAAAAAAAAAA///AAAAAAAAAAAAP//wAAAAAAAAAAAB//8AAAAAAAAAAAAP//gAAAAAAAAAAAD//4AAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAA///gAAAAAAAAAAAf//8AAAAAAAAAAAP///gAAAAAAAAAAH///8AAAAAAAAAAD////gAAAAAAAAAB////8AAAAAAAAAAf////gAAAAAAAAAP////8AAAAAAAAAD/////gAAAAAAAAA/////8AAAAAAAAAf/////gAAAAAAAAP/////4AAAAAAAAH//////AAAAAAAAB//////4AAAAAAAA//////+AAAAAAAAP//////wAAAAAAAD//////8AAAAAAAB///////gAAAAAAAf//////4AAAAAAAH///////AAAAAAAB///////wAAAAAAA///////8AAAAAAAf///////AAAAAAAP///////wAAAAAAP///////8AAAAAAP////////AAAAAAH///w3///gAAAAAH///gAf//4AAAAAD///4Ez//8AAAAAD/+MAGB/wGAAAAAD/+AAAGA4OAAAAAA/+AAAAPyDgAAAAAB/AAAAAAQAAAAAAAfAAAAAAEAAAAAAAHgAAAAAAiAAAAAAAgAAAAAAE4AAAAAAAAAAAAAA7gAAAAAAAAAAAAAHGAAAAAAAAAAAAAAcYAAAAAAAAAAAAABhgAAAAAAAAAAAAAGGAAAAAAAAAAAAAAYYAAAAAAAAAAAAABhwAAAAAAAAAAAAAMHAAAAAAAAAAAAAAw/+AAAAAAAAAAAAH//+AAAAAAAAAAAAcDA8AAAAAAAAAAABgFAAAAAAAAAAAAe/OAAAAAAAAAAAAA+/0AAAAAAAAAAAAABz+AAAAAAAAAAAAADAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"alcedo-atthis-2":{"w":93,"h":80,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEAAAAAAAAAAAAAANkAAAAAAAAAAAAABtgAAAAAAAAAAAAAP9AAAAAAAAAAAAAD/4AAABAAAAAAAAAf/AAAAYAAAAAAAAD/4AAAHAAAAAAAAA//gAABzAAAAAAAAH/+AAA+wAAAAAAAA//gAAP+AAAAAAAAP/8AAD/8AAAAAAAB//wAA//AAAAAAAAP/+AAf/4AAAAAAAD//wAH/+AAAAAAAAf/+AB//8AAAAAAAD//wAf//AAAAAAAA//+AH//4AAAAAAAH//gD//+AAAAAAAA//8A///gAAAAAAAP//gP//+AAAAAAAB//8D///wAAAAAAAP//A///8AAAAAAAD//4f///AAAAAAAA///H///4AAAAAAAH//5////AAAAAAAB///////4AAAAAAAP//////+AAAAAAAB///////gAAAAAAAP//////8AAAAAAAB///////AAAAAAAAP//////wAAAAAAAB//////8AAAAAAf/v//////gAAAAAP////////4AAAAAH////////8AAAAAB/////////AAAAAAf////////4AAAAA/////////+AAAAD//////////wAAAH///////////AAAP///////////4AAH///////////+AAAAAA/////////4AAAAAA/////////AAAAAAA////////wAAAAAAD///////+AAAAAAAH///////wAAAAAAAf//////8AAAAAAAD///////AAAAAAAAf//////4AAAAAAAB//////+AAAAAAAAP//////wAAAAAAAA//////8AAAAAAAAD//////AAAAAAAAAf/////wAAAAAAAAB/////4AAAAAAAAAH/////AAAAAAAAAAf////8AAAAAAAAAB/////wAAAAAAAAAD/////AAAAAAAAAAP////4AAAAAAAAAAf////gAAAAAAAAAA////8AAAAAAAAAAB////wAAAAAAAAAAD///+AAAAAAAAAAAH///4AAAAAAAAAAAH///AAAAAAAAAAAAB//8AAAAAAAAAAAAP3/gAAAAAAAAAAAB/f+AAAAAAAAAAAAH4/4AAAAAAAAAAAAfB/gAAAAAAAAAAAAAB8AAAAAAAAAAAAAADwAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"alcedo-atthis":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAf/8AAAAAAAAAAAAf//8AAAAAAAAAAAH///wAAAAAAAAAAD////gAAAAAAAAAB////8AAAAAAAAAAf////wAAAAAAAAAD/////AAAAAAAAAA/////4AAAAAAAAAP/////gAAAAAAAAD/////8AAAAAAAAB//////wAAAAAAAD//////+AAAAAAAH///////4AAAAAAH///////+AAAAAAH////////4AAAAAD/////////AAAAAD/////////wAAAAB///D//////AAAAA/8AAD/////+AAAAAAAAAH/////4AAAAAAAAAf/////gAAAAAAAAB//////AAAAAAAAAP/////8AAAAAAAAB//////wAAAAAAAAP//////AAAAAAAAD//////8AAAAAAAAf//////wAAAAAAAD///////AAAAAAAAf//////4AAAAAAAD///////gAAAAAAAf//////+AAAAAAAB///////4AAAAAAAP///////AAAAAAAB///////8AAAAAAAP///////gAAAAAAA///////+AAAAAAAH///////wAAAAAAAf///////AAAAAAAD///////4AAAAAAAP///////gAAAAAAA///////8AAAAAAAH///////gAAAAAAAf//////+AAAAAAAB///////wAAAAAAAH///////AAAAAAAAf//////4AAAAAAAD///////gAAAAAAAP//////8AAAAAAAAf//////gAAAAAAAB//////8AAAAAAAAH//////AAAAAAAAAP/////8AAAAAAAAA//////wAAAAAAAAB/////+AAAAAAAAAH/////4AAAAAAAAH//////AAAAAAAAA7/////8AAAAAAAAOP////9gAAAAAAABgT////gAAAAAAAAMAP///8AAAAAAAAAwHjv//gAAAAAAAAGD4AH/8AAAAAAAAAA/wAf/gAAAAAAAAAHDAB/8AAAAAAAAAAwEAH/gAAAAAAAAAOAAAf8AAAAAAAAAAwAAB/gAAAAAAAAAHAAAD8AAAAAAAAAAMAAAPgAAAAAAAAAAAAAA+AAAAAAAAAAAAAADwAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"alectoris-rufa-2":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgwAAAAAAAAAAAA4cAAAAAAAAAAAAfPAAAAAAAAAAAAH34AAAAAAAAAAAD/8MAAAAAAAAAAA//vAAAAAAAAAAAf//wBAAAAAAAAAH//8AOAAAAAAAAB///AE7AAAAAAAA///xA3sAAAAAAAP///4H/wAAAAAAD///+Af/wAAAAAA////gD//AAAAAAf///wAP/8AAAAAH///8AB//8AAAAB////4AH//wAAAAf///+AA///AAAAP////gAD//8AAAD////4AAf//wAAA////+AAB///AAAP////wAAH//+AAD////8AAAf//wAA/////AAAB///gAP////wAAAP//+AD////+AAAB///8A/////AAAAH///4P////gAAAAf///x////8AAAAB////P///+AAAAAH////////gAAAAB////////wAAAAAP///////8AAAAAH////////wAAAAB////////+AAAAAP////////wAAAAAP///////+AAAAAA////////wAAAAAD///////+AAAAAAP///////wAAAAAA///////+AAAAAAH///////wAAAAAA///////+AAAAAAH///////gAAAAAA///////+AAAAAAH///////gAAAAAAf//////8AAAAAAD///////gAAAAAAf//////4AAAAAAD///////AAAAAAAP//////4AAAAAAB///////AAAAAAAP//////4AAAAAAA///////gAAAAAAD//////+AAAAAAAf//////4AAAAAAB///////AAAAAAAH//////8AAAAAAAf//////gAAAAAAB//////+AAAAAAAH//////wAAAAAAAf//////AAAAAAAA//////4AAAAAAAD//////AAAAAAAAH/////4AAAAAAAAH/////gAAAAAAAAH////+AAAAAAAAAP//3/wAAAAAAAAAf/8f/AAAAAAAAAAf/h/8AAAAAAAAAAccH/gAAAAAAAAABhgP+AAAAAAAAAAMMAfwAAAAAAAAABgwA/AAAAAAAAAAMGABwAAAAAAAAABgwAAAAAAAAAAAAOHgAAAAAAAAAAABgwAAAAAAAAAAAAPDwAAAAAAAAAAAB8fAAAAAAAAAAAAODgAAAAAAAAAAAA4eAAAAAAAAAAAAHh4AAAAAAAAAAAAWHgAAAAAAAAAAABYWAAAAAAAAAAAAMjYAAAAAAAAAAAAwMAAAAAAAAAAAACAwAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"alectoris-rufa":{"w":76,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/AAAAAAAAAAB/+AAAAAAAAAAP/8AAAAAAAAAB//4AAAAAAAAAH//gAAAAAAAAA///AAAAAAAAAH///AAAAAAAAAf//+AAAAAAAAD///4AAAAAAAAP//4AAAAAAAAA///AAAAAAAAAD//8AAAAAAAAAf//gAAAAAAAAB//+AAAAAAAAAH//4AAAAAAAAA///wAAAAAAAAH///AAAAAAAAA///+AAAAAAAAH///8AAAAAAAB////wAAAAAAA/////gAAAAAAf////+AAAAAAH/////8AAAAAB//////wAAAAAf//////gAAAAH//////+AAAAA///////4AAAAH///////gAAAB////////AAAAP///////8AAAB////////wAAAP////////AAAB////////8AAAP////////wAAB////////+AAAP////////4AAA/////////gAAH////////+AAA/////////4AAH/////////AAAf////////8AAD/////////wAAf/////////AAB/////////8AAP/////////gAA/////////+AAD/////////4AAf/////////AAB/////////8AAH/////////wAA/////////+AAD/////////4AAP/////////gAA/////////8AAD/////////gAAf////////+AAB/////////wAAH////////+AAAf////////wAAB/////////AAAH////////4AAAf////////AAAD////////4AAAP////////AAAA////////wAAAD///////+AAAAf///////wAAAB///////8AAAAP/+H////AAAAA/+AH///wAAAAH/gAD//4AAAAAf4AAA/8AAAAAD+AAAAfgAAAAAP4AAAAf/AAAAA/AAAAH//wAAAH4AAAA/+XgAAAfAAAAAO8AAAADgAAAAA4IAAAAAAAAAABwAAAAAAAAAAAPDwAAAAAAAAAH/8AAAAAAAAAAM//8AAAAAAAAAB77gAAAAAAAAADgAAAAAAAAAAADgAAAAAAAAAAAHAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"alopochen-aegyptiaca-2":{"w":91,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABsAAAAAAAAEAAAAAyAAAAAAAAEAAAAANoAAAAAAAGAAAAAG0AAAAAAAHEAAAAD7AAAAAAAHOAAAAB/gAAAAAAHeAAAAA/2AAAAAAPeAAAAAf7AAAAAAP+YAAAAP/gAAAAAP+4AAAAH/2AAAAAf/4AAAAD//AAAAAf/4AAAAB//gAAAAf//AAAAA//0AAAA///AAAAAf/+AAAA///AAAAAP//AAAA///AAAAAH//gAAB///4AAAAD//4AAB///4AAAAB//8AAB///4AAAAA//+AAD///4AAAAAf//AAD///8AAAAAP//wAD///+AAAAAH//4AD///+AAAAAD//8AD///+AAAAAB//+AD///+AAAAAA///AD////AAAAAAf//gD////gAAAAAP//wD////gAAAAAH//4D////gAAAAAD//+D////gAAAAAB///h////gAAAAAA///5////gAAAAAAf//+////gAAAAAAH///////gAAAAAAB///////gAAAAAAAf//////gAAAAAAAH//////wAAAAAAAD//////4AAAAAAAA//////8AAAAAAAAP/////+AAAAAfAAH//////AAAAB/8AD//////gAAAB//gA//////wAAAB//8Af/////4AAAA///AP/////8AAAA///4H/////+AAAB///+D/////+AAAD///////////AAAD///////////AAAAAAD////////gAAAAAAf///////wAAAAAAH///////wAAAAAAD///////4AAAAAAA///////4AAAAAAAP//////8AAAAAAAH//////8AAAAAAAD//////8AAAAAAAA//////+AAAAAAAAP/////+AAAAAAAAD//////AAAAAAAAA//////gAAAAAAAAP/////wAAAAAAAAB/////4AAAAAAAAAf////8AAAAAAAAAD/////gAAAAAAAAA/////4AAAAAAAAAH////+AAAAAAAAAB/////gAAAAAAAAAf////4AAAAAAAAAD////+AAAAAAAAAAf////wAAAAAAAAAD/////gAAAAAAAAAf////+AAAAAAAAAD/////AAAAAAAAAAP////gAAAAAAAAAA////gAAAAAAAAAABw//gAAAAAAAAAAAMP/gAAAAAAAAAAAGDtAAAAAAAAAAAABg+AAAAAAAAAAAAAfPgAAAAAAAAAAAAPnwAAAAAAAAAAAAD5+AAAAAAAAAAAAA/PwAAAAAAAAAAAAH78AAAAAAAAAAAAB+fAAAAAAAAAAAAAODAAAAAAAAAAAAABgQAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"alopochen-aegyptiaca":{"w":93,"h":91,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH4AAAAAAAAAAAAAD/4AAAAAAAAAAAAB//gAAAAAAAAAAAAf/+AAAAAAAAAAAAD//4AAAAAAAAAAAA///gAAAAAAAAAAAH//+AAAAAAAAAAAB///wAAAAAAAAAAAf///AAAAAAAAAAAH///4AAAAAAAAAAB////AAAAAAAAAAA/7//8AAAAAAAAAAPwB//gAAAAAAAAABgAP/8AAAAAAAAAAAAB//gAAAAAAAAAAAAf/8AAAAAAAAAAAAH//AAAAAAAAAAAAB//4AAAAAAAAAAAAP//H/8AAAAAAAAAD/////+AAAAAAAAA//////8AAAAAAAAH//////8AAAAAAAB///////wAAAAAAAP///////gAAAAAAD////////AAAAAAAf///////8AAAAAAD////////4AAAAAAf////////gAAAAAD////////+AAAAAAf////////8AAAAAD/////////4AAAAAf/////////gAAAAD//////////AAAAAf/////////+AAAAB//////////4AAAAP//////////gAAAA//////////+AAAAD//////////4AAAAP//////////wAAAA///////////gAAAD//////////+AAAAP//////////4AAAAf//////////gAAAB//////////8AAAAD//////////wAAAAP//////////gAAAAf/////////+AAAAA/////////8wAAAAB/////////wAAAAAD/////////AAAAAAH////////+AAAAAAH////////4AAAAAAf///8HAH/gAAAAAB+//+AAAP4AAAAAAHh/4AAAAeAAAAAAAcH/AAAAAAAAAAAAHgfwAAAAAAAAAAAA8A8AAAAAAAAAAAAHADwAAAAAAAAAAAAYAeAAAAAAAAAAAADADwAAAAAAAAAAAAYAeAAAAAAAAAAAADADwAAAAAAAAAAAAYAOAAAAAAAAAAAADABwAAAAAAAAAAAA4AOAAAAAAAAAAAAHABwAAAAAAAAAAAA8AOAAAAAAAAAAAAHwBwAAAAAAAAAAAD6AOAAAAAAAAAAAH/ABwAAAAAAAAAAf/4AOAAAAAAAAAAB//ABwAAAAAAAAAAH/4APAAAAAAAAAAA/+ADwAAAAAAAAAAP/gA+AAAAAAAAAABAYD/wAAAAAAAAAAAAH/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAED4AAAAAAAAAAAAAAOAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"anas-acuta-2":{"w":93,"h":65,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAAAH//4AAAAAAAAAAAB///4AAAAAAAAAAAf///wAAAAAAAAAAH////wAAAAAAAAAB/////AAAAAAAAAA/////+AAAAAAD////////8AAAAAB/////////wAAAAAf/////////gAAAAH/////////+AAAAA//////////8AAAAP//////////4AAAB//gf/////8/8AAAf/wB//////z/wAAP/4Af/////+//AAD8AAD//7/////8AB8AAAf/+f/////wAIAAAH//n/////+AAAAAA//+////3/gAAAAAH//P///8f4AAAAAA//x/////5wAAAAAH/+P/////jwAAAAA//z///8f+HgAAAAH/8f//4AAAOAAAAA//j///AAAAAAAAAP/4f//wAAAAAAAAB/+D//8AAAAAAAAAP/wP//gAAAAAAAAB/8B//4AAAAAAAAAP/gP//AAAAAAAAAB/4A//wAAAAAAAAAP+AH//AAAAAAAAAB/gA//4AAAAAAAAAP8AH//AAAAAAAAAB+AAf/8AAAAAAAAAPwAD//gAAAAAAAAB6AAf/8AAAAAAAAAPAAB//gAAAAAAAABwAAP/8AAAAAAAAAIAAA//gAAAAAAAAAAAAH/8AAAAAAAAAAAAAf/gAAAAAAAAAAAAD/8AAAAAAAAAAAAAf/gAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAA/8AAAAAAAAAAAAAH/gAAAAAAAAAAAAAf8AAAAAAAAAAAAAD/gAAAAAAAAAAAAAP8AAAAAAAAAAAAAB/AAAAAAAAAAAAAAH4AAAAAAAAAAAAAA/gAAAAAAAAAAAAAD8AAAAAAAAAAAAAAfAAAAAAAAAAAAAAB4AAAAAAAAAAAAAANAAAAAAAAAAAAAAAoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"anas-acuta":{"w":93,"h":56,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAA/4AAAAAAAAAAAAAP/wAAAAAAAAABAAD//AAAAAAAAAAwAA//8AAAAAAAAAYAAP//gAAAAAAAAMAAB//+AAAAAAAAGAAAP//wAAAAAAADAAAD//2AAAAAAABwAAAf/+4AAAAAAA4AAAH//3AAAAAB8cwAAD//+4AAAAB//+AAA///2AAAA////gAAf4P8wH//////8AAHwA/uH///////AABwAH5n///////gAAAAA+f///////4AAAAADD///////8AAAAAAA////////AAAAAAAH///////4AAAAAAA///////+AAAAAAAP///////gAAAAAAH///////8AAAAAAB////////AAAAAAAf///////4AAAAAAH///////+AAAAAAA////////gAAAAAAH///////8AAAAAAA////////AAAAAAAH///////wAAAAAAA///////4AAAAAAAH//////+AAAAAAAAf//////AAAAAAAAB/////+AAAAAAAAAP/////gAAAAAAAAAf////4AAAAAAAAAB/////gAAAAAAAAAAAA//4AAAAAAAAAAAADwGAAAAAAAAAAAAAwDgAAAAAAAAAAAP4BwAAAAAAAAAAAB/geAAAAAAAAAAAAf8HwAAAAAAAAAAAC8f4AAAAAAAAAAAABB/gAAAAAAAAAAAAIP8AAAAAAAAAAAAAB/AAAAAAAAAAAAAAf4AAAAAAAAAAAAACPAAAAAAAAAAAAAAAwAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"anas-crecca-2":{"w":90,"h":93,"bits":"AAAAAQAAAAAAAAAAAAACYAAAAAAAAAAAAACYAAAAAAAAAAAAADbAAAAAAAAAAAAADbAAAAAAAAAAAAAD/AAAAAAAAAAAAAD/QAAAAAAAAAAAAD/wAAAAAAAwAAAAD/wAAAAAABhAAAAD/0AAAAAAHmAAAAD/+AAAAAAf8AAAAD/+AAAAAB/4AAAAH/+AAAAAD/7AAAAH//gAAAAP/+AAAAH//gAAAA//8AAAAH//gAAAB//4AAAAH//gAAAH//8AAAAH//wAAAP//4AAAAH//wAAAf//wAAAAH//wAAB///gAAAAH//wAAD///gAAAAH//wAAH///AAAAAH//wAAf///AAAAAH//wAA///+AAAAAH//wAD///8AAAAAH//wAH///8AAAAAH//wAP///4AAAAAH//wAf///wAAAAAH//wA////gAAAAAH//wD////gAAAAAP//wH///+AAAAAAP//wP///8AAAAAAP//8f///8AAAAAAP//+////4AAAAAAP///////gAAAAAAP///////AAAAAAAH//////+AAAAAAAH//////4AAAAAAAD//////wAAAAAAAD//////AAAAAAAAB//////gAAAAAAAA//////gAAAAAAAAf/////gAAAAAAAAP/////gAAAAABgAH/////gAAAAAf+AH/////gAAAAB//gH/////gAAAAD//4H/////gAAAAH//8H/////gAAAAH///H/////gAAAAP/////////AAAAAP/////////AAAAAf/////////AAAAA//////////AAAAD//////////AAAAP/////////+AAAAfwH///////+AAAA+AAH///////AAAAAAAD//////8AAAAAAAD//////8AAAAAAAD//////+AAAAAAAB//////8AAAAAAAB//////+AAAAAAAA///////AAAAAAAA///////gAAAAAAAf//////wAAAAAAAP//////4AAAAAAAH//////8AAAAAAAB//////+AAAAAAAAf//////AAAAAAAAH//////gAAAAAAAAf/////wAAAAAAAAH/////8AAAAAAAAB//////AAAAAAAAAf/////wAAAAAAAAH/////+AAAAAAAAB/////+AAAAAAAAAP////8AAAAAAAAAAf///8AAAAAAAAAAD/H/wAAAAAAAAAAD/A+AAAAAAAAAAAH/gAAAAAAAAAAAAH/gAAAAAAAAAAAAH/8AAAAAAAAAAAAH/4AAAAAAAAAAAAD/8AAAAAAAAAAAAB/+AAAAAAAAAAAAA//gAAAAAAAAAAAAePwAAAAAAAAAAAAOH8AAAAAAAAAAAADDwAAAAAAAAAAAAAAwAAAAAAAAAAAAAAYAAA"},"anas-crecca":{"w":93,"h":66,"bits":"AAAAAAAAAAAAAAAAAAP+AAAAAAAAAAAAAH/8AAAAAAAAAAAAB//wAAAAAAAAAAAAf//AAAAAAAAAAAAH//8AAAAAAAAAAAB///wAAAAAAAAAAAP//+AAAAAAAAAAAD///4AAAAAAAAAAAf///AAAAAAAAAAAH///4AAAAAAAAAAB////gAAAAAAAAAA////8AAAAAAAAAA/////gAAAAAAAAAf////8AAAAAAAAAH8A///gAAAAAAAAAAAB//8AAAAAAAAAAAAH/8gAAAAAAAAAAAA//gAAAAAAAAAAAAP/8H/4AAAAAAAAAD/////+AAAAAAAAB//////+AAAAAAAAf//////+AAAAAAAD///////+AAAAAAA////////8AAAAAAP////////4AAAAAB/////////8AAAAAP/////////8AAAAD//////////wAAAAf//////////gAAAD///////////AAAAf///////////AAAD////////////4AAf////////////gAD////////////+AAf////////////+AD/////////////wAP////////////8AB/////////////AAP////////////AAA////////////gAAD///////////4AAAf//////////8AAAB///////////AAAAH//////////wAAAAf/////////8AAAAA//////////AAAAAD/////////wAAAAAH////////8AAAAAAP///////+AAAAAAAP///////AAAAAAAAP//////AAAAAAAAAP/////wAAAAAAAAAP////4AAAAAAAAAAf///wAAAAAAAAAAP//8AAAAAAAAAAAAH/+AAAAAAAAAAAAAf+AAAAAAAAAAAAAP/gAAAAAAAAAAAAD//AAAAAAAAAAAAH/8wAAAAAAAAAAABf+AAAAAAAAAAAAAA/AAAAAAAAAAAAAADgAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAA"},"anas-platyrhynchos-2":{"w":93,"h":67,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAOYAAAAAAAAAAAAAP+AAAAAAAAAAAAAH/gAAAAAAAAAAAAH/+YAAAAAAAAAAAD//hgAAAAAAAAAAB//4PAAAAAAAAAAA///D/AAAAAAAAAAf//wP+AAAAAAAAAP//8A/+AAAAAAAAH///AD/8AAAAAAAB///4Af/8AAAAAAA///+AB//4AAAAAAf///gAH//wAAAAAH///4AAf//gAAAAD///+AAB///AAAAA////gAAH//+P4AAP///wAAAf//7/wAD///8AAAB////+AAf///AAAAH////4AH///gAAAAP////AA///4AAAAA////8AP//8AAAAAB////gB//+AAAAAAD///8Af//gAAAAAAP///AH//+AAAAAAAf//4A///gAAAAAAA///wP//8AAAAAAAH///v///gAAAAAAA///////8AAAAAAAD///////gAAAAAAAP//////8AAAAAAAB///////AAAAAAAAH//////4AAAAAAAAf/////+AAAAAAAAB//////wAAAAAAAAH/////8AAAAAAAAAP/////gAAAAAAAAA/////8AAAAAAAAAH/////wAAAAAAAAAf///+eAAAAAAAAAD////4QAAAAAAAAAP////gAAAAAAAAAA////+AAAAAAAAAAD////4AAAAAAAAAAP////AAAAAAAAAAA////8AAAAAAAAAAD////gAAAAAAAAAAP///+AAAAAAAAAAA////+AAAAAAAAAAB////4AAAAAAAAAAH////gAAAAAAAAAAP///4AAAAAAAAAAA////gAAAAAAAAAAD///8AAAAAAAAAAAH///wAAAAAAAAAAAT//8AAAAAAAAAAADh/+AAAAAAAAAAAAeA4AAAAAAAAAAAAD+DwAAAAAAAAAAAAfgfAAAAAAAAAAAAB8D8AAAAAAAAAAAAPgfwAAAAAAAAAAAA8A4AAAAAAAAAAAAEACAAAAAAAAAAAAAAAAAAAA="},"anas-platyrhynchos":{"w":92,"h":93,"bits":"AAAMAAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAP/+AAAAAAAAAAAAH//wAAAAAAAAAAAD//+AAAAAAAAAAAA///gAAAAAAAAAAAf//8AAAAAAAAAAAH///AAAAAAAAAAAD///wAAAAAAAAAAB///+AAAAAAAAAAA////gAAAAAAAAAAf///4AAAAAAAAAAf///+AAAAAAAAAAf////gAAAAAAAAAP/Af/4AAAAAAAAAH/AD/8AAAAAAAAAD+AA//AAAAAAAAAAQAAP/wAAAAAAAAAAAAD/4AAAAAAAAAAAAB/+AAAAAAAAAAAAA//AAAAAAAAAAAAA//wAAAAAAAAAAAAf/4AAAAAAAAAAAAf/+AAAAAAAAAAAAP//wAAAAAAAAAAAP////4AAAAAAAAAD/////4AAAAAAAAB//////wAAAAAAAA///////gAAAAAAAf//////+AAAAAAAH///////4AAAAAAB////////AAAAAAA////////8AAAAAAP////////gAAAAAD////////+AAAAAA/////////wAAAAAP////////+AAAAAD/////////wAAAAA//////////AAAAAP/////////4AAAAD//////////AAAAA//////////4AAAAP//////////gAAAB//////////8AAAAf//////////gAAAD//////////8AAAA///////////gAAAH//////////8AAAA///////////gAAAH//////////8AAAA///////////gAAAH//////////8AAAA///////////AAAAH//////////8AAAA///////////gAAAH//////////8AAAA///////////gAAAH//////////8AAAA///////////gAAAH//////////4AAAA//////////+AAAAD//////////gAAAAf/////////4AAAAD/////////+AAAAAP/////////AAAAAB/////////8AAAAAH/////////wAAAAA/////////+AAAAAD/////////AAAAAAP////////4AAAAAAf///////wAAAAAAD/////+AAAAAAAAA/////8AAAAAAAAAP////gAAAAAAAAAD/yA/AAAAAAAAAAA/8AAAAAAAAAAAAAP/gAAAAAAAAAAAABPwAAAAAAAAAAAAABwAAAAAAAAAAAAHA8AAAAAAAAAAAAB8PAAAAAAAAAAAAA//wAAAAAAAAAAAAf//AAAAAAAAAAAA///QAAAAAAAAAAAf//wAAAAAAAAAAAAf/wAAAAAAAAAAAAD/wAAAAAAAAAAAAA/wAAAAAAAAAAAAAP4AAAAAAAAAAAAAD4AAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAA="},"anser-albifrons-2":{"w":93,"h":71,"bits":"AAAAAAAAAAAAAAAAwAAAAAAAAAAAAAADwAAAAAAAAAAAAAAPgAAAAAAAAAAAAAcfAAAAAAAAAAAAAB/+AAAAAAAAAAAAAX/8AAAAAAAAAAAAD//4AAAAAAAAAAAAP//wAAAAAAAAAAAAf//gAAAAAAAAAAAA//+AAAAAAAAAAAAf//8AAAAAAAAAAAB///4AAAAAAAAAAAH///wAAAAAAAAAAAP///AAAAAAAAAAAB///+AAAAAAAAAAAH///4AAAAIAAAAAAf///gAAABAAAAAAB///+AAAAMAAAAAAH///8AAANgAAAAAA////wAAB+AAAAAAD////AAAH4AAAAAAP///+AAD/AAAAAAA////4AAf8AAAAAAD////gAD/wAAAAAAf///+AA/+AAAAAAA////wAP/4AAAAAAH////AB//AAAAAAAf///4AP/8AAAAAAA////gD//gAAAAAAD///8Af/8AAAAAAAH///wD//wAAAAAAAf//+Af/+AAAAAAAD///4D//wAAAAAAAf///Af/+AAAAAAAD///8D//wAAAAAAAP///gf/+AAAAAAAB///+D//4AAAAAAAH///4///AAAAAAAAf///P//wAAAAAAAD//////8AAAAAAAAP//////AAAAAAAAB//////wAAAAAAAAH/////8AAAAAAAAA//////AAAAAAAAAD/////4AB4AAAAAAP/////AB/wAAAAAA/////4B//AAAAAAD/////x//+AAAAAAf////////+AAAAAB/////////wAAAAAH///////+AAAAAAAf/////8AAAAAAAAD/////8AAAAAAAAA/////+AAAAAAAAAH/////gAAAAAAAPx/////4AAAAAAAD//////+AAAAAAAA///////AAAAAAAAH//////wAAAAAAAB//////4AAAAAAAAH/////+AAAAAAAAB//////AAAAAAAAAP/////gAAAAAAAAB/////gAAAAAAAAAH////gAAAAAAAAAA////AAAAAAAAAAAB//gAAAAAAAAAAAAY/4AAAAAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAAAA=="},"anser-albifrons":{"w":83,"h":93,"bits":"AAAAAAAAAAAAAAAB/wAAAAAAAAAAAP/wAAAAAAAAAAA//wAAAAAAAAAAB//wAAAAAAAAAAH//wAAAAAAAAAAf//gAAAAAAAAAD///gAAAAAAAAAP///AAAAAAAAAB///+AAAAAAAAAH///+AAAAAAAAAf///8AAAAAAAAAAB//4AAAAAAAAAAAH/wAAAAAAAAAAAH/wAAAAAAAAAAAP/gAAAAAAAAAAAf+AAAAAAAAAAAA/8AAAAAAAAAAAD/4AAAAAAAAAAAH/wAAAAAAAAAAAf/gAAAAAAAAAAA//AAAAAAAAAAAD/8AAAAAAAAAAAP/4AAAAAAAAAAA//gAAAAAAAAAAD//AAAAAAAAAAAP/+AAAAAAAAAAA//4AAAAAAAAAAD//4/wAAAAAAAAH/////AAAAAAAAf/////4AAAAAAA//////8AAAAAAB//////+AAAAAAH///////AAAAAAP///////AAAAAAf///////gAAAAA////////gAAAAB////////gAAAAD////////gAAAAH////////wAAAAP////////wAAAAf////////4AAAAf////////8AAAA/////////+AAAB/////////+AAAB/////////+AAAB/////////+AAAD/////////+AAAD//////////AAAD/////////+AAAD/////////+AAAD//////////AAAD//////////gAAD//////////gAAD//////////gAAD//////////gAAD//////////gAAB/////////3gAAB/////////gAAAB/////////wAAAA/////////wAAAA/////////wAAAAf////////wAAAAH/////+D/wAAAAD/////gB/AAAAAA////8AAAAAAAAAP///gAAAAAAAAAD//4AAAAAAAAAAH/AAAAAAAAAAAAP8AAAAAAAAAAAA74AAAAAAAAAAAB3wAAAAAAAAAAADvgAAAAAAAAAAAPOAAAAAAAAAAAAfcAAAAAAAAAAH/+4AAAAAAAAAAP/xwAAAAAAAAAAf/jgAAAAAAAAAB//HAAAAAAAAAAP/8eAAAAAAAAAAB/w+AAAAAAAAAAA+D+AAAAAAAAAAA4HwAAAAAAAAAAA//gAAAAAAAAAAB/+AAAAAAAAAAAD/4AAAAAAAAAAAP/wAAAAAAAAAAB//AAAAAAAAAAAAf8AAAAAAAAAAAAPwAAAAAAAAAAAAPAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAA="},"anser-anser-2":{"w":92,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAYgAAAAAAAAAAAAAGYAAAAAAAAAAAAADMAAAAAAAAAAAAAB3IAAAAAAAAAAAAAbmAAAAAAAAAAAAAP3AAAAAAAAAAAAAH7gAAAAAAAAAAAAB/5AAAAAAAAAAAAA/9gAAAAAAAAAAAAf+4AAAAAAAAAAAAP/+AAAAAAAAAAAAH//gAAAAAAAAAAAB//4AAAAAAAAAAAA//8AAAAAAAAAAAAf//AAAAAAAAAAAAH//wAAAAAAAAAAAD//8AAAAAAAAAAAB//+AAAAAAAAAAAA///gAAAAAAAAAAAf//4AAAAAAAAAAAH//+AAAAAAAAAAAD///AAAAAAAAAAAD///wAAAAAAAAAAA///8AAAAAAAAAAAf///AAAAAAAAAAAP///gAAAAAAAAAAD///wAAAAAAAAAAB///8AAAAAAAAAAA////AAAAAAAAAAAP///gAAAAAAAAAAH///wAAAAAAAAAAB///4AAAAAAAAAAAf//8AAAAAAAAAAAH//+AAAAAAAAAAAD///AAAAAAAAAAAA///4AAAAAH8AAAAP//8AAAAAD/wAAAD///AABAAB//AAAB///4AAQAB//8AAAf//8AACAB///wAAH///AAAQB////AAD///wAAXAP///4AA///8AAD4AA///AAf///AAAfwAAB/4AH///wAAB/wAAH/gD///8AAAf/2AA/8D////AAAD//+AH//////gAAAP///h//////4AAAB////f/////8AAAA///////////AAAAD//////////gAAAAP/////////4AAAAD/////////8AAAAAP////////+AAAAAA/////////gAAAAAD////////4AAAAAAf///////+AAAAAAAf///////gAAAAAAH///////4AAAAAAAF///////AAAAAAAAP//////AAAAAAAAA//////4AAAAAAAAD//////AAAAAAAAAH/////4AAAAAAAAAP/////AAAAAAAAAAf////4AAAAAAAAAAf////AAAAAAAAAAD////8AAAAAAAAAAP////wAAAAAAAAAB/////AAAAAAAAAAH////4AAAAAAAAAAf///+AAAAAAAAAAB////gAAAAAAAAAAH///wAAAAAAAAAAAD//4AAAAAAAAAAAAf/+AAAAAAAAAAAAD//wAAAAAAAAAAAAf5+AAAAAAAAAAAAH/fwAAAAAAAAAAAAfj8AAAAAAAAAAAAD48AAAAAAAAAAAAAeDAAAAAAAAAAAAAHgQAAAAAAAAAAAAA0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"anser-anser":{"w":89,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAP/AAAAAAAAAAAAA//AAAAAAAAAAAAD//AAAAAAAAAAAAP//AAAAAAAAAAAA///AAAAAAAAAAAB///AAAAAAAAAAAH///AAAAAAAAAAAP///AAAAAAAAAAA////AAAAAAAAAAB////gAAAAAAAAAD////gAAAAAAAAAP//3/gAAAAAAAAAf/gAAAAAAAAAAAA/+AAAAAAAAAAAAB/8AAAAAAAAAAAAD/4AAAAAAAAAAAAH/wAAAAAAAAAAAAP/gAAAAAAAAAAAAf/gAAAAAAAAAAAAf/AAAAAAAAAAAAA/+AAAAAAAAAAAAB/+AAAAAAAAAAAAD/+AAAAAAAAAAAAD/+AAAAAAAAAAAAH/+AAAAAAAAAAAAP/+AAAAAAAAAAAAP/+AAAAAAAAAf/8f/+AAAAAAAAP/////+AAAAAAAD//////8AAAAAAA///////8AAAAAAH///////4AAAAAH////////4AAAAD/////////wAAAAf/////////gAAAD//////////AAAB//////////+AAAP//////////+AAA///////////8AAH///////////4AB////////////wAP////////////AA////////////+AA////////////8AD////////////4AH////////////gAH////////////AAH///////////8AAD///////////wAAAP//////////gAAAH/////////+AAAAH/////////4AAAAD/////////AAAAAD////////8AAAAAD////////gAAAAAD///////8AAAAAAD///////gAAAAAAD//////+AAAAAAAD//////wAAAAAAAD//////AAAAAAAAB/////4AAAAAAAAB/////AAAAAAAAAAf///wAAAAAAAAAAD//+AAAAAAAAAAAB//4AAAAAAAAAAAB/BwAAAAAAAAAAAD8DgAAAAAAAAAAADwHAAAAAAAAAAAAHwOAAAAAAAAAAAAHgcAAAAAAAAAAAAPA4AAAAAAAAAAAAcB4AAAAAAAAAAAA4HwAAAAAAAAAAAAwPwAAAAAAAAAAABgv/AAAAAAAAAAADAf/8AAAAAAAAAAHA//gAAAAAAAAAAeB/+AAAAAAAAAAB+B/8AAAAAAAAAAB/7/8AAAAAAAAAAD//gAAAAAAAAAAAD/+AAAAAAAAAAAAH/8AAAAAAAAAAAAP/4AAAAAAAAAAAAP/4AAAAAAAAAAAAPwAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"anthus-petrosus-2":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAADjAAAAAAAAAAAAAB5wAAAAAAAAAAAAA/cAAAAAAAAAAAAAP/AAAAAAAAAAAAAH/wAAAAAAAAAAAAD/8wAAAAAAAAAAAA//8AAAAAAAAAAAAf//AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAA///4AAAAAAAAAAAP//+AAAAAAAAAAAD///gAAAAAAAAAAA///4AAAAAAAAAAAP///AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAf///gAAAAAAAAAAP///4AAAAAAAAAAD///+AAAAAAAAAAA////gAAAAAAAAAAP///8AAAAAAAAAAD////AAAAAAAAAAA////wAAAAAAA/wAH///4AAAAAAAf/wB////AAAAAAP///Af///gAAAAAB///+D///8AAAAAAA///8////gAAAAAAB///////8AAAAAAAH///////wAAAAAAA///////+AAAAAAAD///////wAAAAAAAP//////+AAAAAAAB///////wAAAAAAAH//////+AAAAAAAAf//////wAAAAAAAB//////+AAAAAAAAP//////wAAAAAAAA//////+AAAAAAAAH//////wAAAAAAAA//////+AAAAAAAB///////gAAAAAAA///////8AAAAAAAP///////AAAAAAAD///////AAAAAAAA///////8AAAAAAAP///////wAAAAAAD///////+AAAAAAB////////4AAAAAAP////////gAAAAAD////////+AAAAAA/////////4AAAAAP/////////gAAAAD//////////AAAAA//////////+AAAAP//////////4AAAD//////D////wAAA//////gH43//gAAP/////wAHGP/+AAD////9gAAYw//8AA////AAAABGD//4AP///gAAAAYwP//gD///8AAAADGA//8A////AAAAAQwD/8AP///AAAAACGAP4AD///wAAAAAQeA+AB7//0AAAAACOADwAA93sAAAAAAeYAEAAOc7AAAAAACBgAAADnOAAAAAAAYPAAAABxAAAAAAABg0AAAAAAAAAAAAAPDAAAAAAAAAAAAAAkEAAAAAAAAAAAAACAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"anthus-petrosus":{"w":93,"h":71,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAA+AAAAAAAAAAAAAAfgAAAfwAAAAAAAAP/wAAP/wAAAAAAAD//gAH//gAAAAAAB//4AB//+AAAAAAAf//A////4AAAAAAP//gB////gAAAAAD//4AB///+AAAAAA//8AAH///4AAAAAf/+AAAf///wAAAAP//AAAD/////gAAP//gAAAP/////8A///wAAAB//////////8AAAAP//////////AAAAA//////////wAAAAH/////////8AAAAA//////////AAAAAD/////////4AAAAAf////////+AAAAAD/////////gAAAAAf////////4AAAAAD/////////AAAAAAf////////wAAAAAD////////+AAAAAAP////////gAAAAAB/////////AAAAAAP////////+AAAAAB/////////+AAAAAH/////////8AAAAA//////////wAAAAD////////4AAAAAAf///////AAAAAAAB///////wAAAAAAAP//////8AAAAAAAA///////gAAAAAAAD//////4AAAAAAAAP/////8AAAAAAAAA//////AAAAAAAAAD/////wAAAAAAAAAP////+AAAAAAAAAAf////wAAAAAAAAAA////+AAAAAAAAAAA///jgAAAAAAAAAAAf/w4AAAAAAAAAAAAcAEAAAAAAAAAAAAOABAAAAAAAAAAAADAAQAAAAAAAAAAAB74GAAAAAAAAAAAA/8BgAAAAAAAAAAAPAAYAAAAAAAAAAAHwAGGAAAAAAAAAABsAB/gAAAAAAAAAASgAcAAAAAAAAAAAAkAPAAAAAAAAAAAANgD4AAAAAAAAAAABoBnAAAAAAAAAAAAQgRQAAAAAAAAAAACAASAAAAAAAAAAAAAACQAAAAAAAAAAAAAAiAAAAAAAAAAAAAAMQAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"anthus-pratensis-2":{"w":76,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQAAAAAAAAAAAyAAAABAAAAAAGZAAAAYIAAAAA7MAAADjAAAAAH9gAAAc8AAAAA/uAAAHngAAAAD/2AAA/8wAAAAf/wAAP/uAAAAD//AAB//wAAAAf/4AAP/+AAAAB//sAB//yAAAAP//gAf//4AAAB//+AD///AAAAH//wAf//4AAAA//+AD///AAAAD//+Af//4AAAAf//4D///4AAAB///Af///AAAAP//4H///4AAAA///w////gAAAH///H///+AAAAf//4////4AAAD///n////AAAAP///////4AAAA////////gAAAD///////8AAAAP///////gAAAf///////8AAAH////////wAAA////////+AAAH////////gAAP////////8AAB/////////AAAA////////8AAAA////////wAAAB////////AAAAD///////8AAAAH///////wAAAAf///////AAAAA///////8AAAAD///////wAAAAH///////AAAAAf//////8AAAAA///////wAAAAD///////AAAAAP//////8AAAAA///////wAAAAB///////AAAAAH//////8AAAAAP//////wAAAAA//////+AAAAAB//////wAAAAAH/////fgAAAAAP////8eAAAAAAf////4AAAAAAA/////wAAAAAAB/////gAAAAAAD////+AAAAAAAH////8AAAAAAAP////wAAAAAAAP////gAAAAAAAf///+AAAAAAAAP///8AAAAAAAAP///4AAAAAAAAP///gAAAAAAAAP8f/AAAAAAAAAfw/8AAAAAAAAAzg/4AAAAAAAAGMB/wAAAAAAAAwgH/gAAAAAAAGGAP/AAAAAAAAwwAf8AAAAAAAEGAB/4AAAAAABgQAD/wAAAAAAOCAAH/gAAAAAA34AAf/AAAAAADDAAA/+AAAAAAMfwABh8AAAAAAxiAAABwAAAAAHGAAAAAAAAAAAOYAAAAAAAAAAA5gAAAAAAAAAABGAAAAAAAAAAACcAAAAAAAAAAABoAAAAAAAAAAACAAAAAAAAAAAAMAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"anthus-pratensis":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8AAAAAAAAAAAAAB/8AAAAAAAAAAAAA//4AAAAAAAAAAAAP//gAAAAAAAAAAAD//+AAAAAAAAAAAA///4AAAAAAAAAAAP///+AAAAAAAAAAD////4AAAAAAAAAA////4AAAAAAAAAAP///4AAAAAAAAAAB////AAAAAAAAAAAf///wAAAAAAAAAAf///+AAAAAAAAAAf////gAAAAAAAAAP////8AAAAAAAAAH/////gAAAAAAAAD/////4AAAAAAAAA//////AAAAAAAAAf/////4AAAAAAAAH//////AAAAAAAAD//////4AAAAAAAB///////AAAAAAAA///////4AAAAAAAf///////AAAAAAAH///////4AAAAAAD////////AAAAAAA////////4AAAAAAP////////AAAAAAH////////wAAAAAB////////+AAAAAAf////////wAAAAAD////////8AAAAAB/////////gAAAAB/////////4AAAAAf/////////AAAAAH/////////wAAAAAH////////8AAAAAD/////////gAAAAA/////////4AAAAAf////////8AAAAAP/////////AAAAAH/////////wAAAAD/+fv/////8AAAAB//gAf////+AAAAA//wAA/////gAAAAP/4AAB////wAAAAH/8AAAD///4AAAABv+AAAAD//4AAAAAD/AAAAA//4AAAAAA/wAAAADwHAAAAAAH4AAAAAOAOAAAAAAcAAAAAA4AcAAAAAAAAAAAADgA4AAAAAAAAAAAAODD/4AAAAAAAAAAAYv/+gAAAAAAAAAABgAZ/AAAAAAAAAAAGABgeAAAAAAAAAAAYADgAAAAAAAAAAABgACAAAAAAAAAAAAHAAAAAAAAAAAAAA4cHAAAAAAAAAAAAB//wAAAAAAAAAAAAAH+AAAAAAAAAAAAAAY/wAAAAAAAAAAAABwAAAAAAAAAAAAAADgAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"anthus-trivialis-2":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAcAAAAAAAAAAAAAAfIAAAAAAAAAAAAAP3AAAAAAAAAAAAAH/wAAAAAAAAAAAAD/8BgAAAAAAAAAAB/+AGwAAAAAAAAAAf/sA7QAAAAAAAAAP//ADtgAAAAAAAAH//wAP/gAAAAAAAB//8AB/+AAAAAAAA///AAH/4AAAAAAAf//wAAf/4AAAAAAH//8AAD//AAAAAAB///gAAP/+AAAAAA///wAAA//4AAAAAf//8AAAD//gAAAAH///gAAAP//AAAAB///4AAAA//+AAAAf//+AAAAH//4AAAP///gAAAAf//wAAD///4AAAAB///AAA///+AAAAAH///gAP///gAAAAAP//+AD///4AAAAAA///+A///+AAAAAAD///wP///gAAAAAAf///h///4AAAAAAB///+f//+AAAAAAAH///////gAAAAAAAf//////+AAAAAAAAf//////gAAAAAAAD//////+AAAAAAAA///////wAAAAAAAP//////+AAAAAAAP///////wAAAAAAf////////AAAAAAB////////4AAAAAAA///////+AAAAAAAD///////4AAAAAAAP///////AAAAAAAB///////4AAAAAAAH//////+AAAAAAAAf//////4AAAAAAAB///////AAAAAAAAH//////wAAAAAAAAP/////8AAAAAAAAA/////8AAAAAAAAAD/////gAAAAAAAAAP////+AAAAAAAAAA/////4AAAAAAAAAD/////AAAAAAAAAAP////8AAAAAAAAAA/////wAAAAAAAAAB/////AAAAAAAAAAD////+AAAAAAAAAAB////4AAAAAAAAAAAP///gAAAAAAAAAAAPH/+AAAAAAAAAAAAY3/4AAAAAAAAAAACGf/wAAAAAAAAAAAQz//AAAAAAAAAAACGP/8AAAAAAAAAAAQg//wAAAAAAAAAAEEH//AAAAAAAAAAAggf/8AAAAAAAAAAEER+AAAAAAAAAAAA88HgAAAAAAAAAAAGGAYAAAAAAAAAAAA4YAAAAAAAAAAAAADjwAAAAAAAAAAAAASLAAAAAAAAAAAAABIgAAAAAAAAAAAAAECAAAAAAAAAAAAAAQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"anthus-trivialis":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAD/4AAAAAAAAAAAAB//wAAAAAAAAAAAA///gAAAAAAAAAAAP//+AAAAAAAAAAAD////4AAAAAAAAAA////+AAAAAAAAAAP///+AAAAAAAAAAD////AAAAAAAAAAA////wAAAAAAAAAAP///8AAAAAAAAAAD////gAAAAAAAAAA////4AAAAAAAAAAP////AAAAAAAAAAH////4AAAAAAAAAD/////AAAAAAAAAA/////wAAAAAAAAAf////+AAAAAAAAAH/////wAAAAAAAAB/////+AAAAAAAAAf/////wAAAAAAAAH/////+AAAAAAAAD//////wAAAAAAAAf/////+AAAAAAAAH//////wAAAAAAAB//////+AAAAAAAAf//////wAAAAAAAH//////+AAAAAAAD///////wAAAAAAA///////8AAAAAAAP///////gAAAAAAB///////8AAAAAAAf///////AAAAAAAH///////4AAAAAAB///////+AAAAAAAP///////wAAAAAAD///////8AAAAAAA////////gAAAAAAH///////4AAAAAAB///////+AAAAAAAP///////gAAAAAAD///////8AAAAAAA////////AAAAAAAH///////wAAAAAAA///////4AAAAAAAH//////+AAAAAAAB///////gAAAAAAAf//////4AAAAAAAH//////8AAAAAAAB///////AAAAAAAAf//////AAAAAAAAH//////4AAAAAAAB////////AAAAAAAOf////wB/gAAAAADn/+B/+Af+AAAAAAx//gAB+efwAAAAAAP/4AAD/hcAAAAAAD/+AAAf+LAAAAAAA//AAA+e7wAAAAAAP/gAAGD4UAAAAAAD/4AABw3TgAAAAAA/+AAAIH4IAAAAAAH/wAABBpDAAAAAAB/8AAAInQAAAAAAAf/AAAACwAAAAAAAH/wAAAAEAAAAAAAB/+AAAADAAAAAAAAP/gAAAAAAAAAAAAD/4AAAAAAAAAAAAA/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/wAAAAAAAAAAAAA/+AAAAAAAAAAAAAP/gAAAAAAAAAAAAD/4AAAAAAAAAAAAAf+AAAAAAAAAAAAAH7gAAAAAAAAAAAAB8YAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"apus-apus-2":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAHAAAAAAAAAAAAAAHwAAAAAAAAAAAAAD8AAAAAAAAAAAAAA/AAAAAAAAAAAAAAfwAAAAAAAAAAAAAP8AAAAAAAAAAAAAH/AAAAAAAAAAAAAB/wAAAAAAAAAAAAA/8AAAAAAAAAAAAAP/AAAAAAAAAAAAAH/4AAAAAAAAAAAAB/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAP/4AAAAAAAAAAAAD/+AAAAAAAAAAAAA//gAAAAAAAAAAAAP/4AAAAAAAAAAAAH/+AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+AAAAAAAAAAAAD//wAAAAAAAAAAAA//4AAAAAAAAAAAAP/+AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+AAAAAAAAAAAAB//wAAAAAAAAAAAAf/+AAAAAAAAAAAAH//gAAAAAAAAAAP///8AAAAAAAAAAH////gAAAAAAAAAB////4AAAAAAAAAAf////AAAAAAAAAAD////4AAAAAAAAAA/////AAAAAAAAAAB////4AAAAAAAAAAP////gAAAAAAAAAB/////AAAAAAAAAB/////+AAAAAAAAA//////4AAAAAAAAP//////wAAAAAAAH///////gAAAAAAB////////gAAAAAAf////////wAAAAAP//+H/////4AAAAD//+AA/////+AAAA///AAA7P/8AfAAAP//AAADA/4AAAAAH//gAAAAD/AAAAAB//gAAAAAP4AAAAAf/4AAAAAA/AAAAAH/+AAAAAAB8AAAAB/+AAAAAAAHgAAAAf/gAAAAAAAOAAAAH/gAAAAAAAAwAAAB/wAAAAAAAABAAAAf4AAAAAAAAAEAAAH4AAAAAAAAAAAAAB8AAAAAAAAAAAAAAeAAAAAAAAAAAAAAGAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"apus-apus":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/4AAAAAAAAAAAA//4AAAAAAAAAAAD//+AAAAAAAAAAAP//+AAAAAAAAAAAP///AAAAAAAAAAAf///gAAAAAAAAAAf///gAAAAAAAAAAP///4AAAAAAAAAAP///8AAAAAAAAAAH///+AAAAAAAAAAH////gAAAAAAAAAH////wAAAAAAAAAD////4AAAAAAAAAB////8AAAAAAAAAAf////AAAAAAAAAAP////gAAAAAAAAAH////wAAAAAAAAAB////8AAAAAAAAAA////+AAAAAAAAAAH////gAAAAAAAAAB////wAAAAAAAB/wf///4AAAAAAAA//z////AAAAAAAAP//////4AAAAAAAD///////AAAAAAAA///////4AAAAAAAP///////AAAAAAAD///////8AAAAAAA////////AAAAAAAAf//////4AAAAAAAB///////gAAAAAAAH//////8AAAAAAAAf//////AAAAAAAAB//////4AAAAAAAAP//////AAAAAAAAA//////4AAAAAAAAD//////AAAAAAAAAf/////8AAAAAAAAB//////wAAAAAAAAH//////AAAAAAAAA//////8AAAAAAAAD//////wAAAAAAAAP//////AAAAAAAAA//////8AAAAAAAAB//////gAAAAAAAAD//////AAAAAAAAAP/////+AAAAAAAAAf/////8AAAAAAAAAf/////4AAAAAAAAA//////4AAAAAAAAA//////4AAAAAAAAA//////4AAAAAAAAH//////4AAAAAAAA5//////+AAAAAAAF/j/////+AAAAAAA8AH/////8AAAAAAGcAP//w//gAAAAAAwwAf//AAAAAAAAAHEAB//8AAAAAAAAAcAAH//4AAAAAAAAA4AAf//wAAAAAAAAAAAB///gAAAAAAAAAAAH///AAAAAAAAAAAAf/D+AAAAAAAAAAAB/wB4AAAAAAAAAAAH+ABgAAAAAAAAAAAf4AAAAAAAAAAAAAB/AAAAAAAAAAAAAAH4AAAAAAAAAAAAAAfgAAAAAAAAAAAAAB8AAAAAAAAAAAAAADwAAAAAAAAAAAAAAPAAAAAAAAAAAAAAA4AAAAAAAAAAAAAADgAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"ardea-alba-2":{"w":81,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAYgAAAAAAAAAAAGMAAAAAAAAAAABGAAAAAAAAAAAA75AAAAAAAAAAAP/4AAAAAAAAAAD/+AAAAAAAAAAB//wAAAAAAAAAAf//gAAAAAAAAAH//4AAAAAAAAAD///AAAAAAAAAA///wAAAAAAAAAP//8AAAAAAAAAH///4AAAAAAAAB///+AAAAAAAAA////gAAAAAAAAP///4AAAAAAAAD///+AAAAAAAAA////4AAAAAAAAP////AAAAAAAAD////wAAAAAAAA////4AAAAAAAAP////AAAAAAAAD////wAAAAAAAAf///8AAAAAAAAH///+AAAAAAAAA////wAAAAAAAAD///wAAAAAAAAAf//+AAAAAAAAAD///wAAAAAAAAAf//+AAAAAAAAAD///wAAAAAAAAAP///AAAAAAAAAB///4AAAAAAAAAP//+AAAAAH/+AD///4AAAAD/84Af///AAAAf//gAD///4AAB///8AA////AAAcAD/wAP///wAAAAAB+AB///+AAAAAAPwA////wAAAAAP8P////+AAAAAD/j/////wAAAAA/4/////+AAAAAH+H/////wAAAAA/h/////8AAAAAH8//////gAAAAAf//////8AAAAAH///////AAAAAB///////4AAAAAf//////+AAAAAD///////wAAAAA///////+AAAAAH///////gAAAAB///////+AAAAAf///////4AAAAD////////wAAAAf///////4AAAAD////////gAAAAf///////8AAAAD////////4AAAAf////////gAAAH////////wAAAA//////w/+AAAAH/////4B/gAAAB/////8ADsAAAAP////+AAOwAAAB////+AAAbAAAAf///+AAABoAAAD///+AAAAEgAAAf///gAAAAyAAAD///4AAAACYAAA///+AAAAAJAAAH///gAAAABkAAA///8AAAAAEQAAH///AAAAAARAAB///wAAAAADIAAP//+AAAAAAIgAB///gAAAAAAiAAf//4AAAAAAGOAD//+AAAAAAARwAf//gAAAAAABDgH//sAAAAAAAPuAv/9AAAAAAAA4YB//AAAAAAAADhgf/YAAAAAAAAPEDPyAAAAAAAAAYAbuAAAAAAAAAAgCcgAAAAAAAAACADEAAAAAAAAAAAAAAAAAAAAAAAAA"},"ardea-alba":{"w":47,"h":93,"bits":"AABwAAAAAAf4AAAAAB/4AAAAAH/8AAAAA//8AAAAH//0AAAB/wPgAAAPAAfAAABwAA+AAAAAAB8AAAAAAH4AAAAAB/gAAAAAP/AAAAAAf8AAAAAB/wAAAAAH+AAAAAAPwAAAAAA/A/AAAAB+D/gAAAD4P/gAAAHw//wAAAPx//gAAAfj//gAAA/v//gAAA////gAAB////gAAD////AAAD////AAAH////AAAP////AAAP///+AAAP///8AAAf///4AAAf///4AAAf///wAAAf///gAAAf///gAAAf///AAAAf///AAAAf///AAAAP//+AAAAP//+AAAAP//8AAAAf//4AAAA///wAAAA///gAAAA///AAAAB///AAAADf/+AAAACf/8AAAAEn/4AAAAJn/wAAAAJP/gAAAASf/AAAAAkf8AAAABM/wAAAADJ9gAAAACRwAAAAAEwAAAAAAIgAAAAAARAAAAAAAiAAAAAABEAAAAAACIAAAAAAEQAAAAAAIgAAAAAAxAAAAAABiAAAAAACEAAAAAAEIAAAAAAIQAAAAAAQgAAAAAAhAAAAAABCAAAAAACEAAAAAAEIAAAAAAIQAAAAAAQgAAAAABhAAAAAADCAAAAAAGEAAAAAf/4AAAAAfwwAAAAPGBgAAAAQwDAAAAAAAGAAAAAAf/gAAAAADwAAAAAAZAAAAAADEAAAAAAYQAAAAAABAAAAAAAAAAAA=="},"ardea-cinerea-2":{"w":93,"h":84,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAPgAAAAAAAAAAAAB/wIAAAAAAAAAAAH///AAAAAAAAAAAP///gAAAAAAAAAAf///gAAAAAAAAAA/////4AAAAAAAAA//////AAAAAAAAAf////+AAAAAAAAAf/////4AAAAAAAAP//////wAAAAAAAH//////4AAAAAAAB//////+AAAAAAAAf//////gAAAAAAAH//////wAAAAAAAA//////8AAAAAAAAH/////+AAAAAAAAA//////gAAAAAAAAH/////wAAAAAAAAAf////4AAAAAAAAAD////4AAAAAAAAAAf///8AAAAAAAAAAD///8AAAAAAAAAAAf///gAAAAAAAAAAD///+AAAAAAAAAAAf///gAAAAAAAAAAH///+AAAAAAAAAAA////wAAAAAAAAAAH///8AAAAAAAAADB////gAAAAAAD//wP///8AAAAAAB/+AD////gAAAAAA//wA////8AAAAAA//+Af////AAAAAA///4f////4AAAAA/+//H////+AAAAAf/+H5/////gAAAAGAAA/f////8AAAAAAAAP//////AAAAAAAAD//////wAAAAAAAF//////8AAAAAAAD///////wAAAAAAA///////8AAAAAAAP///////wAAAAAAB////////gAAAAAAf////////8AAAAAD/////////4AAAAA/////////+AAAAAH/////////wAAAAB/////////+AAAAAP/////////wAAAAB/////////8AAAAAP/////////AAAAAB//////P//4AAAAAf/////gB+eAAAAAD/////gAD5wAAAAAf///+AAADnAAAAAH///+AAAAOMAAAAA///+AAAAA4wAAAAH///AAAAADCAAAAA///wAAAAAMIAAAAP//+AAAAAAwgAAAB///gAAAAADCAAAAP//8AAAAAAMIAAAB///AAAAAAAggAAAf//wAAAAAACH+AAD//+AAAAAAAIfAAAf//wAAAAAAB/8AAD//8AAAAAAAH/4AAf//AAAAAAAAeHwAD//wAAAAAAAA8PAA//8AAAAAAAADwIAH//gAAAAAAAAHgAA3/oAAAAAAAAAOAAE/YAAAAAAAAAAAAAG7AAAAAAAAAAAAAAmYAAAAAAAAAAAAAEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"ardea-cinerea":{"w":65,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAAD/gAAAAAAAAf/wAAAAAAAB//4AAAAAAAf//sAAAAAAP///uAAAAAD////EAAAAA////+AAAAAAAAQH8AAAAAAAAAP4AAAAAAAAA/wAAAAAAAAH/AAAAAAAAA/+AAAAAAAAD/4AAAAAAAAH/gAAAAAAAAf+P4AAAAAAA/g/8AAAAAAB/D/+AAAAAAD+P/+AAAAAAH8///AAAAAAP9///AAAAAAf////AAAAAA/////AAAAAA/////AAAAAB/////AAAAAD/////AAAAAD/////AAAAAH////+AAAAAH////+AAAAAP////+AAAAAP////+AAAAAf////8AAAAAf////8AAAAAf////4AAAAA/////4AAAAA/////wAAAAA/////wAAAAA/////gAAAAA/////gAAAAAf////AAAAAAf////AAAAAAf///+AAAAAAf///8AAAAAAf///4AAAAAAf///wAAAAAAf///wAAAAAA////gAAAAAA////AAAAAAB////AAAAAAB///+AAAAAAB///8AAAAAADb//4AAAAAACz//wAAAAAAEh//gAAAAAANgf/gAAAAAAbAf/AAAAAAASAf+AAAAAAA2Af8AAAAAADsA/4AAAAAADYA/wAAAAAAGwA5AAAAAAAJgAwAAAAAAATAAAAAAAAAAmAAAAAAAAADMAAAAAAAAAGYAAAAAAAAAMwAAAAAAAAARgAAAAAAAAAjAAAAAAAAABGAAAAAAAAACIAAAAAAAAAEQAAAAAAAAAIgAAAAAAAAARAAAAAAAAABiAAAAAAAAADEAAAAAAAAAHIAAAAAAAA//4AAAAAAADPx/AAAAAAAAZf8AAAAAAAHPeAAAAAAAAYx8AAAAAAABhmIAAAAAAAAAQQAAAAAAAADBgAAAAAAAAMCAAAAAAAAAAEAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"arenaria-interpres-2":{"w":82,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAwAAAAAAAAAAAAGAAAAAAAAAAAAA+AAAAAAAAAAAAHwAAAAAAAAAAAA+AAAAAAAAAAAAD8AAAAAAAAAAAAfwAAAAAAAAAAAD+AAAAAAAAAAAAf4AAAAAAAAAAAD/gAAAAAAAAAAAP+AAAAAOAAAAAB/4AAAAHwAAAAAP/AAAAD8AAAAAA/+AAAA/8AAAAAH/wAAAf/gAAAAAf/AAAH/4AAAAAD/8AAB//AAAAAAf/gAAf/+AAAAAB//AAD//wAAAAAP/4AA//8AAAAAB//gAP//gAAAAAH/+AD//+AAAAAA//4A///wAAAAAD//AH//+AAAAAAf/8B///gAAAAAB//gP//+AAAAAAP/+D///wAAAAAA//4///+AAAAAAH//H///wAAAAAAf/+///+AAAAAAD//////wAAAAAAP/////+AAAAAAA//////wAAAAAAH/////+AAAAAAAf/////gAAAAAAB/////8AAAAAAAH/////AAAAAAAAP////8AAAAAAAAf////wAAAAAAAA////+AAAAAAAAD////4AAAAAAAAH////gAAAAAAAAf///+AAAAAAB8A////4AAAAAAf+D////gAAAAAD/8P///+AAAAAAf/9////wAAAAAB///////AAAAAAH//////8AAAAAB///////wAAAAAf//////+AAAAAHz//////4AAAAAgD//////gAAAAAAH/////+AAAAAAAP/////8AAAAAAAf/////4AAAAAAB//////gAAAAAAH//////AAAAAAAP/////+AAAAAAA//////4AAAAAAB//////wAAAAAAD//////wAAAAAAH//////gAAAAAAP//////gAAAAAAP//////gAAAAAAf//////gAAAAAAf//////wAAAAAAf//////4AAAAAAf//////8AAAAAAP//////wAAAAAAD///h//AAAAAAAAf/gAD8AAAAAAAAf+AAAAAAAAAAAAH8AAAAAAAAAAAAD4AAAAAAAAAAAANgAAAAAAAAAAAAbAAAAAAAAAAAABmAAAAAAAAAAAACMAAAAAAAAAAAAM/AAAAAAAAAAAAZwAAAAAAAAAAAB/wAAAAAAAAAAADHwAAAAAAAAAAAPHgAAAAAAAAAAAPDgAAAAAAAAAAAeCAAAAAAAAAAAAcAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"arenaria-interpres":{"w":93,"h":67,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAAAAAAB/8AAAAAAAAAAAAA//wAAAAAAAAAAAAP//AAAAAAAAAAAAB//8AAAAAAAAAAAAP//wAAAAAAAAAAAB///AAAAAAAAAAAAf//4AAAAAAAAAAAH///gAAAAAAAAAAD////8AAAAAAAAAB//////AAAAAAAAAfH/////gAAAAAAAOAP/////wAAAAAAAAA//////wAAAAAAAAH//////gAAAAAAAA///////gAAAAAAAH///////AAAAAAAA///////+AAAAAAAH///////4AAAAAAA////////4AAAAAAP////////4AAAAAA/////////+AAAAAH///////////4AAA////////////AAAH///////////gAAAf///////////4AAD////////////AAAP///////////4AAB////////8AQAAAAH////////AAAAAAAf//////vAAAAAAAB//////AAAAAAAAAP///8CAAAAAAAAAAf//8AAAAAAAAAAAB//+AAAAAAAAAAAAH//gAAAAAAAAAAAAP/wAAAAAAAAAAAAAf8AAAAAAAAAAAAAA8AAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAiQIAAAAAAAAAAAAAxjAAAAAAAAAAAAAcGQAAAAAAAAAAAABgOAAAAAAAAAAAAAcBgAAAAAAAAAAAADgOAAAAAAAAAAAAAYBwAAAAAAAAAAAADAMAAAAAAAAAAAAAQBgAAAAAAAAAAAAGAMAAAAAAAAAAAAAwBgAAAAAAAAAAAAEAIAAAAAAAAAAAABgDAAAAAAAAAAAAAMAYAAAAAAAAAAAADwDAAAAAAAAAAAAf7A4AAAAAAAAAAA/+HfAAAAAAAAAAAAHj/4AAAAAAAAAAABg/jAAAAAAAAAAAAAAAIAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"asio-flammeus-2":{"w":93,"h":80,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAA8AAAAAAAAAAAAAAPMAAAAAAAAAAAAAD7gAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/4AAAAAAAAAAAAB/+4AAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAB//+AAAAAAAAAAAAf//hAAAAAAAAAAAH//4OAAAAAAAAAAB///w4AAAAAAAAAAf//+zwAAAAAAAAAH///z/AAAAAAAAAD///8f8AAAAAAAAA////h/4AAAAAAAAP///4f/gAAAAAAAD////B//AAAAAAAA////4P/8AAAAAAAP////A//4AAAAAAD////wD//gAAAAAA////+A///gAAAAAH////gD//+AAAAAB////8Af//8AAAAAf////gB///wAAAAD////4AD///gAAAA////+AA////AAAAH////gAH///8AAAB////4AAf///wAAAP////AAB////gAAB////wAAD///+AAAf///8AAAf///wAAD///+AAAD////AAA////gAAAP///8AAH///+AAAAf///wAB////gAAAB////AAf///8AAAAH///8AD////gAAAAf////g////4AAAAAP/////////AAAAAB/////////4AAAAAH/////////AAAAAA/////////4AAAAAH/////////AAAAAAP////////wAAAAAB////////+AAAAAAH////////gAAAAAAf///////4AAAAAAB////////AAAAAAAD///////wAAAAAAAf//////8AAAAAAAA///////AAAAAAAAB//////wAAAAAAAAD/////4AAAAAAAAAP////wAAAAAAAAAA/////AAAAAAAAAAD////8AAAAAAAAAAP////4AAAAAAAAAA/////gAAAAAAAAAD/////AAAAAAAAAAH////+AAAAAAAAAAf////8AAAAAAAAAAf////4AAAAAAAAAA/////gAAAAAAAAAD////4AAAAAAAAAAP///+AAAAAAAAAAA////wAAAAAAAAAAB///8AAAAAAAAAAAH//+AAAAAAAAAAAB///wAAAAAAAAAAAP//wAAAAAAAAAAAD//wAAAAAAAAAAAAfeAAAAAAAAAAAAAB7wAAAAAAAAAAAAAPeAAAAAAAAAAAAAA54AAAAAAAAAAAAAAEAAAAA"},"asio-flammeus":{"w":56,"h":93,"bits":"AAAfgAAAAAAD//wAAAAAH///gAAAAH///8AAAAD////wAAAB////+AAAA/////wAAAf////8AAAH/////gAAD/////8AAA//////AAAf/////wAAH/////+AAB//////gAAf/////4AAP/////+AAD//////gAA//////4AAP/////+AAD//////wAA//////8AAP//////AAD//////wAA//////8AAP//////gAD//////8AA///////gAP//////8AD///////gB///////4Af///////AH///////4D///////+A////////wP///////8D////////gf///////4H////////B////////wf///////8H////////h////////4P///////+D////////w////////8P////////B////////wf///////8H////////h////////4P///////+D////////gf///////wH///////+A////////gD///////4Af//////+AH///////gA///////4AH//////+AA///////gAP//////4AB//////+AAP//////gAD//////8AAf//////AAD//////wAAf/////8AAH//////AAA//////wAAP/////4AAB/////+AAAf/////AAAH/////wAAA/////8AAAP/////AAAD/////4AAA/////+AAAf/////gAAP/////4ABv/////+AD///////gBv//////oAR+A////4AAWAH///+AAAAD////gAAAD/zz/4AAAAk4AP+AAAAAeAAAAAAAAOAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAA"},"asio-otus-2":{"w":81,"h":93,"bits":"AAAAAAAAAAABAAAAAAAAAAAAA4YAAAAAAAAAAAfPAAAAAAAAAAAHzwYAAAAAAAAAD/+DmAAAAAAAAA//ncwAAAAAAAAP/73nAAAAAAAAD//+/5AAAAAAAA///n/cAAAAAAAf//4//gAAAAAAH//+X/+AAAAAAB///+//0AAAAAAf///3//wAAAAAH///8f//AAAAAB////D//4AAAAAf///wf//oAAAAH///+j///gAAAB////8f//8AAAAP////h///wAAAD////4P//+AAAA////+B///8AAAP////4H///gAAD/////A///8AAA/////4D///gAAH////+Af//+AAB/////AD///4AAf////4AP///AAH/////gA///4AA/////4AH///AAP////+AA///+AB/////gAH///8AP////4AA////wB////+AAH////Af////wAAf///8D////8AAB////gf///8AAAP///+D////gAAA////4f///8AAAD////j///+AAAAH///8f///wAAAAf///z////AAAAA///+////wAAAAj////////AAAAOP///////4AAABx///////+AAAAPH///////wAAAB4///////+AAAAPf///////wAAAA////////+AAAAH////////wAAAAf///////8AAAAH////////gAAAA////////8AAAAH////////gAAAA////////4AAAAH////////AAAAA////////4AAAAH///////+AAAAA////////wAAAAH///////+AAAAAf///////AAAAAB///////wAAAAAP/////+wAAAAAA//////wAAAAAAA//////AAAAAAAH/////8AAAAAAAf/////wAAAAAAB//////gAAAAAAB/////+AAAAAAAH/////8AAAAAAAf/////wAAAAAAA//////gAAAAAAD//////AAAAAAAH/////8AAAAAAAP/////4AAAAAAAP/////wAAAAAAA//////gAAAAAAD/////4AAAAAAAf////8AAAAAAAB/////gAAAAAAAB9///8AAAAAAAAH3//+AAAAAAAAB4///gAAAAAAAAfP3/gAAAAAAAADv8TAAAAAAAAAAc/wAAAAAAAAAADjmAAAAAAAAAAAeeQAAAAAAAAAAD7wAAAAAAAAAAAMeAAAAAAAAAAAAx8AAAAAAAAAAAAGAAAAAAAAAAAAAYAAAAA"},"asio-otus":{"w":54,"h":93,"bits":"AAAAAAAAAAgAAGAAAABwAAOAAAAB4AAPAAAAB8AAeAAAAB+AA+AAAAA/AB+AAAAA/AB+AAAAA/gB8AAAAAf//8AAAAAf//8AAAAA///+AAAAB////AAAAD////AAAAD////gAAAD////gAAAH////gAAAH////wAAAH////wAAAH////wAAAH////wAAAH////4AAAP////4AAAP////4AAAP////4AAAP////4AAAP////8AAAP////8AAAP////+AAAP/////AAAf/////gAAf/////wAAf/////wAAf/////4AA//////8AA//////8AA//////+AA///////AA///////AA///////AA///////gA///////gAf//////gAf//////wAf//////wAf//////wAf//////wAf//////4Af//////4AP//////4AP//////4AP//////4AH//////4AC//////4AAf/////4AAP/////4AAP/////8AAH/////8AAH/////8AAD/////8AAB/////8AAB/////8AAA/////+AAAf////+AAAP////+AAAP////+AAAH////8AAAH////8AAAH////8AAAH////8AAAH////+AAAf/////AAB//////AAD//////gAD//////wAH/3n///4AG7nD///8ACznB///8AAZmB//v+AAACG//n+AAABA//z/AAAAA//x3AAAAA//wwAAAAAf/wQAAAAAf/wQAAAAAf/wAAAAAAf/wAAAAAAP/wAAAAAAP/wAAAAAAH/wAAAAAAD/wAAAAAAB/gAAAAAAAGAAA=="},"aythya-affinis-2":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAaAAAAAAAAAAAAAAfwAAAAAAAAAAAAAf8AAAAAAAAAAAAAf/wAAAAAAAAAAAAf/8AAAAAAAAAAAAf//AAAAAAAAAAAAP//4AAAAAAAAAAAH//+AAAAAAAAAAAH///gAAAAAAAAAAD///8AAAAAAAAAAB////AAAAAAAAAAA////gAAAAAAAAAAf///8AAAAAAAAAAP////AAAAAAAAAAD////wAAAAAAAAAB////8AAAAAAAAAAf///+AAAAAAAAAAH////gAAAAAAAAAB////4AAAAAAAAAAf///8AAAAAAAAAAH///+AAAAAH4AAAA////gAAAAD//wAAP///wAAAAB//+AAB///4AAAAAP//gAAP//+AAAAAD//4AAD///gAAAAA///gAA///8AAAAAP//8AAH///gAAAAH///wAB///8AAAAD////gA////gAAAB/////D////8AAAAbwB////////gAAAAAAAf//////4AAAAAAAB///////AAAAAAAAH//////wAAAAAAAA//////+AAAAAAAAD//////wAAAAAAAAf/////8AAAAAAAAP//////wAAAAAAAH//////8AAAAAAAB///////wAAAAAAAf//////+AAAAAAAH///////wAAAAAAB///////+AAAAAAAf///////wAAAAAAD////////AAAAAAA////////8AAAAAAP////////wAAAAAB/////////AAAAAAf////////8AAAAAH/////////wAAAAA///AH/////AAAAAP//gAf////4AAAAD//4AA/////gAAAAf/8AAB////+AAAAH//gAAD////8AAAB//4AAAH////+AAAP/8AAAAP////gAAD//AAAAAP///+AAA//gAAAAAH///gAAP/4AAAAAAP//8AAB/6AAAAAAAf/+AAAf+AAAAAAAAfgAAAH+gAAAAAAAAAAAAB/AAAAAAAAAAAAAAbAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"aythya-affinis":{"w":93,"h":78,"bits":"AAAAAAAAAAAAAAAAAAP/AAAAAAAAAAAAAD//wAAAAAAAAAAAA//+AAAAAAAAAAAAP//gAAAAAAAAAAAD//8AAAAAAAAAAAA///gAAAAAAAAAAAH//+AAAAAAAAAAAA///wAAAAAAAAAAAH///AAAAAAAAAAAA///4AAAAAAAAAAAP///gAAAAAAAAAAB///8AAAAAAAAAAAf///gAAAAAAAAAAH///+AAAAAAAAAAD////wAAAAAAAAAA////+AAAAAAAAAAf////wAAAAAAAAAP////+AAAAAAAAAD/4f//gf+AAAAAAA/wA//8///gAAAAAAAAP//////gAAAAAAAD///////gAAAAAAB////////AAAAAAAf///////8AAAAAAH////////4AAAAAA/////////gAAAAAP/////////gAAAAD//////////gAAAAf//////////AAAAD//////////+AAAA///////////8AAAH///////////8AAA////////////4AAH////////////wAA/////////////AAH////////////AAA////////////+AAD////////////+AAf////////////8AD/////////////gAP////////////gAB////////////8AAH////////////gAAf////////////AAB////////////wAAH///////////+AAAP///////////+AAA////////////wAAB///////////8AAAB//////////+AAAAB/////////AAAAAAB////////AAAAAAAB///////AAAAAAAAD//////gAAAAAAAAP/////wAAAAAAAAD/////wAAAAAAAAAf////wAAAAAAAAAD/B///AAAAAAAAAA/8AH/wAAAAAAAAAH/gB/8AAAAAAAAAA/+Af4AAAAAAAAAAH/AH4AAAAAAAAAAA/wB/AAAAAAAAAAAAcAf0AAAAAAAAAAABgH8AAAAAAAAAAAAED/wAAAAAAAAAAAAA/+AAAAAAAAAAAAAF/wAAAAAAAAAAAAAP+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAP+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAP+AAAAAAAAAAAAABnwAAAAAAAAAAAAAIMAAAAAAAAAAAAABAgAAAAAAAAAAAAAAAAAAAAAA=="},"aythya-collaris-2":{"w":93,"h":73,"bits":"AAAAAAAAAAAAAAAAAAAAAACgAAAAAAAAAAAAAAUgAAAAAAAAAAAAADsAAAAAAAAAAAAAA/YAAAAAAAAAAAAAH+AAAAAAwAAAAAAA/0AAAAAMQAAAAAAP/AAAAADuAAAAAAB/8AAAAB/gAAAAAAP/wAAAA/4AAAAAAD/8AAAAP+wAAAAAAf/gAAAH/8AAAAAAH/+AAAD//AAAAAAA//wAAA//8AAAAAAH/+AAAf//gAAAAAB//4AAH//4AAAAAAP//AAD//+AAAAAAD//wAA///wAAAAAAf//AAf//+AAAAAAD//4AP///gAAAAAA//+AD///4AAAAAAH//wB////AAAAAAB//+Af///wAAAAAAP//wH///8AAAAAAB//+B////AAAAAAAP//g////4AAAAAAD//8P///+AAAAAAAf//j////gAAAAAAD//+////4AAAAAAAf//////+AAAAAAAD///////gAAAAAAAP//////wAAAAAAAB//////8AAAAAAwAH//////AAAAB//wAf/////AAAAAf/8AD/////4AAAAH//gAP////+AAAAA//+AB/////wAAAAP//4AP/////AAAAD///gB/////wAAAA///+AP////+AAAAf///4B/////wAAAP////gf////+AAAH+B/////////wAAAAAAD///////8AAAAAAAP///////gAAAAAAA///////4AAAAAAAH///////AAAAAAAA///////wAAAAAAAH//////+AAAAAAAA///////wAAAAAAAD//////+AAAAAAAAf//////wAAAAAAAB//////8AAAAAAAAP//////4AAAAAAAA///////gAAAAAAAB///////AAAAAAAAH//////8AAAAAAAAP//////wAAAAAAAAf//////AAAAAAAAA//////8AAAAAAAAB//////wAAAAAAAAD//////AAAAAAAAAH//////gAAAAAAAAP/////7AAAAAAAAAf/////wAAAAAAAAA//////gAAAAAAAAA/////+AAAAAAAAAAf//4GAAAAAAAAAAAAH/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAAD/AAAAAAAAAAAAAAAAAA"},"aythya-collaris":{"w":93,"h":67,"bits":"AAAP4AAAAAAAAAAAAAP/wAAAAAAAAAAAAD//AAAAAAAAAAAAB//8AAAAAAAAAAAAf//gAAAAAAAAAAAH//8AAAAAAAAAAAA///gAAAAAAAAAAAP//8AAAAAAAAAAAB///gAAAAAAAAAAAP//+AAAAAAAAAAAB///wAAAAAAAAAAAf///AAAAAAAAAAAD///4AAAAAAAAAAAf///AAAAAAAAAAAH///4AAAAAAAAAAB////AAAAAAAAAAAf///8AAAAAAAAAAH////AAAAAAAAAAD////4AAAAAAAAAB////8P//AAAAAAA//D//v///wAAAAAH+Af//////wAAAAAwAP///////gAAAAAAP////////AAAAAAD/////////AAAAAA/////////+AAAAAP/////////8AAAAD//////////8AAAAf//////////4AAAH///////////gAAA///////////+AAAP///////////8AAB////////////+AAP////////////+AB/////////////wAP////////////8AB/////////////wAP////////////+AA/////////////4AH/////////////4A//////////////gD//////////////AP/////////////wB/////////////4AH///////////gwAAP//////////wAAAA//////////4AAAAB/////////8AAAAAB////////+AAAAAAA////////AAAAAAAAP//////wAAAAAAAAH/////wAAAAAAAAAB////gAAAAAAAAAAP///4AAAAAAAAAAD//h8AAAAAAAAAAAP/8AAAAAAAAAAAAB//gAAAAAAAAAAAAP/QAAAAAAAAAAAAB/4AAAAAAAAAAAAAf+AAAAAAAAAAAAAD/wAAAAAAAAAAAAA/+AAAAAAAAAAAAAEfwAAAAAAAAAAAAAh8AAAAAAAAAAAAAADAAAAAAAAAAAAAAAYAAAAAAAAAAAAAABAAAAAAAAA="},"aythya-ferina-2":{"w":93,"h":84,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAABsAAAAAAADAAAAAANkAAAAAAAxAAAAABtgAAAAAAc4AAAAAPsAAAAAAHuAAAAAB/sAAAAAD/gAAAAAP/gAAAAB/5gAAAAB/9AAAAA//4AAAAAf/4AAAAP/+AAAAAD//AAAAH//gAAAAAf/4AAAB//6AAAAAD//gAAA///wAAAAA//8AAAP//8AAAAAH//gAAD///AAAAAA//+AAB///4AAAAAH//wAAf///AAAAAB//+AAH///wAAAAAP//wAB///8AAAAAB///AA////gAAAAAP//wAP///8AAAAAB//+AD////AAAAAAP//wA////wAAAAAB//+AP///8AAAAAAf//wD////gAAAAAD//+A////4AAAAAAf//gP///+AAAAAAD//+D////gAAAAAAf//4////8AAAAAAD///n////AAAAAAAf///////gAAAAAAB///////4AAAAB/gH//////+AAAAA//Af/////+AAAAAP/+B//////wAAAAD//4H/////8AAAAAf//gf/////gAAAAD//+D/////8AAAAA///wf/////gAAAAH//+B/////8AAAAD///4P/////gAAAA////B/////8AAAAf///8f/////AAAAP8H//3/////4AAABgAAf///////AAAAAAAD///////4AAAAAAAP//////+AAAAAAAB///////wAAAAAAAP//////8AAAAAAAB///////gAAAAAAAP//////4AAAAAAAB///////AAAAAAAAH//////4AAAAAAAA///////AAAAAAAAD//////8AAAAAAAAf/////+AAAAAAAAB//////wAAAAAAAAH//////AAAAAAAAAP/////8AAAAAAAAA//////wAAAAAAAAB//////AAAAAAAAAH/////8AAAAAAAAAP/////wAAAAAAAAA//////AAAAAAAAAB/////8AAAAAAAAAH/////wAAAAAAAAAP////+AAAAAAAAAA/////8AAAAAAAAAB/////8AAAAAAAAAB/////gAAAAAAAAAD/////AAAAAAAAAAD////4AAAAAAAAAAB////gAAAAAAAAAAH//8wAAAAAAAAAAA//+AAAAAAAAAAAAD//gAAAAAAAAAAAAP9/gAAAAAAAAAAAA/H+AAAAAAAAAAAAD4PwAAAAAAAAAAAAHA4AAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"aythya-ferina":{"w":93,"h":60,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAAAAAAAAAAAH/gAAAAAAAAAAAAD//AAAAAAAAAAAAA//8AAAAAAAAAAAAP//gAAAAAAAAAAAB//+AAAAAAAAAAAAf//wAAAAAAAAAAAD//+AAAAAAAAAAAA///4AAAAAAAAAAAH///AAAAAAAAAAAA///8AAAAAAAAAAAP///wAAAAAAAD/wB////AAAAAD////8P///8AAAB//////8////4AAD//////////3/wAH//////////wD/gAP/////////+AD8D8f/////////wAAA///////////+AAAH///////////8AAA////////////4AAH////////////gAAf///////////+AAB////////////wAAH////////////AAAH///////////4AAAH///////////gAAAf//////////8AAAB///////////gAAAH//////////8AAAA///////////gAAAD//////////8AAAAP//////////gAAAA//////////4AAAAH//////////AAAAAf/////////wAAAAA/////////+AAAAAB/////////gAAAAAD////////4AAAAAAA///////+AAAAAAAH///////AAAAAAAAf//////gAAAAAAAB//////gAAAAAAAAB/////4AAAAAAAAAD//h//wAAAAAAAAAf/+P/gAAAAAAAAAD//hB8AAAAAAAAAAD/8AAgAAAAAAAAAAP/gAAAAAAAAAAAAB//AAAAAAAAAAAAAH/sAAAAAAAAAAAAAfgAAAAAAAAAAAAAB4AAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"aythya-fuligula-2":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAABoAAAAAAAAAAAAABoAAAAAAAAAAAAAB5AAAAAAAAAAAAAD7AAAAAAAAAAAAAD+AAAAAAAAAAAAAH+gAAAABAAAAAAAH/gAAAAGIAAAAAAP/gAAAAOwAAAAAAP/oAAAAdwAAAAAAf/4AAAA/sAAAAAAf/wAAAD/4AAAAAA//wAAAH/wAAAAAA//8AAAP/gAAAAAA//4AAA//4AAAAAB//4AAB//wAAAAAB//8AAD//wAAAAAB//8AAH//wAAAAAD//8AAf//wAAAAAD//8AA///gAAAAAD//8AB///AAAAAAH//8AD///gAAAAAH//4AH///AAAAAAH//4Af//+AAAAAAH//4A///+AAAAAAH//4B///+AAAAAAP//wD///+AAAAAAP//wH///8AAAAAAP//wf///4AAAAAAf//w////4AAAAAAf//h////4AAAAAAf//h////wAAAAAAf//z////gAAAAAAf//3////AAAAAAAf///////AAAAAAAP//////8AAAAP8AP//////8AAAA//gH//////4AAAB//wD//////gAAAB//8B//////AAAAD//+B/////+AAAAD///g/////8AAAAH///8/////8AAAAP///4/////8AAAA///+Q/////8AAAH///+A/////8AAAP/f//A/////8AAAAAD//g/////8AAAAAAH///////8AAAAAAD///////8AAAAAAB///////4AAAAAAB///////4AAAAAAB///////4AAAAAAB///////wAAAAAAB///////wAAAAAAB///////gAAAAAAB///////gAAAAAAB///////AAAAAAAA///////AAAAAAAA///////AAAAAAAAf//////AAAAAAAAP/////4AAAAAAAAP/////8AAAAAAAAD/////+AAAAAAAAB//////gAAAAAAAA//////gAAAAAAAAP/////wAAAAAAAAH/////4AAAAAAAAB/////8AAAAAAAAA/////+AAAAAAAAAf/////AAAAAAAAAH/////AAAAAAAAAD/////gAAAAAAAAA/////wAAAAAAAAAP////wAAAAAAAAAD////4AAAAAAAAAAf///8AAAAAAAAAAD////AAAAAAAAAAAH///gAAAAAAAAAAD/8fwAAAAAAAAAAD/+D4AAAAAAAAAAB/+AAAAAAAAAAAAAf/AAAAAAAAAAAAAP/4AAAAAAAAAAAAD3+AAAAAAAAAAAAAz/AAAAAAAAAAAAAA4AAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"aythya-fuligula":{"w":93,"h":63,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/+AAAAAAAAAAAAAf/+AAAAAAAAAAAAP//8AAAAAAAAAAAD///wAAAAAAAAAAAef//AAAAAAAAAAADH//8AAAAAAAAAAAB///gAAAAAAAAAAAP//8AAAAAAAAAAAB///gAAAAAAAAAAAf//+AAAAAAAAAAAD///gAAAAAAAAAAAf//8AAAAAAAAAAAD///gAAAAAAA//8Af//+AAAAAAH///+D///wAAH/wf////+P///AAAf///////9///8AB4////////////wA/5//////////n/AH/v/////////8P+A////////////g/4H///////////+B/gf///////////4AYB////////////gAAH///8D//////+AAAf//+AH//////8AAAf//gAP//////gAAA//4AA//////+AAAD/+AAD//////4AAAf/gAAH//////AAAB/4AAAH/////4AAAH/AAAADz////gAAA/wAAAAAf///8AAAH+AAAAAD////gAAAfwAAAAA////8AAAD+AAAAAH////gAAAHwAAAAAf///8AAAAfAAAAAD////gAAAB8AAAAAf///8AAAAHwAAAAD////AAAAAGgAAAAP///4AAAAAHwAAAA///+AAAAAA/4AAAH///gAAAAAH/+AAAf//4AAAAAAD/4AAB//+AAAAAAAB/8AAD//AAAAAAAAf//4Af/gAAAAAAAD//+B//wAAAAAAAAA//gP//AAAAAAAAAH/4D//8AAAAAAAAAf/Aj//wAAAAAAAAD/4AH//AAAAAAAAAf/AAPgAAAAAAAAAB+EAA4AAAAAAAAAAPAgADAAAAAAAAAAAwAAAQAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"bombycilla-garrulus-2":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAA8QAAAAAAAAAAAAAfeAAAAAAAAAAAAAP/jAAAAAAAAAAAAH/4OAAAAAAAAAAAB//g8AAAAAAAAAAA//8b4AAAAAAAAAAf//D/wAAAAAAAAAH//wP/gAAAAAAAAB//+A//AAAAAAAAA///wD/+AAAAAAAAP//8A//4AAAAAAAD///AD//wAAAAAAB///wAP//AAAAAAA///+AA//+AAAAAAP///gAD//4AAAAAH///8AAf//wAP4AB////AAB///gH/AAf///wAAH///D/wAH///+AAAf//8/8AB////gAAB/////AAf///4AAAP////8AH///+AAAA/////wB////gAAAB/////AP///4AAAAP////8D///+AAAAA/////wf///AAAAAD////////+wAAAAAH////////8AAAAAA/////////gAAAAAB////////4AAAAAAD////////wAAAAAAB///////4AAAAAAAP///////gAAAAAAD///////+AAAAAAAH///////gAAAAAAB///////+AAAAAAAD///////wAAAAAAAf//////+AAAAAAAB///////gAAAAAAAP//////8AAAAAAAA///////AAAAAAAAH//////wAAAAAAAAP/////YAAAAAAAAA/////4AAAAAAAAABf////AAAAAAAAAAB////8AAAAAAAAAAP////gAAAAAAAAAA////+AAAAAAAAAAD////wAAAAAAAAAAH////AAAAAAAAAAAf///4AAAAAAAAAAB////AAAAAAAAAAAD///8AAAAAAAAAAAP///gAAAAAAAAAAB///+AAAAAAAAAAAP///wAAAAAAAAAAB////AAAAAAAAAAAH7//8AAAAAAAAAAAeH//gAAAAAAAAAAAgD/+AAAAAAAAAAAAAP/4AAAAAAAAAAAAB//wAAAAAAAAAAAAP//AAAAAAAAAAAAB//8AAAAAAAAAAAAP//wAAAAAAAAAAAB///AAAAAAAAAAAAH//8AAAAAAAAAAAA///wAAAAAAAAAAAH//+AAAAAAAAAAAA///gAAAAAAAAAAAH//QAAAAAAAAAAAAf+AAAAAAAAAAAAAD+AAAAAAAAAAAAAAAAAAAA="},"bombycilla-garrulus":{"w":93,"h":92,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAD//AAAAAAAAAAAAD///gAAAAAAAAAAAP///AAAAAAAAAAAAP//+AAAAAAAAAAAAf//8AAAAAAAAAAAAf//4AAAAAAAAAAAB///gAAAAAAAAAAAf//+AAAAAAAAAAAH///8AAAAAAAAAAB////4AAAAAAAAAAf////8AAAAAAAAAH/////wAAAAAAAAA/////8AAAAAAAAAP////+AAAAAAAAAB////+AAAAAAAAAAP////gAAAAAAAAAD////4AAAAAAAAAAf///+AAAAAAAAAAH////gAAAAAAAAAA////8AAAAAAAAAAH////AAAAAAAAAAB////4AAAAAAAAAAf////AAAAAAAAAAH////4AAAAAAAAAB/////AAAAAAAAAAf////4AAAAAAAAAP/////AAAAAAAAAD/////4AAAAAAAAA//////gAAAAAAAAf/////8AAAAAAAAH//////gAAAAAAAB//////8AAAAAAAAf//////gAAAAAAAH//////8AAAAAAAB///////gAAAAAAAf//////+AAAAAAAH///////wAAAAAAB///////8AAAAAAAf///////gAAAAAAH///////8AAAAAAB////////gAAAAAAf///////8AAAAAAH////////AAAAAAB////////4AAAAAAf////////AAAAAAH////////wAAAAAB////////+AAAAAAf////////gAAAAAH////////8AAAAAA/////////AAAAAAP////////4AAAAAD////////+AAAAAA/////////gAAAAAP////////4AAAAAD/////////AAAAAA/////////wAAAAAP////////8AAAAAD/////////AAAAAB/////////wAAAAAf////////8AAAAAH/////////AAAAAB/////////wAAAAAf////////8AAAAAP////////+AAAAAD/////////gAAAAA/////////4AAAAAP////////8AAAAAAP////////AAAAAAD////////gAAAAAA+P//////4AAAAAAPD///////AAAAAADAf///////AAAAAAAH//A//+AfA8AAAAB//gAH/gAf//AAAAP/wAA/wH///2AAAD/8AAH4BPh/wAAAA/+AAA/AAAB/AAAAP/AAAD+AAAAEAAAD/wAAAA4AAAAAAAAf4AAAADwAAAAAAAH+AAAAAHAEAAAAAB/gAAAA4f/4AAAAAf8AAAAP///+AAAAD/AAAACPv//IAAAA/wAAAAAAH+AAAAAP8AAAAAAAH8AAAAB/AAAAAAAAAAAAAAfwAAAAAAAAAAAAAD+AAAAAAAAAAAAAAPgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"branta-bernicla-2":{"w":93,"h":63,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAAAAAH//AAAAAAAAAAAAB///AAAAAAAAAAA/////AAAAAAAAAB//////AAAAAAAAA//////+AAAAAAAAf//////4AAAAAAAP///////gAAAAAAH///////8AAAAAAP////////gAAAAAP////////8AAAAAf/////////gAAAP//////////8AAAH///////////AAAD///////////4AAA////////////AAAP//g////////8AAB//gH////////wAAf/4B////////+AAP/8Af////////8AH/8AD/////////4B+AAA/////////94AAAAH/////////nAAAAA/////////+4AAAAH//////////AAAAA///4P/////wAAAAP//+AP////8AAAAB///gAH////AAAAAP//wAAB///4AAAAB//8AAAH9//gAAAAf//gAAA/j/8AAAAD//8AAAA/P/gAAAAf//AAAAAB/8AAAAD//4AAAAAH/wAAAAf//AAAAAAf+AAAAD//wAAAAAB/gAAAAf/+AAAAAAH+AAAAD//wAAAAAA/wAAAAf/8AAAAAAD+AAAAD//gAAAAAAPgAAAAf/4AAAAAAA2AAAAD//AAAAAAAGwAAAAf/wAAAAAAAQAAAAH/+AAAAAAAAAAAAA//gAAAAAAAAAAAAH/4AAAAAAAAAAAAA/+AAAAAAAAAAAAAD/wAAAAAAAAAAAAAf+AAAAAAAAAAAAAD/gAAAAAAAAAAAAAf4AAAAAAAAAAAAAD+AAAAAAAAAAAAAAfwAAAAAAAAAAAAAD+AAAAAAAAAAAAAAeAAAAAAAAAAAAAADwAAAAAAAAAAAAAAyAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"branta-bernicla":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP+AAAAAAAAAAAAD/4AAAAAAAAAAAA//gAAAAAAAAAAAP/+AAAAAAAAAAAD//4AAAAAAAAAAA///AAAAAAAAAAAH//8AAAAAAAAAAB///wAAAAAAAAAAP///AAAAAAAAAAB////AAAAAAAAAAP///8AAAAAAAAAD//8HAAAAAAAAAAf/8AAAAAAAAAAAD/+AAAAAAAAAAAAf/wAAAAAAAAAAAD/8AAAAAAAAAAAAf/gAAAAAAAAAAAD/8AAAAAAAAAAAAP/wAAAAAAAAAAAB/+AAAAAAAAAAAAP/4AAAAAAAAAAAB//gAAAAAAAAAAAH/+AAAAAAAAAAAA//4AAAAAAAAAAAH//wAAAAAAAAAAA///AAAAAAAAAAAP//8AAAAAAAAA/////gAAAAAAAA/////+AAAAAAAA//////wAAAAAAA///////AAAAAAAf//////4AAAAAAP///////gAAAAAH///////8AAAAAD////////gAAAAA////////8AAAAAf////////gAAAAH////////8AAAAB/////////gAAAB/////////8AAAAf/////////gAAAP/////////8AAAD//////////gAAA//////////4AAAP//////////AAAD//////////4AAA//////////+AAAP//////////wAAD//////////8AAB///////////gAA///////////4AA///////////+AAP/////b/////gAD/////7f////4AA8M///7T////+AAAAAAH/Sf////gAAAQAAf6D///4wAAAHvwD/QP//+EAAAD/8Af6A///yAAAA/+AD/AH//9AAAAP/gAP4Af//wAAAD/4gA9AB//4AAAAf4AADwAP/+AAAAD8AAAGAA//AAAAAOAAAAMAP/4AAAAAAAAAI8D//+AAAAAAAAADAx//8AAAAAAAAAMAN//gAAAAAAAAAeAP/gAAAAAAAAADwB/4AAAAAAAAAAeAP/AAAAAAAAAABwB/4AAAAAAAAAAOAEBAAAAAAAAAAAwAAIAAAAAAAAAAHAAAAAAAAAAAAAA4AAAAAAAAAAAAAHAOAAAAAAAAAAAB//wAAAAAAAAAAAf/8AAAAAAAAAAAAf/gAAAAAAAAAAAD/8AAAAAAAAAAAAP/wAAAAAAAAAAAB//AAAAAAAAAAAAH8IAAAAAAAAAAAA/AAAAAAAAAAAAADwAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"branta-canadensis-2":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAkAAAAAAAAAAAAAAFkAAAAAAAAAAAAABpgAAAAAAAAAAAAALYAAAAAAAAAAAAAD2QAAAAAAAAAAAAA/mAAAAAAAAAAAAAH9gAAAAAAAAAAAAB/4AAAAAAAAAAAAAf+QAAAAAAAAAAAAH/8AAAAAAAAAAAAD//gAAAAAAAAAAAA//4AAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAB//+AAAAAAAAAAAAf//gAAAAAAAAAAAH//4AAAAAAAAAAAB///AAAAAAAAAAAA///wAAAAAAAAAAAP//+AAAAAAAAAAAD///gAAAAAAAAAAB///4AAAAAAAAAAAf//+AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAH///wAAAAAAAAAAA///8AAAAAAAAAAAP//+AAAAAAAAAAAB///wAAAAAAAAAAAf//4AAAAAAAAAAAD///AAAAAAAAAAAA///4AAAAAAAAAAAH///AAAAAAAAAAAB///wAAAAAAAAAAAP//+AAAAAHgAAAAD///wAAAAB/gAAAA///+AAAAAf/AAAAH///gAAAAP//wAAB///8AAAAH///wAAf///AAAAD////gAf///4AAAAAP4f/Af////AAAAAAAAP//////wAAAAAAAA//////8AAAAAAAAD//////gAAAAAAAAP/////4AAAAAAAAA/////+AAAAAAAAAH/////wAAAAAAAAAf////+AAAAAAAAAD/////gAAAAAAAAAP////8AAAAAAAAAP/////gAAAAAAAAf/////8AAAAAAAAf//////wAAAAAAAH///////AAAAAAAB///////+AAAAAAAf///////4AAAAAAP/////////wAAAAD//////////AAAAAf/////////8AAAAH//////////gAAAB//////////8AAAAf//////////gAAAH/////D////8AAAB/////AD////AAAAf////AAD///4AAAH///+AAAA//+AAAB///wAAAAD//gAAAf//+AAAAAf84AAAH///AAAAAA/BAAAB///wAAAAAD4AAAA///4AAAAAAPAAAAf//+AAAAAABoAAAf//+AAAAAAAAAAAAf/9AAAAAAAAAAAAGf/AAAAAAAAAAAAAG2AAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"branta-canadensis":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAD+AAAAAAAAAAAAB/8AAAAAAAAAAAAf/wAAAAAAAAAAAD/+AAAAAAAAAAAA//4AAAAAAAAAAAP//AAAAAAAAAAAD//8AAAAAAAAAAB///gAAAAAAAAAA///8AAAAAAAAAAf///gAAAAAAAAAH///8AAAAAAAAAAAAP/wAAAAAAAAAAAAP+AAAAAAAAAAAAA/wAAAAAAAAAAAAH+AAAAAAAAAAAAA/wAAAAAAAAAAAAH+AAAAAAAAAAAAA/wAAAAAAAAAAAAH+AAAAAAAAAAAAA/wAAAAAAAAAAAAH+AAAAAAAAAAAAA/wAAAAAAAAAAAAP+AAAAAAAAAAAAB/gAAAAAAAAAAAAP8AAAAAAAAAAAAD/gAAAAAAAAAAAA/4AAAAAAAAAAAAP/AAAAAAAAAAAAD/4AAAAAAAAAAAAf+AAAAAAAAAAAAH/wAAAAAAAAAAAB/+AAAAAAAAAAAAf/gAAAAAAAAAAAH/+AAAAAAAAAAAA//x//wAAAAAAAAP/////4AAAAAAAB//////4AAAAAAAf//////wAAAAAAD///////gAAAAAA////////AAAAAAH///////8AAAAAA////////4AAAAAH////////gAAAAA////////+AAAAAH////////8AAAAA/////////4AAAAH/////////wAAAA//////////AAAAD/////////+AAAAf/////////8AAAD//////////wAAAP//////////AAAB//////////8AAAH//////////wAAAf//////////AAAB//////////8AAAH//////////gAAAf/////////+AAAB//////////4AAAH//////////gAAAf//////////AAAB//////////+AAAD//////////4AAAP//////////gAAAf/////////wAAAA//////////AAAAB/////////+AAAAD//////4P/wAAAAD/////gA//AAAAAP////wAB/wAAAAAf///wAABwAAAAAD/w4AAAAAAAAAAAP8HAAAAAAAAAAAA/A4AAAAAAAAAAADgDAAAAAAAAAAAAcAYAAAAAAAAAAAHgDAAAAAAAAAAAAcA4AAAAAAAAAAADgHAAAAAAAAAAAAYA4AAAAAAAAAAADP/gAAAAAAAAAAA//4AAAAAAAAAAAH/+AAAAAAAAAAAA//gAAAAAAAAAAGHP4AAAAAAAAAAH984AAAAAAAAAAH//wAAAAAAAAAAAf/4AAAAAAAAAAAD/+AAAAAAAAAAAAf+AAAAAAAAAAAAH8AAAAAAAAAAAAAAAAAAAAAAAAA=="},"branta-leucopsis-2":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAyAAAAAAAAAAAAAANgAAAAAAAAAAAAAH5AAAAAAAAAAAAAB+wAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/4AAAAAAAAAAAAP/+AAAAAAAAAAAAH//wAAAAAAAAAAAD//8AAAAAAAAAAAB///AAAAAAAAAAAA///wAAAAAAAAAAAf//+AAAAAAAAAAAP///gAAAAAAAAAAD///4AAAAAAAAAAB///+AAAAAAAAAAAf///gAAAAAAAAAAP///4AAAAAAAAAAD////AAAAAAAAAAA////gAAAAAAAAAAH///4AAAAAAAAAAB///+AAAAAAAAAAAP///AAAAAAAAAAAB///wAAAAAHgAAAAf//8AAAAAD/gAAAD//+AAAAAA//AAAA///wAAAAAP//AAAP//+AAAAAD//8AAB///wAAAAB///4AAf//+AAAAAP///gAH///gAAAAAAAH/AH///8AAAAAAAAP/P////gAAAAAAAA//////8AAAAAAAAD//////AAAAAAAAAf/////4AAAAAAAAB/////+AAAAAAAAAP/////gAAAAAAAAA/////4AAAAAAAAAP/////AAAAAAAAB//////4AAAAAAAA///////gAAAAAAAP//////wAAAAAAAH//////+AAAAAAAB///////8AAAAAAAf///////wAAAAAAH////////AAAAAAB////////+AAAAAAf/////////4AAAAH//////////gAAAD//////////4AAAA/////n/////AAAAP////AH////4AAAD///oAAP////AAAA///4AAAP///wAAAf//8AAAAAf//AAAf///AAAAAB//+AAAf//gAAAAAH/HwAAO//gAAAAAAf4cAABO/AAAAAAAA/BgAADMgAAAAAAAD4AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"branta-leucopsis":{"w":83,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAD/gAAAAAAAAAAAP/wAAAAAAAAAAA//wAAAAAAAAAAD//wAAAAAAAAAAP//gAAAAAAAAAAf//gAAAAAAAAAD///AAAAAAAAAAP//+AAAAAAAAAB///+AAAAAAAAAH///8AAAAAAAAAOD//4AAAAAAAAAAAP/wAAAAAAAAAAAP/gAAAAAAAAAAAf/AAAAAAAAAAAAf+AAAAAAAAAAAA/8AAAAAAAAAAAB/4AAAAAAAAAAAD/wAAAAAAAAAAAP/gAAAAAAAAAAAf/AAAAAAAAAAAA/8AAAAAAAAAAAD/4AAAAAAAAAAAH/wAAAAAAAAAAAf/gAAAAAAAAAAA/+AAAAAAAAAAAD/8AAAAAAAAAAAP/4AAAAAAAAAAA//wAAAAAAAAAAD//gAAAAAAAAAAP//AAAAAAAAAAA///AAAAAAAAAAB////+AAAAAAAAA/////wAAAAAAAQD////4AAAAAAAAD////+AAAAAAAAA////+AAAAAAEAAB////AAAAAAIAAD////gAAAAAQAAH////gAAAAAgAAP////wAAAABAAAf////wAAAACAAAv////wAAAAEAABf////wAAAAIAAAf////8AAAAAAAAv////+AAAAQAABf////+AAAAgAAC//////AAAAgAABP/////AAAAAAAAf////+AAABAAAAr/////AAAAAAAAX/////gAAAAAAAX/////wAAAAAAAv/////4AABAAABf/////4AABAAAAf////+cAABAAAA//////IAAAgAAA//////gAAAgAAA//////gAAAgAAB/98Bg/gAAAgAAD/wAB/xAAAAAAAH/gAB/4AAAAAAAP+AAB/4AAAAIAA/4AAAf8AAAAEAB/gAAAPwAAAAAAn+AAAAAAAAAAADv8AAAAAAAAAAAP/wAAAAAAAAAAAO/AAAAAAAAAAAAY8AAAAAAAAAAAAx4AAAAAAAAAAABjwAAAAAAAAAAADHAAAAAAAAAAAAGGAAAAAAAAAAAAeMAAAAAAAAAAAA8YAAAAAAAAAAAH4wAAAAAAAAAB//jgAAAAAAAAAA//HAAAAAAAAAAB/8PAAAAAAAAAAH/w8AAAAAAAAAAAP/4AAAAAAAAAAAP/gAAAAAAAAAAB//AAAAAAAAAAAH/8AAAAAAAAAAAA/wAAAAAAAAAAAA+AAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"bucephala-clangula-2":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAA2gAAAAAAAAAAAAAG0AAAAAAAAAAAAAAegAAAAAAAAAAAAAD9AAAAAAAAAAAAAAf6AAAAAAAAAAAAAD/QAAAAAAAAAAAAA/+AAAAAAAAAAAAAH/8AAAAAAAAAAAAA//gAAAAAAAAAAAAH/4AAAAAAAAAAAAA//QAAAAAAAAAAAAH/+AAAAAAAAAAAAA//gAAAAAABAAAAAP/8AAAAAAA4AAAAB//4AAAAAA8AAAAAP/+AAAAAA/OAAAAB//wAAAAA//gAAAAP/+AAAAAf/wAAAAD//4AAAAf//gAAAAf//AAAAP//4AAAAD//4AAAH//8AAAAA//+AAAD///wAAAAH//4AAA///+AAAAA///AAAf///AAAAAH//4AAP///gAAAAA//+AAP///+AAAAAH//wAD////gAAAAA//+AB////wAAAAAH//wAf///8AAAAAA//+AP////gAAAAAP//4D////4AAAAAB///g////8AAAAAAP//+P////AAAAAAA///z////wAAAAAAH///////8AAAAAAAf//////+AAAAAAAB///////AAAAAAAAH//////wAAAAAAAAf/////4AAAAAAAAB/////8AAAAAAAAAH/////gAAAAAH+AA/////4AAAAAD//AH/////gAAAAA//+A/////8AAAAAP//wH/////gAAAAD//+A/////8AAAAAf//wf/////gAAAAD/////////4AAAAA//////////AAAAAP/////////4AAAAH//////////AAAAD//////////wAAAA+D////////+AAAAAAAAf//////gAAAAAAAB//////8AAAAAAAAH//////gAAAAAAAA//////8AAAAAAAAD//////4AAAAAAAAf//////gAAAAAAAB///////AAAAAAAAH//////8AAAAAAAAP//////wAAAAAAAAf//////AAAAAAAAA//////8AAAAAAAAA//////wAAAAAAAAD//////AAAAAAAAAH//////AAAAAAAAAf//////gAAAAAAAA//////+AAAAAAAAA//////8AAAAAAAAB//////AAAAAAAAAB/////8AAAAAAAAAAf////AAAAAAAAAAAH/8/4AAAAAAAAAAA//z+AAAAAAAAAAAB//xgAAAAAAAAAAAB//AAAAAAAAAAAAAAj+AAAAAAAAAAAAAAAAAA"},"bucephala-clangula":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAP/AAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAf//wAAAAAAAAAAAD///AAAAAAAAAAAA///8AAAAAAAAAAAH///gAAAAAAAAAAB///+AAAAAAAAAAAP///4AAAAAAAAAAD////AAAAAAAAAAA////8AAAAAAAAAAf////gAAAAAAAAAP////8AAAAAAAAAP/////wAAAAAAAAD/////+AAAAAAAAA//////wAAAAAAAAAAA///+AAAAAAAAAAAB///wAAAAAAAAAAAB//+AAAAAAAAAAAAf//wAAAAAAAAAAAH//8AAAAAAAAAAAH//7AAAAAAAAAAAD//+AAAAAAAAAAAB///gAAAAAAAAAAAf//8AAAAAAAAAAAH/////gAAAAAAAAB//////wAAAAAAAAP//////gAAAAAAAD///////gAAAAAAAf///////AAAAAAAH///////8AAAAAAA////////4AAAAAAH////////wAAAAAA/////////AAAAAAH////////8AAAAAA/////////wAAAAAH/////////gAAAAA/////////+AAAAAH/////////4AAAAA//////////gAAAAH/////////+AAAAAf/////////4AAAAD//////////gAAAAP//////////AAAAB//////////4AAAAH//////////gAAAAf/////////+AAAAB//////////4AAAAH//////////gAAAAf/////////8AAAAA//////////wAAAAD/////////+AAAAAH/////////4AAAAAf/////////gAAAAB/////////+AAAAAH/////////4AAAAAf/////////gAAAAB/////////+AAAAAD/////////4AAAAAP/////////gAAAAAf////////8AAAAAB////////+wAAAAAD////////4AAAAAAH////////gAAAAAAP///////+AAAAAAAf///////4AAAAAAA////////AAAAAAAD///////8AAAAAAA////////wAAAAAAD////////AAAAAAAf///////8AAAAAAD////Af//gAAAAAAf8AAAB//+AAAAAAB/wAAAH//wAAAAAAH+AAAAf/+AAAAAAAf4AAAAf/wAAAAAAB/4AAAAv+AAAAAAAP/gAAAAAAAAAAAAB/wAAAAAAAAAAAAAH8AAAAAAAAAAAAAAPAAAAAAAAAAAAAAA4AAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAA="},"buteo-buteo-2":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAAAAAAAAAAAAAAMQAAAAAAAAAAAAABmAAAAAAAAAAAAAAZwAIAAAAAAAAAAAncYFAAAAAAAAAAAE3GAoAAAAAAAAAABt5gDgAAAAAAAAAAb+cAcAAAAAAAAAAD/vELgAAAAAAAAAA//zAugAAAAAAAAAP/94D8AAAAAAAAAD//+AfwAAAAAAAAA///gB+AAAAAAAAAP//wAX4AAAAAAAAD//+wB/gAAAAAAAA///8AH+AAAAAAAAP///gAf8AAAAAAAP///4AD/wAAAAAAD///+AAf/wAAAAAA////4AB//AAAAAAP///+AAH/8AAAAAD////gAAf/4AAAAA////4AAD//gAAAAP////gAAf//AAAAB////8AAB//8AAAAf////AAAH//4AAAH////wAAA///gAAA////8AAAD//+AAAP////AAAAP//8AAD////wAAAA///wAAf///8AAAAD///AAH////AAAAAP//8AB////4AAAAAf//wAf////AAAAAD///AH////4AAAAAf///B/////AAAAAB/////////wAAAAAH////////8AAAAAA/////////wAAAAAD////////8AAAAAAP///////+AAAAAAA////////wAAAAAAD///////8AAAAAAAf///////gAAAAAAB///////4AAAAAAAH//////+AAAAAAAAf//////gAAAAAAAA//////4AAAAAAAAD/////+AAAAAAAAAH/////AAAAAAAAAAP////AAAAAAAAAAAf///AAAAAAAAAAAAf//8AAAAAAAAAAAB///4AAAAAAAAAAAP///wAAAAAAAAAAA////AAAAAAAAAAAH///+AAAAAAAAAAAf///8AAAAAAAAAAB////8AAAAAAAAAAH////4AAAAAAAAAAf////gAAAAAAAAAD////8AAAAAAAAAAf////gAAAAAAAAAH////wAAAAAAAAAA/////AAAAAAAAAAH////wAAAAAAAAAA////4AAAAAAAAAAD////AAAAAAAAAAAD///wAAAAAAAAAAAN//4AAAAAAAAAAAAH/2AAAAAAAAAAAAABMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"buteo-buteo":{"w":77,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAA/+AAAAAAAAAAH/+AAAAAAAAAA///AAAAAAAAAB///AAAAAAAAAH///AAAAAAAAAf///AAAAAAAAB///+AAAAAAAAD///+AAAAAAAAH///+AAAAAAAAA///8AAAAAAAAA///+AAAAAAAAA////AAAAAAAAB////AAAAAAAAD////AAAAAAAAH////gAAAAAAAP////4AAAAAAA/////8AAAAAAB/////+AAAAAAD//////AAAAAAH//////AAAAAAP//////AAAAAA///////AAAAAA///////AAAAAB///////AAAAAD///////AAAAAH///////AAAAAP///////AAAAAP//////+AAAAAf//////+AAAAAf//////+AAAAA///////8AAAAB///////8AAAAD///////8AAAAH///////8AAAAH///////4AAAAP///////4AAAAP///////wAAAAf///////gAAAAf///////AAAAA////////AAAAA////////AAAAA///////+AAAAA///////+AAAAA///////8AAAAA///////4AAAAA///////4AAAAA///////wAAAAA///////gAAAAAf//////AAAAAAf//////AAAAAAf/////8AAAAAAf/////4AAAAAA//////4AAAAAA//////4AAAAAB//////wAAAAAB//////wAAAAAD//////gAAAAAD//////gAAAAAH//////gAAAAAP//P///AAAAAAf/8f///AAAAAB/z4f///AAAAAP/hAP//+AAAAD//AAP/9+AAAAP/+AAP/5+AAAAf//gAH/58AAAB///gAH/w8AAAD///AAP/g8AAAD/f+AAP/g4AAAB8/8AAf/AwAAAAh/gAAf/AwAAAAD+AAA/+BgAAAABwAAA/8AAAAAAAAAAB/8AAAAAAAAAAB/4AAAAAAAAAAD/4AAAAAAAAAAD/wAAAAAAAAAAH/gAAAAAAAAAAH/gAAAAAAAAAAH/AAAAAAAAAAAP/AAAAAAAAAAAP+AAAAAAAAAAAP8AAAAAAAAAAAf8AAAAAAAAAAAf4AAAAAAAAAAAfwAAAAAAAAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"buteo-lagopus-2":{"w":80,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAhgAAAAAAAAAAAZxgAAAAAAAAAAd5wAAAAAAAAAA/94AAAAAAAAAA//8AAAAAAAAAA//+YAAAAAAAAA///8AAAAAAAAA///+AAAAAAAAA///+AAAAAAAAA////4AAAAAAAA////8AAAAAAAB////+AAAAAAAA////+AAAAAAAA/////AAAAAAAAf////wAAAAAAAP////4AAAAAAAH////8AAAAAAAD////+AAAAAAAB/////AAAAAAAAf////gAAAAAAAH////wAAAAAAAB////4AAAAAAAA////4AAAAAAAAP///8AAAAAAAAD///8AAAAAAAAB///+AAAAAAAAAf///AAAAAAAAAP///wAAAAAAAAD///4AAAAAAAAB///+AAAAAAAAA////AAAAAAAAf////wAAAAAAP/////4AAAAAAP/////+AAAAAAH//////AAAAAAD//////wAAAAAB//////4AAAAAAf/////+AAAAAAGP/////AAAAAAAA/////gAAAAAAAD////wAAAAAAAAf///4AAAAAAAAH///+AAAAAAAAD////gAAAAAAAB////+AAAAAAAA/////8AAAAAAA//////wAAAAAAf//////gAAAAAf///////AAAAAf///////+AAAAH////////4AAAD////////+AAAA/////////gAAAf////f///4AAAH////g///8AAAD////4P///AAAA////8B///wAAAf////Af//4AAAH////AD//+AAAB////gA///AAAAf///wAH//gAAAH///wAB//wAAAD///8AAP/4AAAA///8AAD/4AAAAP//8AAAf+AAAAH//+AAAD8AAAAB///AAAAAAAAAAf//gAAAAAAAAAP//wAAAAAAAAAD//8AAAAAAAAAA///AAAAAAAAAAf//gAAAAAAAAAH//wAAAAAAAAAD//8AAAAAAAAAA//+AAAAAAAAAAP//AAAAAAAAAAH//wAAAAAAAAAB//4AAAAAAAAAA//8AAAAAAAAAAb/+AAAAAAAAAAB//AAAAAAAAAAAf/gAAAAAAAAAAP/gAAAAAAAAAAD/4AAAAAAAAAABvsAAAAAAAAAAAHbAAAAAAAAAAABsgAAAAAAAAAAATYAAAAAAAAAAAJgAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA"},"buteo-lagopus":{"w":75,"h":93,"bits":"AAAAAAAAAAAAAB/wAAAAAAAAAA//wAAAAAAAAAf//AAAAAAAAAH//+AAAAAAAAA///4AAAAAAAAP///gAAAAAAAD///+AAAAAAAAf///4AAAAAAAH////gAAAAAAA/////AAAAAAACf///8AAAAAAAD////4AAAAAAAP////gAAAAAAB/////gAAAAAAP/////gAAAAAB//////AAAAAAP/////8AAAAAB//////4AAAAAf//////gAAAAD//////+AAAAAf//////4AAAAD///////gAAAAf//////+AAAAD///////4AAAAf///////AAAAD///////8AAAAf///////wAAAB///////+AAAAP///////4AAAA////////gAAAH///////8AAAAf///////wAAAD///////+AAAAP///////4AAAB////////gAAAP///////8AAAA////////gAAAH///////+AAAAf///////wAAAB////////AAAAP///////8AAAA////////gAAAD///////8AAAAP///////wAAAA///////+AAAAD///////wAAAAP///////AAAAA///////4AAAAD///////AAAAAH//////4AAAAAf//////AAAAAB//////4AAAAAP//////AAAAAB//////8AAAAAH//////wAAAAA//////+AAAAAD//////4AAAAAf//////gAAAAB//////8AAAAAP//////wAAAAB///////AAAAAH/////v4AAAAA/////8fgAAAAH/////x+AAAAB/////+HwAAAAP/////wfAAAAD//////B8AAAB//////4HgAAA////v//AeAAAP///o//8BwAAD///8H//gGAAA////g//+AQAAH///8H//wAAAA////wf/+AAAAD///8D//4AAAAH5//gP//AAAAAeB/gB//8AAAABgP4AP//gAAAAAA8AA//8AAAAAADAAH//wAAAAAAAAA//+AAAAAAAAAD//4AAAAAAAAAf//AAAAAAAAAB//8AAAAAAAAAP//gAAAAAAAAB//8AAAAAAAAAH//wAAAAAAAAAf/+AAAAAAAAAD//wAAAAAAAAAP/+AAAAAAAAAAf/wAAAAAAAAAAQAA="},"calidris-alba-2":{"w":79,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAGAAAAAAAAAAAAHAAAAAAAAAAAAHgAAAAAAAAAAAHgAAAAAAAAAAAHwAAAAAAAAAAAH4AAAAAAAAAAAH4AAAAAAAAAAAH8AAAAAAAAAAAH+AAAAMAAAAAAH/AAAB8AAAAAAH/AAAD8AAAAAAD/gAAP+AAAAAAD/wAAf+AAAAAAD/wAB/8AAAAAAD/4AD/+AAAAAAB/8AH/+AAAAAAB/8AP/8AAAAAAB/+Af/8AAAAAAB/+A//+AAAAAAA//B//+AAAAAAA//D//8AAAAAAA//n//+AAAAAAA//n//+AAAAAAAf////+AAAAAAAf////+AAAAAAAf////+AAAAAAAP////+AAAAAAAP////8AAAAAAAH////8AAAAAAAH////8AAAAAAAD////8AAAAAAAB////8AAAAAAAA////4AAAAAAAAf///8AAAAAAAAP///4AAAAAAAAH///8AAAAAABgB///+AAAAAAH/A////AAAAAAH/wf///gAAAAAH/8P///wAAAAAD//H///4AAAAAD//3///8AAAAAB//////+AAAAAD///////AAAAAH///////gAAAAP///////wAAAAeD//////4AAAAIA//////8AAAAAAP/////8AAAAAAH/////+AAAAAAD//////AAAAAAB//////gAAAAAA//////wAAAAAAP/////4AAAAAAH/////+AAAAAAD//////gAAAAAB//////wAAAAAAf/////8AAAAAAP//////gAAAAAH//////4AAAAAB//////+AAAAAAf//////wAAAAAH//////8AAAAAB///////gAAAAAf//////4AAAAAD///////AAAAAA///////8AAAAAH///////AAAAAA////4Af4AAAAAD///gAB4AAAAAAf//AAAAAAAAAAH/wAAAAAAAAAAB/AAAAAAAAAAAAfAAAAAAAAAAAAZgAAAAAAAAAAAMwAAAAAAAAAAAEYAAAAAAAAAAAGMAAAAAAAAAAACEAAAAAAAAAAADiAAAAAAAAAAB/hAAAAAAAAAAAPggAAAAAAAAAD4gwAAAAAAAAAABgYAAAAAAAAAADAOAAAAAAAAAAAD8AAAAAAAAAAAB2AAAAAAAAAAAOEAAAAAAAAAAAAEAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAA=="},"calidris-alba":{"w":93,"h":81,"bits":"AAAfAAAAAAAAAAAAAAP/AAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAf//gAAAAAAAAAAAD//8AAAAAAAAAAAA///wAAAAAAAAAAAH///AAAAAAAAAAAA///4AAAAAAAAAAAP///gAAAAAAAAAAD///8AAAAAAAAAAB////wAAAAAAAAAA/////AAAAAAAAAAf////+AAAAAAAAAHwf///+AAAAAAAADwB////+AAAAAAAAQAP////+AAAAAAAAAB/////8AAAAAAAAAP/////8AAAAAAAAB//////4AAAAAAAAf//////gAAAAAAAD///////AAAAAAAAf//////+AAAAAAAD///////4AAAAAAA////////wAAAAAAH////////AAAAAAA////////8AAAAAAH////////wAAAAAA/////////AAAAAAD////////+AAAAAAf////////4AAAAAD/////////wAAAAAf/////////AAAAAB/////////+AAAAAP/////////4AAAAB//////////wAAAAH//////////gAAAA///////////gAAAD///////////AAAAP///////////gAAA///////////3AAAH///////////AAAAf//////////4AAAB///////////gAAAH///////////gAAAP//////////+AAAA/////////gfgAAAD////////AAAAAAAH//////8wAAAAAAAP/////8AAAAAAAAAf////+AAAAAAAAAA/////AAAAAAAAAAB////wAAAAAAAAAAB///4AAAAAAAAAAAH//4AAAAAAAAAAAAf/AAAAAAAAAAAAAB/wAAAAAAAAAAAAAH8AAAAAAAAAAAAAAzAAAAAAAAAAAAAAGYAAAAAAAAAAAAAAjgAAAAAAAAAAAAAEYAAAAAAAAAAAAAAhAAAAAAAAAAAAAAEIAAAAAAAAAAAAABhAAAAAAAAAAAAAAMYAAAAAAAAAAAAABDAAAAAAAAAAAAAAIYAAAAAAAAAAAAABDAAAAAAAAAAAAAYcYAAAAAAAAAAAAA/TAAAAAAAAAAAAH/wYAAAAAAAAAAAAAGDgAAAAAAAAAAAADP8AAAAAAAAAAAAAA+AAAAAAAAAAAAAP8gAAAAAAAAAAAAAAMAAAAAAAAAAAAAADAAAAAAAAAAAAAABgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAA"},"calidris-alpina-2":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAABgAAAAAAAAAAAAAPAAAAAAAAAAAAAB4AAAAAAAAAAAAAPgAAAAAAAAAAAAB8AAAAAAAAAAAAAP4AAAAAAAAAAAAB/AAAAAAAAAAAAAP8AAAAAAAAAAAAB/gAAAAAAAAAAAAH+AAAAAAAAAAAAA/4AAAAAAAAAAAAH/gAAAAAgAAAAAA/+AAAAA+AAAAAAH/wAAAAfgAAAAAAf/AAAAP/AAAAAAD/8AAAD/4AAAAAAf/wAAB//AAAAAAB//AAAf/4AAAAAAP/4AAH//AAAAAAB//gAB//4AAAAAAH/8AAf/+AAAAAAA//wAH//4AAAAAAH//AB///AAAAAAAf/8AP//4AAAAAAD//gH///AAAAAAAP/+B///4AAAAAAB//4P///AAAAAAAH//D///4AAAAAAA//4f///AAAAAAAD//n///4AAAAAAAf/+////gAAAAAAB//////4AAAAAAAP//////AAAAAAAA//////4AAAAAAAD//////AAAAAAAAf/////wAAAAAAAB/////+AAAAAAAAH/////wAAAAAAAAP////8AAAAAAAAAf////wAAAAAAAAB/////AAAAAAAAAD////8AAAAAAAAAP////wAAAAAAA8A/////AAAAAAAf+D////8AAAAAAD/+P////gAAAAAAf/8////+AAAAAAB///////4AAAAAAP///////gAAAAAA///////+AAAAAAP///////4AAAAAB////////AAAAAAf///////8AAAAAHw///////wAAAAB8A///////AAAAAOAB//////8AAAABgAD//////wAAAAAAAP//////gAAAAAAAf/////+AAAAAAAB//////4AAAAAAAH//////4AAAAAAAP//////wAAAAAAA///////gAAAAAAB///////AAAAAAAD//////+AAAAAAAH//////+AAAAAAAP//////+AAAAAAAf//////8AAAAAAAf//////8AAAAAAA///////+AAAAAAA////////AAAAAAA////////gAAAAAA///////+AAAAAAAf//////wAAAAAAAD//+AAHAAAAAAAAAP/4AAAAAAAAAAAAANgAAAAAAAAAAAAATAAAAAAAAAAAAABmAAAAAAAAAAAAACIAAAAAAAAAAAAAIwAAAAAAAAAAAAAxAAAAAAAAAAAAABCAAAAAAAAAAAAAHPgAAAAAAAAAAAAP4AAAAAAAAAAAAA48AAAAAAAAAAAAB58AAAAAAAAAAAAB44AAAAAAAAAAAABw4AAAAAAAAAAAABwAAAAAAAAAAAAAAgAA"},"calidris-alpina":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAB/gAAAAAAAAAAAAA//AAAAAAAAAAAAAP/8AAAAAAAAAAAAD//wAAAAAAAAAAAAf//AAAAAAAAAAAAH//8AAAAAAAAAAAA///gAAAAAAAAAAAH//+AAAAAAAAAAAB///wAAAAAAAAAAAf///AAAAAAAAAAAH////4AAAAAAAAAD//////AAAAAAAAB///////AAAAAAAAfB//////AAAAAAAPAH/////+AAAAAAHgAf/////8AAAAABwAD//////4AAAAAYAA///////wAAAAAAAH///////AAAAAAAA///////+AAAAAAAH///////4AAAAAAA////////wAAAAAAH////////gAAAAAA/////////AAAAAAH/////////AAAAAA/////////+AAAAAD/////////8AAAAAf/////////4AAAAD//////////8AAAAP//////////+AAAB//////////+AAAAH//////////4AAAA//////////+AAAAD//////////wAAAAP//////////wAAAA///////////gAAAD//////////+AAAAP////////h/wAAAAf//////8AAAAAAAB//////8AAAAAAAAD//////AAAAAAAAAP/////gAAAAAAAAAP////wAAAAAAAAAAP///4AAAAAAAAAAAP//4AAAAAAAAAAAAP/wAAAAAAAAAAAAAP4AAAAAAAAAAAAAA+AAAAAAAAAAAAAAHwAAAAAAAAAAAAABuAAAAAAAAAAAAAAMwAAAAAAAAAAAAABGAAAAAAAAAAAAAAIgAAAAAAAAAAAAADEAAAAAAAAAAAAAAQgAAAAAAAAAAAAACMAAAAAAAAAAAADA5gAAAAAAAAAAAAD+sAAAAAAAAAAAAAfhgAAAAAAAAAAAP8YMAAAAAAAAAAACgGBgAAAAAAAAAAAAHAMAAAAAAAAAAAABgB4AAAAAAAAAAAAAAcAAAAAAAAAAAAAA/AAAAAAAAAAAAAAHYAAAAAAAAAAAAAPiAAAAAAAAAAAAA/AwAAAAAAAAAAAAAAMAAAAAAAAAAAAAADAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAA"},"calidris-pugnax-2":{"w":93,"h":92,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAB4AAAAAAAAAAAAAB/AAAAAAAAAAAAAA/4AAAAAAAAAAAAAf8BgAAAAAAAAAAAP/wHAAAAAAAAAAAH/8AcAAAAAAAAAAD//AD8AAAAAAAAAA//4APwAAAAAAAAAf/+AA/gAAAAAAAAP//gAD/AAAAAAAAD//4AAP8AAAAAAAB///AAA/wAAAAAAA///wAAH/gAAAAAAP//8AAAf/AAAAAAD///AAAB/8AAAAAA///4AAAD/4AAAAAf//+AAAAP/gAAAAH///gAAAA//AAAAD///4AAAAD/8AAAA////AAAAAP/wAAAP///wAAAAA//gAAD///8AAAAAD//AAAf///AAAAAAP/+AAH///wAAAAAA///gA///4AAAAAAD///AH//+AAAAAAAH//+A///gAAAAAAAP//wP//8AAAAAAAA///B///gAAAAAAAD//8P//8AAAAAAAAP//h///gAAAAAAAD//+f//8AAAAAAAAf//z///gAAAAAAAH//////8AAAAAAAD///////gAAAAAAA///////8AAAAAAAP///////AAAAAAAB///////4AAAAAAAP///////AAAAAAAD///////4AAAAAAB////////AAAAAAAD///////wAAAAAAAf//////+AAAAAAAB///////gAAAAAAAP//////8AAAAAAAB///////wAAAAAAAH//////+AAAAAAAA///////wAAAAAAAD//////+AAAAAAAAP//////4AAAAAAAAL/////8AAAAAAAAAA/////wAAAAAAAAAD/////AAAAAAAAAAP////8AAAAAAAAAA/////wAAAAAAAAAD/////AAAAAAAAAAH////+AAAAAAAAAAP////+AAAAAAAAAAf////+AAAAAAAAAA/////8AAAAAAAAAB////8AAAAAAAAAAH//f/gAAAAAAAAAAP/A/+AAAAAAAAAAAPMD/gAAAAAAAAAAAYwH8AAAAAAAAAAABjANgAAAAAAAAAAAOYAAAAAAAAAAAAAAzAAAAAAAAAAAAAAGIAAAAAAAAAAAAAAxAAAAAAAAAAAAAAEIAAAAAAAAAAAAAAhAAAAAAAAAAAAAAEIAAAAAAAAAAAAAAhgAAAAAAAAAAAAAEMAAAAAAAAAAAAAAhgAAAAAAAAAAAAAGMAAAAAAAAAAAAAA98AAAAAAAAAAAAAGOAAAAAAAAAAAAAA44AAAAAAAAAAAAADjgAAAAAAAAAAAAAKOAAAAAAAAAAAAABo4AAAAAAAAAAAAAHDAAAAAAAAAAAAAAYMAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"calidris-pugnax":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAA/4AAAAAAAAAAAAf/wAAAAAAAAAAAD//AAAAAAAAAAAA//4AAAAAAAAAAAH//gAAAAAAAAAAB//8AAAAAAAAAAAP//wAAAAAAAAAAD//+AAAAAAAAAAB///4AAAAAAAAAAf///wAAAAAAAAAP////AAAAAAAAAD5///8AAAAAAAAB4P///gAAAAAAAA8D///+AAAAAAAAOB////wAAAAAAAHAf///+AAAAAAABgH////wAAAAAAAAA////+AAAAAAAAAP/////AAAAAAAAD//////AAAAAAAAf/////+AAAAAAAB//////8AAAAAAAf//////4AAAAAAD///////wAAAAAAf///////AAAAAAD///////+AAAAAAf///////4AAAAAD////////gAAAAAf////////AAAAAD////////8AAAAAP////////gAAAAB////////+AAAAAH////////4AAAAAP////////gAAAAAP///////+AAAAAA////////4AAAAAH////////gAAAAAf///////+AAAAAB////////4AAAAAH////////gAAAAAf///////+AAAAAB////////4AAAAAD////////gAAAAAP///////+AAAAAA////////4AAAAAB////////wAAAAAH////////gAAAAAf//////+/AAAAAA///////44AAAAAB///////wAAAAAAB///////wAAAAAAH///////AAAAAAAP//////8AAAAAAA//////wAAAAAAAD//+D/+AAAAAAAAfz+AD/4AAAAAAAB+HAAH/AAAAAAAAHwYAAf4AAAAAAAAcBgAA/AAAAAAAABgOAABgAAAAAAAAO/4AAAAAAAAAAD//+AAAAAAAAAAAeHAAAAAAAAAAAAHw4AAAAAAAAAAAB6HAAAAAAAAAAAAOYwAAAAAAAAAAABwGAAAAAAAAAAAAOAwAAAAAAAAAAABYGAAAAAAAAAAAANgwAAAAAAAAAAABgGAAAAAAAAAAAACAwAAAAAAAAAAAAAGAAAAAAAAAAAAAAwAAAAAAAAAAAAAEAAAAAAAAAAAAAAgAAAAAAAAAAAAAMAAAAAAAAAAAAABgAAAAAAAAAAAAOOAAAAAAAAAAAAAf4AAAAAAAAAAAAB8gAAAAAAAAAAAH7AAAAAAAAAAAAHwQAAAAAAAAAAAAAGAAAAAAAAAAAAABgAAAAAAAAAAAAAYAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"carduelis-carduelis-2":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAADAAAAAAAAAAAAAABxAAAAAAAAAAAAAAcYAAAAAAAAAAAAAPOAAAAAAAAAAAAAD3gAAAAAAAAAAAAB/5gAAAAAAAAAAAA/+4AAAAAAAAAAAAP/+AAAAAAAAAAAAH//gAAAAAAAAAAAD//zAAAAAAAAAAAA///wAAAAAAAAAAAP//8AAAAAAAAAAAH///ACAAAAAAAAAB///wAYAAAAAAAAA////gJgAAAAfwAAf///4A3AAAAH/gAH///+ADeAAAB/+AD////gAP8AAAf/4A////4AA/4AAH//gP////gAb/4AB//+D////4AB//4Af//w////8AAH//8A///P////gAAP//8B///////8AAAf///P///////AAAf///////////gAAA///////////8AAAA//////////+AAAAf//////////gAAAB//////////4AAAAD//////////AAAAAP/////////4AAAAB//////////AAAAAD/////////wAAAAAP////////+AAAAAA/////////wAAAAAB////////8AAAAAAB////////AAAAAAAH///////4AAAAAAAP//////8AAAAAAAA///////gAAAAAAAB//////4AAAAAAAAH/////oAAAAAAAAAP////8AAAAAAAAAA/////wAAAAAAAAAB////+AAAAAAAAAAA////4AAAAAAAAAAAP///AAAAAAAAAAAA///8AAAAAAAAAAAD///gAAAAAAAAAAA///+AAAAAAAAAAAP9//wAAAAAAAAAABp///AAAAAAAAAAAMuz/8AAAAAAAAAABmyH/wAAAAAAAAAAGWQP/AAAAAAAAAAAwQA/8AAAAAAAAAADAAH/wAAAAAAAAAAAAAf/AAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAB//AAAAAAAAAAAAAH/8AAAAAAAAAAAAA//4AAAAAAAAAAAAD//gAAAAAAAAAAAAfh+AAAAAAAAAAAAB8AAAAAAAAAAAAAAPgAAAAAAAAAAAAAA8AAAAAAAAAAAAAAHAAAAAAAAAAAAAAA4AAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"carduelis-carduelis":{"w":83,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAB/4AAAAAAAAAAAP/8AAAAAAAAAAA//+AAAAAAAAAAD//+AAAAAAAAAAP//+AAAAAAAAAAf//+AAAAAAAAAB///+AAAAAAAAAH///+AAAAAAAAA////8AAAAAAAAD////8AAAAAAAAP////4AAAAAAAAf////4AAAAAAAAD////wAAAAAAAAB////wAAAAAAAAD////gAAAAAAAAH////AAAAAAAAAP////AAAAAAAAAf////AAAAAAAAA/////AAAAAAAAB/////AAAAAAAAD/////AAAAAAAAH/////AAAAAAAAf/////AAAAAAAA//////AAAAAAAB/////+AAAAAAAD/////+AAAAAAAH/////+AAAAAAAP/////+AAAAAAAf/////8AAAAAAA//////8AAAAAAB//////8AAAAAAD//////4AAAAAAH//////4AAAAAAP//////wAAAAAAf//////wAAAAAAf//////gAAAAAA///////gAAAAAB///////AAAAAAB///////AAAAAAD///////AAAAAAH//////+AAAAAAH//////+AAAAAAP//////+AAAAAAP//////8AAAAAAf//////8AAAAAAf//////4AAAAAAf//////4AAAAAAf//////4AAAAAA///////wAAAAAA///////wAAAAAA///////gAAAAAA///////gAAAAAA///////AAAAAAA//////+AAAAAAA//////+AAAAAAAf/////8AAAAAAAf/////4AAAAAAAf/////4AAAAAAAP/////4AAAAAAAH/////4AAAAAAAH/////4AAAAAAAH/////4AAAAAAA//////4AAAAAAPn/////4AAAAAB+HwA///4AAAAADjfAA///4AAAAAMH0AAf/74AAAAAQ/AAAP/54AAAAAPiAAAH/wwAAAAB8IAAAD/wAAAAAH8AAAAB/wAAAAA+PAAAAB/wAAAAB4HAAAAB/wAAAADgGAAAAB/wAAAAHAIAAAAB/wAAAAOBgAAAAD/wAAAAPAAAAAAD/wAAAAfgAAAAAD/wAAAAwAAAAAAD/gAAAAwAAAAAAD/gAAAA4AAAAAAD/gAAAAAAAAAAAH/gAAAAAAAAAAAH/gAAAAAAAAAAAH/AAAAAAAAAAAAHzAAAAAAAAAAAAHgAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"certhia-familiaris-2":{"w":93,"h":75,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAABjCAAAAAAAAAAAAAZxwAAAAAAAAAAAAPc8AAAAAAAAAAAAD//AAAAAAAAAAAAB//3AAAAAAAAAAAAf//wAAAAAAAAAAAP//4AAAAA+AAAAAD///YAAAAB9/AAAB///+AAAAAD/+AAB////AAAAAAP/8AAf///wAAAAAA//wAH////gAAAAAH//AD////4AAAAAAf/8B////8AAAAAAD//w/////AAAAAAAP//P////4AAAAAAB///////+AAAAAAAP//////+AAAAAAABz//////wAAAAAAAMH/////8AAAAAAAAAf////+AAAAAAAAAA/////AAAAAAAAAAD////wAAAAAAAAAAP///+AAAAAAAAHAA////gAAAAAAAH4AD///8AAAAAAAB/gAP///gAAAAAAA/8AA///4AAAAAAAf/gAD///AAAAAAAP/+AAf//wAAAAAAD//wAB//8AAAAAAA///AAP//gAAAAAAf//4AA//4AAAAAAP///gAH/+AAAAAAH///+AA//gAAAAAD////wBD/wAAAAAD/////Ae/wAAAAAD/////8D//AAAAAA//////wf/4AAAAAB//////h//AAAAAA///////P/4AAAAA///////5//gAAAAHf////////8AAAAAH///7/9///gAAAAB5//6AkHz/8AAAAAYe9/AAAeH/gAAAAAPPcgAAAAP+AAAAABDjAAAAAA/wAAAAAAQwAAAAAH+AAAAAAAAAAAAAA/4AAAAAAAAAAAAAD/AAAAAAAAAAAAAAf8AAAAAAAAAAAAAB/gAAAAAAAAAAAAAP+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAH/AAAAAAAAAAAAAA/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAAf8AAAAAAAAAAAAAD/wAAAAAAAAAAAAAf+AAAAAAAAAAAAAB/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAA/8AAAAAAAAAAAAAH/gAAAAAAAAAAAAA+8AAAAAAAAAAAAADhgAAAAAAAAAAAAAcAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"certhia-familiaris":{"w":49,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAgAAAAAAAMAAAAAAADgAAAAAAA4AAAAAAAOAAAAAAADwAAAAAAB/gAAAAAAf8AAAAAAP/gAAAAAH/4AAAAAH/+AAAAAD//gAAAAD//wAAAAB//8AAAAA//+AAAAA///gAAAAf//wAAAAf//4AAAAf//8AAAAP///AAAAP///gAAAH///wAAAD///4AAAD///+AAAB////AAAA////gAAAf///4AAAP///8AAAH////AAAD////gAAB////wAAA////4AAAf///8AAAP////AAYD////gAGB////wB5g////4AD4f///8AAfH///+AD/z////ACAc////wAALf///4AAC////8AABH///+AAAR////AAAM////gAAGf///4AABP///8AAAj///+AAAA///+AAAAD///AAAAA///gAAAAP//wAAAAB//4AAAAAf/8AAAAAP/+AAAAAB//gAAAAA//wAAAAAP/4AAAAAD/8AAAAAB/+AAAAAAf/AAAAAAP+gAAAAAD/AAAAAAA/gAAAAAAfwAAAAAAP4AAAAAAD+AAAAAAB/AAAAAAA/gAAAAAAfwAAAAAAP4AAAAAAH+AAAAAAD/AAAAAAA/gAAAAAAfwAAAAAAP4AAAAAAH8AAAAAAD/AAAAAAB/gAAAAAAfwAAAAAAP4AAAAAAH8AAAAAAD+AAAAAAA/gAAAAAAcwAAAAAAOIAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAA"},"cettia-cetti-2":{"w":93,"h":89,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAjEAAAAAAAAAAAAAMxgAAAAAAAAAAAADO4AAAAAAAAAAAAA7uAAAAAAAAAAAAAP/yAAAAAAAAAAAAD/9gAAAAAAAAAAAA//8AAAAAAAAAAAAH//AAAAAAAAAAAAB//wAAAAAAAAAAAAf//gAAAAAAAAAAAH//4AAAAAAAAAAAB///AAAAAAAAAAAAf//wAAAAAAAAAAAD///AAAAAAAAAAAA///wAAAAAAAAAAAP//+AAAAAAAAAAAD///gAAAAAAAAAAA///4AAAAAAAAAAAP///gAAAAAAAAAAD///4AAAAAAAAAAAf//+AAAAAAAAAAAH///gAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAH///wAAAAAAAA4AB///8AAAAAAAB/8AP///gAAAAAAAf/4D///4AAAAAAAP//gf//+AAAAAAAH///H///wAAAAAAf////////AAAAAAD////////4AAAAAAA////////AAAAAAAB///////8AAAAAAAH///////AAAAAAAAf//////8AAAAAAAB///////gAAAAAAAP//////8AAAAAAAA///////gAAAAAAAD//////8AAAAAAAAP//////gAAAAAAAB//////4AAAAAAAAH//////AAAAAAAAA//////4AAAAAAAAP/////+AAAAAAAAP//////wAAAAAAAD//////8AAAAAAAA///////AAAAAAAAP//////gAAAAAAAD//////+AAAAAAAA///////4AAAAAAAP///////gAAAAAAD///////8AAAAAAA////////wAAAAAAH///////+AAAAAAB////////4AAAAAAf////////AAAAAAH////////8AAAAAB/////////gAAAAAf/////v//+AAAAAH/////4N//4AAAAB/////8DMP/gAAAAP////8B+A/+AAAAD///gAAfwB/4AAAA///4AAH/4H/gAAAP//+AAAzzAf8AAAD///gAAGMAB/wAAA///8AAA5wAP/AAAP///AAADnAA/8AAD///wAAAP8AD/wAA///8AAAAAQAP/AAP///AAAAAAAB/8AD///gAAAAAAAH/wAn//YAAAAAAAAf/AB3dyAAAAAAAAB/4AMzMAAAAAAAAAP/gCMxAAAAAAAAAA/+ADEAAAAAAAAAAD/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAA/8AAAAAAAAAAAAAD2AAAAAAAAAAAAAAOAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"cettia-cetti":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+AAAAAAAAAAAAf/+AAAAAAAAAAAD//+AAAAAAAAAAA///+AAAAAAAAAAP///8AAAAAAAAAf////4AAAAAAAAH/////wAAAAAAAAP/////gAAAAAAAAA/////AAAAAAAAAB////+AAAAAAAAAD////+AAAAAAAAAH/////AAAAAAAAAP/////AAAAAAAAA//////AAAAAAAAB//////AAAAAAAAD/////+AAAAAAAAP/////+AAAAAAAA//////8AAAAAAAB//////4AAAAAAAH//////wAAAAAAAf//////wAAAAAAB///////wAAAAAAD///////gAAAAAAP///////AAAAAAA///////+AAAAAAD///////8AAAAAAP///////4AAAAAAf///////wAAAAAB////////gAAAAAH////////AAAAAAP///////+AAAAAA////////4AAAAAB////////wAAAAAD////////gAAAAAP///////+AAAAAAf///////4AAAAAA////////gAAAAAB////////AAAAAAD///////+AAAAAAH///////8AAAAAAP///////4AAAAAAf///////wAAAAAA//////+/gAAAAAA//////4eAAAAAAB//////wcAAAAAAP//////AAAAAAAA+/////8AAAAAAADr/////wAAAAAAAO//////gAAAAAAA57f///+AAAAAAAB/M////4AAAAAAAD8YB///gAAAAAAAH4wA//+AAAAAAAAH7gAH/4AAAAAAAADoAAP/wAAAAAAAAHAAAf/AAAAAAAAAPAAA/8AAAAAAAAAAAAB/4AAAAAAAAAAAAH/gAAAAAAAAAAAAP/AAAAAAAAAAAAA/8AAAAAAAAAAAAD/4AAAAAAAAAAAAH/gAAAAAAAAAAAAf/AAAAAAAAAAAAB/8AAAAAAAAAAAAD/4AAAAAAAAAAAAP/gAAAAAAAAAAAA/+AAAAAAAAAAAAB/8AAAAAAAAAAAAH/wAAAAAAAAAAAAf/gAAAAAAAAAAAA/+AAAAAAAAAAAAD/4AAAAAAAAAAAAH/wAAAAAAAAAAAAf/AAAAAAAAAAAAA/+AAAAAAAAAAAAD/4AAAAAAAAAAAAP/wAAAAAAAAAAAAf/AAAAAAAAAAAAB/8AAAAAAAAAAAAD/4AAAAAAAAAAAAP/gAAAAAAAAAAAAf+AAAAAAAAAAAAB/4AAAAAAAAAAAAD/gAAAAAAAAAAAAH/AAAAAAAAAAAAAI4AAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"charadrius-hiaticula-2":{"w":80,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAABgAAAAAAAAAAAA0AAAAAAAAAAAAPAAAAAAAAAAAAHgAAAAAAAAAAAD8AAAAAAAAAAAA/AAAAAAHAAAAAfwAAAAAHAAAAAP8AAAAAHgAAAAD/AAAAAH+AAAAB/wAAAAH/AAAAA/8AAAAH/AAAAAP/AAAAH/4AAAAH/wAAAH/+AAAAB/8AAAD/+AAAAA//AAAD//AAAAAP/wAAB//wAAAAH/8AAB//4AAAAB/+AAA//8AAAAA//gAA//+AAAAAf/4AAf//gAAAAH/+AAf//wAAAAB//gAP//8AAAAA//4AP//8AAAAAP/+AH///AAAAAD//AD///gAAAAB//wD///wAAAAAf/8B///4AAAAAP//A///8AAAAAD//4f//+AAAAAA///P///AAAAAAf//////gAAAAAH//////wAAAAAB//////4AAAAAAf/////8AAAAAAD/////+AAAAAAA//////gAAAAAAD/////4AAAAAAAf////8AAAAAAAD/////AAAAAAAAf////wAAAAAAAH////8AAAAAA/w/////AAAAAA//P////wAAAAAf//////8AAAAAP///////AAAAAD///////wAAAAA///////4AAAAAf//////+AAAAAf///////gAAAAf///////4AAAAPH//////8AAAAAAf//////AAAAAAD//////wAAAAAAf/////+AAAAAAD//////gAAAAAAf/////8AAAAAAD//////gAAAAAA//////8AAAAAAH//////gAAAAAA//////+AAAAAAH//////4AAAAAA///////4AAAAAD///////4AAAAAP///////4AAAAB////////AAAAAH////Af/gAAAAAP///AAfwAAAAAAP//AAAQAAAAAAAH/gAAAAAAAAAAAPYAAAAAAAAAAABmAAAAAAAAAAAAZgAAAAAAAAAAAEYAAAAAAAAAAADEAAAAAAAAAAABjAAAAAAAAAAAAQgAAAAAAAAAAAMYAAAAAAAAAAADmAAAAAAAAAAAA3gAAAAAAAAAAAO+AAAAAAAAAAABmAAAAAAAAAAAAdwAAAAAAAAAAADuAAAAAAAAAAAAfwAAAAAAAAAAADOAAAAAAAAAAAABgAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"charadrius-hiaticula":{"w":93,"h":75,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/4AAAAAAAAAAAAA//wAAAAAAAAAAAAf//AAAAAAAAAAAAH//8AAAAAAAAAAAB///wAAAAAAAAAAAf//+AAAAAAAAAAAP///wAAAAAAAAAAf///+AAAAAAAAAD/////4AAAAAAAAH//////wAAAAAAAH///////gAAAAAAD////////AAAAAAB///////78AAAAAA///////+AAAAAAAf///////AAAAAAAP///////wAAAAAAP///////+AAAAAAH////////wAAAAAP////////+AAAAH//////////wAAD///////////+AAAH///////////wAAB///////////8AAH////////////gAA////////////8AAH////////////gAAf///////////4AAAAB//////////AAAAAB/////////4AAAAAB////////+AAAAAAH////////wAAAAAAP///////8AAAAAAA////////AAAAAAAD///////4AAAAAAAP//////+AAAAAAAA///////gAAAAAAAB//////wAAAAAAAAD/////8AAAAAAAAAP/////AAAAAAAAAA/////gAAAAAAAAAD////wAAAAAAAAAAH///4AAAAAAAAAAAH//4AAAAAAAAAAAA//wAAAAAAAAAAAAH+AAAAAAAAAAAAABzgAAAAAAAAAAAAAecAAAAAAAAAAAAADxgAAAAAAAAAAAAAPMAAAAAAAAAAAAAA9gAAAAAAAAAAAAAD+AAAAAAAAAAAAAAHwAAAAAAAAAAAAAAeAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAHgAAAAAAAAAAAAAA+AAAAAAAAAAAAAAD8AAAAAAAAAAAAAAbwAAAAAAAAAAAAADPAAAAAAAAAAAAAAf4AAAAAAAAAAAAAH/AAAAAAAAAAAAADP/AAAAAAAAAAAAAR/+AAAAAAAAAAAAAP/AAAAAAAAAAAAAAPMAAAAAAAAAAAAABwAAAAAAAAAAAAAD+AAAAAAAAAAAAAADAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"chloris-chloris-2":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAADgEAAAAAAAAAAAAB4AQAAAAAAAAAAAA+IDgAAAAAAAAAAAfnAOAAAAAAAAAAAP/wM8AAAAAAAAAAH/8A74AAAAAAAAAD//MD/wAAAAAAAAA///AP/AAAAAAAAAf//wA/+AAAAAAAAP//8Ab/8AAAAAAAD//+AD//4AAAAAAB///+AP//gAAAAAAf///gA///AAAAAAP///4AB//8AAAAAH///8AA3//4AAAAB////AAD///wAAAA/////AAP///AAAAP////wAA///+AAAD////4AAD///5AAA/////AAA/////gAP////8AAD/////AD/////AAAP////+A/////gAAAf////4H////4AAAD/////h/////AAAAf////+f////wAAAB//////////4AAAAD/////////+AAAAAP/////////wAAAAA/////////gAAAAAD////////8AAAAAAD////////gAAAAAAf///////8AAAAAAB////////gAAAAAAP///////8AAAAAAB////////gAAAAAAH///////4AAAAAAA////////AAAAAAAD///////4AAAAAAAP///////AAAAAAAA///////wAAAAAAAH//////+AAAAAAAAP//////wAAAAAAAB//////8AAAAAAAAD//////gAAAAAAAAP/////4AAAAAAAAAP///+MAAAAAAAAAB////wAAAAAAAAAAH////AAAAAAAAAAAf///4AAAAAAAAAAB////gAAAAAAAAAAH///8AAAAAAAAAAAf///gAAAAAAAAAAA///+AAAAAAAAAAAf///wAAAAAAAAAAH///+AAAAAAAAAAA8///4AAAAAAAAAAGx///AAAAAAAAAAA7P//4AAAAAAAAAAHJ+f/gAAAAAAAAAA0Gx/8AAAAAAAAAADAcH/wAAAAAAAAAAMAA//AAAAAAAAAAAAAD/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAD/+AAAAAAAAAAAAAf/4AAAAAAAAAAAAB//gAAAAAAAAAAAAP/+AAAAAAAAAAAAB//4AAAAAAAAAAAAP//gAAAAAAAAAAAA//+AAAAAAAAAAAAH+f4AAAAAAAAAAAA/gfAAAAAAAAAAAAH4AAAAAAAAAAAAAA+AAAAAAAAAAAAAADgAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"chloris-chloris":{"w":93,"h":87,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAD/8AAAAAAAAAAAAB//4AAAAAAAAAAAAf//wAAAAAAAAAAAH///AAAAAAAAAAAB///8AAAAAAAAAAAf///wAAAAAAAAAAP////AAAAAAAAAAD////4AAAAAAAAAA/////gAAAAAAAAAD////+AAAAAAAAAAH////wAAAAAAAAAAP////AAAAAAAAAAAf///8AAAAAAAAAAD////wAAAAAAAAAAf////AAAAAAAAAAD////+AAAAAAAAAAP////4AAAAAAAAAB/////wAAAAAAAAAP/////gAAAAAAAAA/////+AAAAAAAAAH/////4AAAAAAAAA//////wAAAAAAAAH//////AAAAAAAAA//////8AAAAAAAAH//////wAAAAAAAA///////AAAAAAAAH//////8AAAAAAAA///////wAAAAAAAH///////AAAAAAAAf//////8AAAAAAAD///////wAAAAAAAf///////gAAAAAAB///////+AAAAAAAP///////4AAAAAAB////////gAAAAAAH///////+AAAAAAA////////4AAAAAAD////////gAAAAAAf///////+AAAAAAB////////4AAAAAAH////////AAAAAAAf///////8AAAAAAB////////gAAAAAAH///////+AAAAAAAf///////4AAAAAAB////////wAAAAAAH////////AAAAAAAf///////8AAAAAAA////////wAAAAAAD////////AAAAAAAH///////8AAAAAAAP///////wAAAAAAAf//////fAAAAAAAA//////84AAAAAAAH///z//hgAAAAAAD8B/wD/+AAAAAAAD4AHwAH/4AAAAAAB4AA+AAH/gAAAAAB8AADwAAf+AAAAAAfAAA8AAB/4AAAAAf/8AOAAAH/gAAAAf4CQDgAAAf+AAAAGOAAA4AAAB/4AAAAGwAAOAAAAH/gAAAA8AADgAAAAf+AAAAHAAA4AAAAB/4AAAA4AAOAAAAAH/AAAAFgAD/4AAAAf8AAAA2AB/+gAAAB7wAAAGAB/AAAAAAHHAAAAwAZ4AAAAAAIIAAACAGaAAAAAAAAAAAAIAjQAAAAAAAAAAAAAAWAAAAAAAAAAAAAACwAAAAAAAAAAAAAAWAAAAAAAAAAAAAACQAAAAAAAAAAAAAAZgAAAAAAAAAAAAACAAAAAAAAAAAAAAAQAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"chroicocephalus-ridibundus-2":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAA4AAAAAAAAAAAAAAfAAAAAAAAAAAAAAP4AAAAAAAAAAAAAH+AAAAAAAAAAAAAD/gAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/wAAAAAAAAAAAAD/+AAAAAAAAAAAAA//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH//AAAAAAAAAAAAD//4AAAAAAAAAAAA//+AAAAAAAAAAAAf//gAAAAAAAAAAAH//4AAAAAAAAAAAD//+AAAAAAAAAAAA///wAAAAAAAAAAAP//8AAAAAAAAAAAD///AAB4AAAAAAAA///wAAHgAAAAAAAf//+AAA/AAAAAAAH///gAAH8AAAAAAB///4AAAf8AAAAAAf//+AAAD/wAAAAAH///gAAAP/gAAAAB///4AAAA//AAAAAP//+AAAAH/+AAAAD///gAAAAf/4AAAAf//4AAAAB//wAAAH//+AAAAAH//AAAA///wAAAAAf/+AAAH//8AAAAAB//4AAA///gAAAAAH//gAAH//8AAAAAAP/+AAA///gAAAAAA//8AAP//8AAAAAAH//4AB///AAAAAAAf//wAP//4AAAAAAA///gB///AAAAAAAD///Af//4AAAAAAAD//8D///AAAAAAAAH//wf//wAAAAAAAAP//n//+AAAAAAAAAf/+///wAAAAAAAAB/////8AAAAAAAAAH/////gAAAAAAAAAP////8AAAAAAAAAP/////AAAAAAAAAP/////4AAAAAAAAD//////AAAAAAAAA//////wAAAAAAAAP/////+AAAAAAAAH//////wAAAAAAAD//////8AAAAAAAB///////gAAAAAAAID/////+AAAAAAAAAD/////wAAAAAAAAAP/////AAAAAAAAAAf////+AAAAAAAAAB/////4AAAAAAAAAH/////wAAAAAAAAAf/////8AAAAAAAAA///////4AAAAAAAB///////AAAAAAAAB//////wAAAAAAAAD/////+AAAAAAAAAB/////gAAAAAAAAAAP///4AAAAAAAAAAABh/+AAAAAAAAAAAAGH+AAAAAAAAAAAAAQ+AAAAAAAAAAAAADDgAAAAAAAAAAAAAIOAAAAAAAAAAAAAAx8AAAAAAAAAAAAAHj4AAAAAAAAAAAAAfHgAAAAAAAAAAAAA8AAAAAAAAAAAAAADgAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"chroicocephalus-ridibundus":{"w":93,"h":75,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AAAAAAAAAAAAAA/+AAAAAAAAAAAAAP/4AAAAAAAAAAAAD//gAAAAAAAAAAAA//+AAAAAAAAAAAAP//wAAAAAAAAAAAD///AAAAAAAAAAAD///4AAAAAAAAAAD////AAAAAAAAAAA////8AAAAAAAAAAPh///gAAAAAAAAAAAD//8AAAAAAAAAAAAP//gAAAAAAAAAAAB//8AAAAAAAAAAAAP//gAAAAAAAAAAAD//8AAAAAAAAAAAAf//wAAAAAAAAAAAH///wAAAAAAAAAAA////8AAAAAAAAAAP////+AAAAAAAAAB/////+AAAAAAAAAP/////+AAAAAAAAB//////8AAAAAAAAP//////4AAAAAAAD///////wAAAAAAAf///////AAAAAAAD///////8AAAAAAAf///////wAAAAAAB////////wAAAAAAP////////wAAAAAB/////////gAAAAAP/////////AAAAAA/////////8AAAAAH/////////4AAAAAf/////////gAAAAD/////////+AAAAAP/////////+AAAAA///////////4AAAD///////////8AAAP///////////4AAA////////////AAAD///////////gAAAH//////////+AAAAf//////////wAAAA//////////AAAAAA/////////8AAAAAB////8AAH/gAAAAAA///+AAAD4AAAAAAA///AAAAAAAAAAAAGf/gAAAAAAAAAAAAx4AAAAAAAAAAAAAGGAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGGAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGGAAAAAAAAAAAAAAwwAAAAAAAAAAAAAPGAAAAAAAAAAAAD/wwAAAAAAAAAAAAP+GAAAAAAAAAAAAA/wwAAAAAAAAAAAAP+GAAAAAAAAAAAABDnwAAAAAAAAAAAAAP+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAP+AAAAAAAAAAAAAD/gAAAAAAAAAAAAAT8AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"circus-aeruginosus-2":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAnAAAAAAAAAAAAAAHcAAAAAAAAAAAAAAd4AAAAAAAAAAAAAB/gAAAAAAAAAAAAAG+AAAAAAAAAAAAAA/4AAAAAAAAAAAAAD/4AAAAAAAAAAAAAP/gAAAAAAAAAAAAB/+AAAAAAAAAAAAAH/4AAAAAAAAAAAAA//wAAAAAAAAAAAAH/+AAAAAAAAAAAAAf/8AAAAAAAAAAAAD//wAAAAAAAAAAAAP//AAAAAAAAAAAAB//8AAAAAAAAAAAAP//wAAAAAAAAAAAA///AAAAAAAAAAAAH//8AAAAAAAAAAAAf//gAAAAAAAAAAAD//8AAAAAAAAAAAAP//wAAAAAAAAAAAB///wAAAAAAAAAAAH///AAAAAAAAAAAAf//+AAAAAAAAAAAB///4AAAAAAAAAAAP///gAAAAAAAAAAB///+AAAAAAAAAAAH///4AfAAAAAAAAA////gP/AAAAAAAAD///+B/8AAAAAAAAf///4f/4AAAAAAAB////j//gAAAAAAAD///8f/+AAAAAAAAH///3//8AAAAAAAAf//////wAAAAAAAA//////+AAAAAAAAD//////4AAAAAAAAP//////gAAAAAAAB//////+AAAAAAAAH//////4AAAAAAAA///////wAAAAAAAH///////AAAAAAAA///////8AAAAAAAP///////wAAAAAAH///////+AAAAAAH////////4AAAAAD////////+AAAAAA/////////4AAAAAP/////////AAAAAD/////////8AAAAA//////////gAAAAH/////////8AAAAA//////////gAAAAEH////////8AAAAAAH////////gAAAAAAP///////8AAAAAAAf///////gAAAAAAA////////gAAAAAAAf///////gAAAAAAAH//+P///wAAAAAAAD//wP///gAAAAAAAH/+A///wAAAAAAAAP/4D//8AAAAAAAAAHvAf+cAAAAAAAAAAM4B/wAAAAAAAAAAAjAP+AAAAAAAAAAAEIA/wAAAAAAAAAAAhAD+AAAAAAAAAAAGIAfwAAAAAAAAAAA/kB+AAAAAAAAAAADPgHwAAAAAAAAAAAYwAOAAAAAAAAAAAB/ABwAAAAAAAAAAAH/AOAAAAAAAAAAAAd4AwAAAAAAAAAAAAHgGAAAAAAAAAAAAAAAwAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"circus-aeruginosus":{"w":61,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAH/gAAAAAAAH/8AAAAAAAH//AAAAAAAD//gAAAAAAB//4AAAAAAA//8AAAAAAAf//AAAAAAAP//gAAAAAAH//wAAAAAAD//4AAAAAAB//8AAAAAAA///AAAAAAAf//gAAAAAAf//4AAAAAAP//+AAAAAAP///gAAAAAH///4AAAAAD///8AAAAAB////gAAAAAf///4AAAAAP///+AAAAAH////wAAAAD////8AAAAB////+AAAAAf////gAAAAP////4AAAAH////+AAAAD/////gAAAB/////wAAAA/////8AAAAP////+AAAAH/////gAAAD/////wAAAA/////8AAAAf/////AAAAH/////gAAAD/////4AAAB/////8AAAAf/////AAAAH/////gAAAD/////wAAAA/////4AAAAP////+AAAAH/////gAAAB/////wAAAAf////8AAAAP////+AAAAD/////AAAAB/////wAAAA/////4AAAAf////+AAAAH/////AAAAD/////wAAAA/////4AAAAf////4AAAAH////8AAAAD////+AAAAB/////gAAAA/////4AAAA//v//+AAAAffz///AAAA/zx///wAAA/+Yf//4AAA//gH//+AAAfjwD///gAAPnYA///4AAD/IAP//+AAAfAAD///AAAHgAAf/3wAABgAAH/58AAAAAAD/+eAAAAAAA//ngAAAAAAf/xwAAAAAAP/8IAAAAAAD/eAAAAAAAB/nAAAAAAAAfxwAAAAAAAP84AAAAAAAD+EAAAAAAAB/gAAAAAAAAfwAAAAAAAAP4AAAAAAAAD8AAAAAAAAB/AAAAAAAAAfgAAAAAAAAHwAAAAAAAAB4AAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAA="},"columba-livia-2":{"w":93,"h":68,"bits":"gAAAAAAAAAAAAAAGYAAAAAAAAAAAAAcZgAAAAAAAAAAAB/D+AAAAAAAAAAAB/zf6AAAAAAAAAAB//x/4AAAAAAAAAB//8P/gAAAAAAAAA//+A/+AAAAAAAAAf//4H/+AAAAAAAAP//+A//4AAAAAAAH///gD//gAAAAAAD///4Af//AAAAAAA///+AB//8AAAAAAf///wAH//4AAAAAP///8AA///AAAAAH////AAD//+AAAAD////wAAf//4AAAA////8AAB///gAAAf////AAAH//+AAAH////4AAA///4AAB////+AAAD///gAAf////gAAAP//+AAH////4AAAA///4AB////+AAAAD///gAf////gAAAAf///AD////4AAAAB///8A////8AAAAAP///wH////AAAAAA////B////wAAAAAD///8P///wAAAAAAP///x///+AAAAAAAf///f///wAAAAAAB///////+AAAAAAAf///////4AAAAAAD///////+AAAAAAAf///////wAAAAAAH////////AAAAAAA////////4AAAAAAMP//////+AAAAAAAA///////4AAAAAAAD//////+AAAAAAAAf//////wAAAAAAAD//////+AAAAAAAAP//////gAAAAAAAB//////8AAAAAAAAP//////AAAAAAAAA//////wAAAAAAAAD//////AAAAAAAAAf/////8AAAAAAAAB//////wAAAAAAAAH//////4AAAAAAAAf//////8AAAAAAAA////////AAAAAAAD////////wAAAAAAH////////AAAAAAAH///////4AAAAAAAP//////+AAAAAAAAf//////wAAAAAAAAP/////+AAAAAAAAB//////4AAAAAAAAP/v////AAAAAAAAB/k////gAAAAAAAAP8H///4AAAAAAAAAf4f///gAAAAAAAABnB///4AAAAAAAAAAAH//8AAAAAAAAAAAAf//AAAAAAAAAAAAB//AAAAAAAAAAAAAHOAAAA="},"columba-livia":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAB/wAAAAAAAAAAAAf/gAAAAAAAAAAAH/+AAAAAAAAAAAB//4AAAAAAAAAAAP//AAAAAAAAAAAD//8AAAAAAAAAAAf//gAAAAAAAAAAD//+AAAAAAAAAAA///wAAAAAAAAAAH///AAAAAAAAAAB///4AAAAAAAAAAf///AAAAAAAAAAD3//4AAAAAAAAAA4P//AAAAAAAAAAAB//8AAAAAAAAAAAP//gAAAAAAAAAAB//8AAAAAAAAAAAP//wAAAAAAAAAAD//+AAAAAAAAAAAf//4AAAAAAAAAAH///AAAAAAAAAAA///+AAAAAAAAAAP///4AAAAAAAAAB////wAAAAAAAAAf////gAAAAAAAAD/////gAAAAAAAA//////AAAAAAAAH/////+AAAAAAAA//////8AAAAAAAH//////4AAAAAAB///////gAAAAAAP///////AAAAAAB///////8AAAAAAP///////wAAAAAB////////AAAAAAP///////8AAAAAB////////wAAAAAP////////AAAAAB////////8AAAAAP////////wAAAAB/////////AAAAAP////////8AAAAA/////////wAAAAH/////////AAAAA/////////8AAAAD/////////wAAAAf/////////AAAAD/////////8AAAAP/////////wAAAA//////////AAAAH/////////4AAAAf/////////gAAAB/////////8AAAAH/////////wAAAAf////////+AAAAB/////////wAAAAH/////////gAAAAP////////+AAAAA/////////8AAAAB/////////wAAAAH/////////AAAAAP////////8AAAAAf////////4AAAAA/////////gAAAAB////////+AAAAAB////////4AAAAB/////////gAAAH/////////+AAAD//P///////4AAA//8//////7/gAAJ+Dz+AA///D+AAAdwA/gAD//4D4AADcAPwAAP//AAAAAbAHwAAA//8AAAAAID8AAAB//wAAAAQH//AAAD/+AAAAAB/xgAAAP/4AAAAAf8AAAAB//gAAAACfAAAAAH/8AAAAAHYAAAAAf/wAAAABzAAAAAB//AAAAAO4AAAAAP/4AAAABmAAAAAA//gAAAAIQAAAAAD/+AAAABBAAAAAAP/4AAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAAP/gAAAAAAAAAAAA/+AAAAAAAAAAAAB/wAAAAAAAAAAAAD+AAAAAAAAAAAAAAAA=="},"columba-oenas-2":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2AAAAAAAAAAAAAAH8AAAAAAAAAAAAAAf4AAAAAAAAAAAMIB/gAAAAAAAAAAPvAf/AAAAAAAAAAH/gB/+AAAAAAAAAD//AH/4AAAAAAAAB//4Af/wAAAAAAAA//8AB//AAAAAAAAf//wAH/+AAAAAAAP//+AA//4AAAAAAD///AAH//wAAAAAA///wAAf//AAAAAAf//+AAB//8AAAAAP///wAAH//wAAAAD///8AAAf//AAAAA////AAAD//8AAAAP///wAAAP//4AAAH///+AAAA///gAAB////gAAAD//+AAA////4AAAAP//4AAP////AAAAA///gAD////wAAAAD//+AA////8AAAAAP//8AP///+AAAAAA///wD////gAAAAAD///A////8AAAAAAP//8H////AAAAAAAf//h////gAAAAAAD//+P///8AAAAAAAf//z///+AAAAAAAP///f///AAAAAAAB///////4AAAAAAAf///////AAAAAAAD///////4AAAAAAAf///////AAAAAAAH///////4AAAAAAA////////AAAAAAAOf//////4AAAAAABA///////AAAAAAAAD//////wAAAAAAAAf//////AAAAAAAAD//////4AAAAAAAAf/////+AAAAAAAAD//////wAAAAAAAAf/////+AAAAAAAAB//////gAAAAAAAAP/////4AAAAAAAAB//////AAAAAAAAAH/////4AAAAAAAAA/////+AAAAAAAAAD/////gAAAAAAAAAf////gAAAAAAAAAB////8AAAAAAAAAAD////wAAAAAAAAAAP///+AAAAAAAAAAA////4AAAAAAAAAAD////AAAAAAAAAAAP///8AAAAAAAAAAAf///gAAAAAAAAAAB///8AAAAAAAAAAAP///wAAAAAAAAAAB///+AAAAAAAAAAAOP//4AAAAAAAAAABJv//gAAAAAAAAAAMM//+AAAAAAAAAAAwj//4AAAAAAAAAACGf//gAAAAAAAAAAAB//+AAAAAAAAAAAAP//4AAAAAAAAAAAB///gAAAAAAAAAAAH//8AAAAAAAAAAAA///gAAAAAAAAAAAD//8AAAAAAAAAAAAP//gAAAAAAAAAAAA//8AAAAAAAAAAAAA//AAAAAAAAAAAAAD/gAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"columba-oenas":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/AAAAAAAAAAAAAP/gAAAAAAAAAAAD//AAAAAAAAAAAAf/+AAAAAAAAAAAD//4AAAAAAAAAAAf//wAAAAAAAAAAB///AAAAAAAAAAAP//8AAAAAAAAAAB///wAAAAAAAAAAH///gAAAAAAAAAA////AAAAAAAAAAD///+AAAAAAAAAAf///8AAAAAAAAAB///AwAAAAAAAAAP//4AAAAAAAAAAB///AAAAAAAAAAAP//4AAAAAAAAAAD///gAAAAAAAAAAf//+AAAAAAAAAAP///4AAAAAAAAAD////gAAAAAAAAB////+AAAAAAAAAf////4AAAAAAAAH/////gAAAAAAAA//////AAAAAAAAP/////8AAAAAAAB//////wAAAAAAAP//////AAAAAAAB//////8AAAAAAAP//////wAAAAAAB///////gAAAAAAP//////+AAAAAAB///////4AAAAAAP///////gAAAAAB///////+AAAAAAP///////4AAAAAB////////gAAAAAP///////8AAAAAB////////wAAAAAP////////AAAAAB////////8AAAAAP////////gAAAAB////////+AAAAAP////////wAAAAA/////////AAAAAH////////4AAAAA/////////gAAAAD////////8AAAAAf////////gAAAAB////////8AAAAAH////////gAAAAB////////8AAAAAP////////gAAAAD////////8AAAAAf////////gAAAAD////////4AAAAAf////////AAAAAD////////wAAAAAf///////8AAAAAD///////+AAAAAAf///////+AAAAADz///////8AAAAAOf//////hgAAAAAH////////AAAAAA//////4//AAAAAH////AAP//AAAAA////wADw4CAAAAAA//eAAIAwAAAAAAD/4gAAABgAAAAAAf/kAAAAGAAAAAAD//gAAAAYAAAAAAP/4AAAAAAAAAAAB/+AAAAAAAAAAAAH/wAAAAAAAAAAAA/+AAAAAAAAAAAAH/4AAAAAAAAAAAAf/AAAAAAAAAAAAD/8AAAAAAAAAAAAP/gAAAAAAAAAAAB/8AAAAAAAAAAAAP/wAAAAAAAAAAAA/+AAAAAAAAAAAAH/wAAAAAAAAAAAAf/AAAAAAAAAAAAD/4AAAAAAAAAAAAP/AAAAAAAAAAAAA/4AAAAAAAAAAAAD+AAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"columba-palumbus-2":{"w":85,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBAAAAAAAAAAAAOAxAAAAAAAAAAAeAMwAAAAAAAAAA+IHcAAAAAAAAAB88B2QAAAAAAAAD/8A7sAAAAAAAAH/4Af/AAAAAAAAH/4AH/gAAAAAAAP/7gD/+AAAAAAAP//gB//gAAAAAAP//gAf/wAAAAAAf//gAP/8AAAAAAf//oAH//gAAAAAf//8AB//4AAAAAf//8AA//8AAAAAf//8AAf//gAAAAf//8AAH//wAAAAf///AAD//8AAAAf///AAB///AAAAf///AAAf//wAAAf///AAAP//4AAAf///gAAD//8AAAf///wAAB///AAAf///4AAAf//wAAf///wAAAP//4AAf///4AAAD9/8AAf///8AAAB8P+AAf///8AAAAcB/wAP///8AAAAOAP+AP///+AAAAD/H/gP///+AAAAB///4H///+AAAAA///+D///+AAAAAP///h///+AAAAAD///4///+AAAAAA///+///8AAAAAAP//////+AAAAAAD///////gAAAAAAf//////gAAAAAAD//////4AAAAAAB//////4AAAAAAH//////8AAAAAAH///////AAAAAAH///////gAAAAAD///////gAAAAAB///////4AAAAAB///////8AAAAAA///////8AAAAAA///////+AAAAAAY///////AAAAAAAH//////gAAAAAAD//////wAAAAAAA//////4AAAAAAAf/////wAAAAAAAP/////4AAAAAAAH/////8AAAAAAAB/////4AAAAAAAA/////8AAAAAAAAP////4AAAAAAAAH////8AAAAAAAAB/////AAAAAAAAAf////wAAAAAAAAH////8AAAAAAAAB////+AAAAAAAAAf////gAAAAAAAAD////wAAAAAAAAAf///8AAAAAAAAAD////AAAAAAAAAA////gAAAAAAAAAP///8AAAAAAAAAD////AAAAAAAAAD////wAAAAAAAADz///8AAAAAAAAB93///gAAAAAAAA45///4AAAAAAAAcc///+AAAAAAAAGHf///gAAAAAAADhv///4AAAAAAAAwT///8AAAAAAAAAB///8AAAAAAAAAA///+AAAAAAAAAAb///gAAAAAAAAAN///wAAAAAAAAACf//wAAAAAAAAAA///wAAAAAAAAAAD//4AAAAAAAAAAA//8AAAAAAAAAAAD/oAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"columba-palumbus":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAA/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAH/+AAAAAAAAAAAAA//wAAAAAAAAAAAAP//AAAAAAAAAAAAD//4AAAAAAAAAAAAf//gAAAAAAAAAAAD///AAAAAAAAAAAAf//4AAAAAAAAAAAH//BgAAAAAAAAAAA//gAAAAAAAAAAAAH/8AAAAAAAAAAAAA//AAAAAAAAAAAAAH/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/4AAAAAAAAAAAAB//gAAAAAAAAAAAAP/8AAAAAAAAAAAAD//gAAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAB//+AAAAAAAAAAAAf//4AAAAAAAAAAAH///AAAAAAAAAAAD///8AAAAAAAAAAB////gAAAAAAAAAA////8AAAAAAAAAAf////gAAAAAAAAAP////+AAAAAAAAAH/////wAAAAAAAAB/////+AAAAAAAAA//////wAAAAAAAAP/////+AAAAAAAAD//////wAAAAAAAA//////+AAAAAAAAP//////wAAAAAAAD//////+AAAAAAAB///////wAAAAAAA///////+AAAAAAAP///////wAAAAAAH///////+AAAAAAB////////wAAAAAAf///////8AAAAAAH////////gAAAAAB////////4AAAAAAf////////AAAAAAP////////wAAAAAD////////8AAAAAA/////////AAAAAAP////////4AAAAAH////////+AAAAAD/////////gAAAAB/////////4AAAAA/////////+AAAAAP/////////AAAAAH/////////wAAAAB/////////4AAAAAP////////8AAAAAA/////////AAAAAAP////////gAAAAAD////////wAAAAAAA/////////AAAAAAP//wAP///8AAAAAD//wAAB///AAAAAA//4AAAP7hsAAAAAP/wAAAB+AEwAAAAH/4AAAAPwAyAAAAB/8AAAAAPACAAAAAf/AAAAAAcAQAAAAH/wAAAAABwAAAAAB/8AAAAAAHAAAAAA/+AAAAAA//8AAAAP/gAAAAAAP8AAAAD/4AAAAAAAP8AAAAf+AAAAAAAAx8AAAH/AAAAAAAADhwAAB/wAAAAAAAAGAAAABgAAAAAAAAAwAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"corvus-corax-2":{"w":58,"h":93,"bits":"AAAAAAAAAAAAAAAACAAAAAAAAEYAAAAAAAAjAAAAAAAAGcwAAAAAAAzmAAAAAAAHdwAAAAAAA/uAAAAAAAH9xgAAAAAA/+cAAAAAAH/3gAAAAAAf/8AAAAAAD//gAAAAAAf//AAAAAAD//4AAAAAAP//gAAAAAB//8AAAAAAf//gAAAAAB//+AAAAAAP//4AAAAAB///AAAAAAH//8AAAAAA///gAAAAAH//+AAAAAAf//wAAAAAD//+AAAAAAf//4AAAAAB///AAAAAAH//8AAAAAAf//4AAAAAB///AAAAAAD//+AAAAAAP//8AAAAAAf//gAAAAAB///AAAAAAH//8AAAAAAf//wAAAAAB///AAAAAAH//8AAAADx///wAAAA/////AAAB/////4AAAf/////wAABf/////AAAD/////gAAAAP////gD+AAP//////4AAf//////wAAf//////gAAf/////+AAAf/////8AAB//////wAAP//////AAB//////+AAP//////4AB///8///gAP///5///AB///+B//4AH////j//AAf//+cH/4AB///4AP/AAP///AAPwAAf//8AAeAAB///AAAAAAH//8AAAAAAf//gAAAAAB//wAAAAAAH//AAAAAAAf/8AAAAAAB//wAAAAAAH//AAAAAAAf/8AAAAAAB//wAAAAAAH//AAAAAAAf/8AAAAAAB//wAAAAAAH//AAAAAAAf/8AAAAAAA//wAAAAAAD//AAAAAAAH/wAAAAAAAX7gAAAAAABf+AAAAAAAE/YAAAAAAADdgAAAAAAAOzAAAAAAAA7sAAAAAAADuwAAAAAAAGYAAAAAAAARAAAAAAAABEAAAAAAAAEQAAAAAAAAAAAAAAAA"},"corvus-corax":{"w":82,"h":93,"bits":"AAAPgAAAAAAAAAAAH/wAAAAAAAAAA///wAAAAAAAAA////gAAAAAAAAP////gAAAAAAAD/////AAAAAAAAf////+AAAAAAAB/////8AAAAAAAI/////4AAAAAAAAD////wAAAAAAAAD////AAAAAAAAAH///+AAAAAAAAAP///8AAAAAAAAAf///4AAAAAAAAB////wAAAAAAAAH////wAAAAAAAAf////gAAAAAAAD/////gAAAAAAAP/////gAAAAAAA//////AAAAAAAD/////+AAAAAAAP/////8AAAAAAA//////4AAAAAAD//////wAAAAAAH//////gAAAAAAf//////AAAAAAB//////8AAAAAAH//////4AAAAAAP//////wAAAAAA///////AAAAAAB//////+AAAAAAH//////8AAAAAAf//////wAAAAAB///////gAAAAAD//////+AAAAAAP//////8AAAAAAf//////4AAAAAA///////gAAAAAD///////AAAAAAH//////+AAAAAAP//////8AAAAAAf//////wAAAAAA///////AAAAAAB//////+AAAAAAH//////8AAAAAAP//////wAAAAAAf//////gAAAAAB//////+AAAAAAD//////8AAAAAAP//////wAAAAAAf//////AAAAAAB//////8AAAAAAH//////wAAAAAAP//////AAAAAAAf/////wAAAAAAA/////+AAAAAAAD/////8AAAAAAAFf////4AAAAAAAA/////wAAAAAAAB/////AAAAAAAAD////+AAAAAAAAf8f//4AAAAAAAH/gf//wAAAAAAB5+A///AAAAAAAefgB//+AAAAAAH/gAH//4AAAAAA//AAf//wAAAAAP+WAB///gAAAAB//wAD///AAAAAH+/gAP//+AAAAAXwCAA///4AAAAAfAIAB//fwAAAAA+BAAH/+fAAAAAB4AAAf/4+AAAAAH0AAA//h8AAAAAPgAAD//DwAAAAAAAAAH/8HgAAAAAAAAAf/wOAAAAAAAAAB//gIAAAAAAAAAD/+AQAAAAAAAAAP/4AAAAAAAAAAAf/wAAAAAAAAAAA//AAAAAAAAAAAB/8AAAAAAAAAAAH/4AAAAAAAAAAAP/gAAAAAAAAAAAf+AAAAAAAAAAAB/4AAAAAAAAAAAD/wAAAAAAAAAAAH/AAAAAAAAAAAAP8AAAAAAAAAAAAHwAAAAAAAAAAAACAA"},"corvus-corone-2":{"w":93,"h":53,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACCAAAAAAAAAAAAAAwgAAAAAAAAAAAAAMYYAAAAAAAAAAAAGeOAAAAAAAAAAAAD/HgAAAAAAAAAAAP//wAIAAAAAAAAA///44BjAAAAH8AB////+BHMAAAH/4A////+AGO4AAD//gP////mAe//jAH/+H/////gA////+H///////wAg////8f//////+AH/////////////AAP////////////wAAD///////////8AAP///////////+AAA////////////gAAA///////////wAAAH//////////4AAAAH/////////+AAAAAD/////////AAAAAAb////////AAAAAAAf///////4AAAAAAAf//////8AAAAAAAAf/////+AAAAAAAAAf////egAAAAAAAAAf///4AAAAAAAAAAAf+//AAAAAAAAAAAALP/8AAAAAAAAAAAAB//wAAAAAAAAAAAAP//AAAAAAAAAAAAAv/8AAAAAAAAAAAAB//wAAAAAAAAAAAAP//AAAAAAAAAAAAB//+AAAAAAAAAAAAf//4AAAAAAAAAAAD///AAAAAAAAAAAAf//4AAAAAAAAAAAH//+AAAAAAAAAAAA///wAAAAAAAAAAAH//+AAAAAAAAAAAAf//gAAAAAAAAAAAA//8AAAAAAAAAAAAH/+AAAAAAAAAAAAAH/wAAAAAAAAAAAAAf4AAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"corvus-corone":{"w":91,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgAAAAAAAAAAAAB/+AAAAAAAAAAAAD//gAAAAAAAAAAAD//4AAAAAAAAAAAD///wAAAAAAAAAAD////gAAAAAAAAAD////8AAAAAAAAAD/////AAAAAAAAAD/////wAAAAAAAAD/////8AAAAAAAAB////+AAAAAAAAAB////wAAAAAAAAAB////gAAAAAAAAAD////gAAAAAAAAAH////wAAAAAAAAAP////wAAAAAAAAAP////4AAAAAAAAAf////8AAAAAAAAAf////+AAAAAAAAA//////AAAAAAAAA//////gAAAAAAAA//////wAAAAAAAA//////4AAAAAAAA//////8AAAAAAAA//////+AAAAAAAAf//////AAAAAAAAf//////AAAAAAAAf//////gAAAAAAAf//////wAAAAAAAf//////wAAAAAAA///////4AAAAAAA///////8AAAAAAA///////8AAAAAAA///////8AAAAAAA///////+AAAAAAA///////+AAAAAAAf//////+AAAAAAAf///////AAAAAAAf///////AAAAAAAf///////AAAAAAAP///////gAAAAAAP///////gAAAAAAP///////gAAAAAAH///////wAAAAAAH///////wAAAAAAD///////wAAAAAAB///////wAAAAAAA///////wAAAAAAAf//////wAAAAAAAH//////wAAAAAAAB//////wAAAAAAAB//////wAAAAAAAB//////wAAAAAAAB//////gAAAAAAAA//////gAAAAAAAA//////wAAAAAAAA//////4AAAAAAAA///////wAAAAAAA///8T+A/gAAAAAA///8B/AD8AAAAAA///8A/gc/+AAAAA///8APgf/8AAAAA///8AB4IBvAAAAA///8AAOAAY4AAAA/v/8AADgAHEAAAAfH/8AAA4ABgAAAAfH/8AAAOAAIAAAAfD/4AAADgAAAAAAOD/4AAAA8MAAAAAOB/4AAAf//AAAAAGB/8AAAL/+AAAAAGA/8AAAAA/8AAAAAA/+AAAAAOHAAAAAAf+AAAAADwAAAAAAf/AAAAAAYAAAAAAf/AAAAAACAAAAAAP/gAAAAAAAAAAAAP/gAAAAAAAAAAAAH/wAAAAAAAAAAAAH/wAAAAAAAAAAAAD/4AAAAAAAAAAAAD/4AAAAAAAAAAAAB/4AAAAAAAAAAAAA/8AAAAAAAAAAAAA/8AAAAAAAAAAAAAf8AAAAAAAAAAAAAP8AAAAAAAAAAAAAH4AAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"corvus-frugilegus-2":{"w":59,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAEgAAAAAAAANAAAAAAAACbAAAAAAAAG2gAAAAAAANtgAAAAAAAL7AAAAAAAAf+AAAAAAAA/9AAAAAAAB/+AAAAAAAD/8AAAAAAAH/4AAAAAAAP/4AAAAAAAf/4AAAAAAA//wAAAAAAB//gAAAAAAH//gAAAAAAP//AAAAAAAf/+AAAAAAA//8AAAAAAB//4AAAAAAD//wAAAAAAH//gAAAAAAP//AAAAAAAP//AAAAAAAf//gAAAAAA///AAAAAAD///gAAAAAD///AAAAAAH///AAAAAAP///AAAAAAf///AAAAAAf//+AAAAAA///8AA8AAAf//8AH8AAAP//4A/8AAAP//wH/4AAAP//w//wAAAf//D//wAAB//////gAD///////gAf///////gB////////AP///////8B////////8H////////4YH///////gAD////n//AAB////B/+AAAH//+Af4AAAB//+ADgAAAD//8AAAAAAH//8AAAAAAf//wAAAAAA///gAAAAAD///AAAAAAH//+AAAAAAP//4AAAAAAf//wAAAAAA///gAAAAAA//+AAAAAAB//8AAAAAAD//4AAAAAAD//wAAAAAAH//wAAAAAAP//gAAAAAAP//AAAAAAAf//AAAAAAAf/+AAAAAAA//8AAAAAAA//8AAAAAAB//4AAAAAAB//wAAAAAAB//gAAAAAAD//gAAAAAAD//AAAAAAAD//AAAAAAAH/6AAAAAAAH/4AAAAAAAH/wAAAAAAAP+wAAAAAAANsgAAAAAAAbtAAAAAAAATYAAAAAAAAWYAAAAAAAAEwAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"corvus-frugilegus":{"w":93,"h":79,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAD/8AAAAAAAAAAAAB//4AAAAAAAAAAAAf//gAAAAAAAAAAAP///gAAAAAAAAAAD////gAAAAAAAAAH/////gAAAAAAAAH//////AAAAAAAAH//////+AAAAAAAD///////4AAAAAAB////////AAAAAAAf/////+AAAAAAAAP/////+AAAAAAAAD//////gAAAAAAAA//////4AAAAAAAAP//////AAAAAAAAD//////4AAAAAAAA//////+AAAAAAAAP//////wAAAAAAAD//////+AAAAAAAA///////wAAAAAAAf//////8AAAAAAAH///////AAAAAAAD///////wAAAAAAA///////+AAAAAAAP///////gAAAAAAD///////4AAAAAAA///////+AAAAAAAH///////gAAAAAAB///////4AAAAAAAf//////+AAAAAAAH///////gAAAAAAB///////4AAAAAAAf//////+AAAAAAAD///////gAAAAAAAf//////4AAAAAAAD//////8AAAAAAAA///////AAAAAAAAP//////wAAAAAAAD//////8AAAAAAAA///////AAAAAAAAP//////gAAAAAAAD//////4AAAAAAAA//////+AAAAAAAAPf/////gAAAAAAADn/////4AAAAAAAAx//////AAAAAAAAM//////+AAAAAAACH///gH//gAAAAAAB///4A/g/gAAAAAAf//+AH4P8AAAAAAP9//gA/PnwAAAAAB+P/wAD+geAAAAAAeD/+AADwDAAAAAAHAf/AAAPAIAAAAABwH/wAAAcDAAAAAAAB/8AAABwAAAAAAAAP/AAAAHAAAAAAAAD/4AAAAcAAAAAAAAf+AAAAB4cAAAAAAH/wAAAP//AAAAAAB/8AAAC/f/wAAAAAP/gAAAAA+IAAAAAD/4AAAAADwAAAAAAf+AAAAAADwAAAAAH/wAAAAAAAAAAAAA/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAB/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAD/wAAAAAAAAAAAAAf8AAAAAAAAAAAAAD/AAAAAAAAAAAAAAPwAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"cuculus-canorus-2":{"w":93,"h":70,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/4AAAAAAAAAAAA////+AAAAAAAAAAf/////AAAAAAAAAAP////+AAAAAAAAAAf////8AAAAAAAAAB/////4AAAAAAAAAP/////wAAAAAAAAA//////gAAAAAAAAD//////AAAAAAAAAf/////8AAAAAAAAD//////4AAAAAAAA///////gAAAAAAAP//////+AAAAAAAD///////8AAAAAAA////////wAAAAAAH////////gAAAAAB////////+AAAAAAP////////4AAAAAD/////////gAAAAAf/////////AAAAAH/////////8AAAAA//////////4AAAAP//////////gAAAB///////////AAAAf//////////+AAAH///////////8AAA///////n+D//wAAH//+///8fgH//gAB///j///gAAf//AAP//wf//4AAA//+AB//8D///AAAD//8Af//gf//wAAAH//wD//wD//+AAAAP//Af/+Af//gAAAAf/4H//AD//8AAAAA/+A//wAP//gAAAAB/wH/+AB//8AAAAAB8A//AAP//gAAAAAAAH/wAB//+AAAAAAAA/8AAH//wAAAAAAAP/AAA//+AAAAAAAB/wAAH//wAAAAAAAP8AAAf/+AAAAAAAB/gAAD//wAAAAAAAPwAAAf/+AAAAAAAB8AAAB//wAAAAAAANgAAAP/+AAAAAAABgAAAA//wAAAAAAAAAAAAH/+AAAAAAAAAAAAAf/wAAAAAAAAAAAAD/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAH/gAAAAAAAAAAAAAf8AAAAAAAAAAAAAD/wAAAAAAAAAAAAAP+AAAAAAAAAAAAAA/AAAAAAAAAAAAAAH8AAAAAAAAAAAAAAfgAAAAAAAAAAAAAB0AAAAAAAAAAAAAAGAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"cuculus-canorus":{"w":58,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAPgAAAAAAAD/wAAAAAAf//gAAAAAA///AAAAAAAf/+AAAAAAA//4AAAAAAB//wAAAAAAH//AAAAAAAf/+AAAAAAA//4AAAAAAD//wAAAAAAP//gAAAAAAf//AAAAAAB//+AAAAAAH//8AAAAAAf//8AAAAAD///4AAAAAP///wAAAAA////gAAAAD////AAAAAP///+AAAAA////4AAAAD////wAAAAP////gAAAA////+AAAAB////8AAAAH////4AAAAf////gAAAB/////AAAAD////8AAAAP////wAAAAf////gAAAB////+AAAAD////4AAAAH////wAAAAf////AAAAA////8AAAAB////4AAAAD////gAAAAH///+AAAAAP///4AAAAAf///gAAAAA////AAAAAA///8AAAAAB///wAAAAAP///AAAAAB///8AAAAAP///wAAAAA////gAAAAD+P/+AAAAAH8//8AAAAAPj//wAAAAAAP//gAAAAAAf//AAAAAAB//+AAAAAAD//4AAAAAAP//wAAAAAAf//gAAAAAB///AAAAAAD//eAAAAAAP/+8AAAAAAf58wAAAAAB/jwAAAAAAH+DgAAAAAAf4CAAAAAAB/gAAAAAAAH+AAAAAAAAf4AAAAAAAA/gAAAAAAAD+AAAAAAAAP4AAAAAAAA/gAAAAAAAD+AAAAAAAAP4AAAAAAAA/gAAAAAAAD/AAAAAAAAH8AAAAAAAAfwAAAAAAAB/AAAAAAAAH8AAAAAAAAfwAAAAAAAA/AAAAAAAAD8AAAAAAAAPwAAAAAAAAfAAAAAAAAB8AAAAAAAADwAAAAAAAAHAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAA"},"curruca-communis-2":{"w":93,"h":78,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQAAAAAAAAAAAAAA2AAAAAAAAAAAAAAGwAAAAAAAAAAAAABmAAAAAAAAAAAAAANyAAAAAAAAAAAAAB+wAAAAAAAAAAAAAP2AAAAAAAAAAAAAD/0AAAAAAAAAQAAAf+gAAAAAAAOOAAAD/8AAAAAAAHnAAAAf/gAAAAAAD/xgAAH/8AAAAAAD/94AAA//4AAAAAB//+AAAH//AAAAAA///AAAA//4AAAAAf//wAAAH//AAAAAP//4AAAA//4AAAAH//+wAAAH//gAAAD///8AAAB//8AAAA////AAAAP//gAAAf///gAAAB//8AAAP///4AAAAP//gAAH///8AAAAB//4AAD////AAAAAP//wAB////4AAAAB///gAf///+AAAAAP///AP////gAAAAB///8D////wAAAAAP///5////8AAAAAB////f////AAAAAAP////////wAAAAAB////////8AAAAAAP///////+AAAAAAB////////gAAAAAAH///////4AAAAAAA///////8AAAAAAAP///////gAAAAAAP///////8AAAAAAD////////gAAAAAA////////8AAAAAAP////////wAAAAAD////////8AAAAAD/////////wAAAAA/////////+AAAAAAf////////wAAAAAB////////+AAAAAAD////////wAAAAAAP///////8AAAAAAA////////gAAAAAAD///////8AAAAAAAP///////AAAAAAAA///////4AAAAAAAB///////AAAAAAAAH//////4AAAAAAAAf//////wAAAAAAAB///////gAAAAAAAH///////AAAAAAAAP//////+AAAAAAAA///////8AAAAAAAB///////8AAAAAAAD///////4AAAAAAAD///+f//4AAAAAAAP//8A///4AAAAAAB///AD///wAAAAAAZ/x4AH///wAAAAADHmAAAf///gAAAAAccIAAA////AAAAAB7gAAAD///4AAAAAHPAAAAH+AAAAAAAAAgAAAAfwAAAAAAAAAAAAAA/AAAAAAAAAAAAAAD8AAAAAAAAAAAAAAHgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"curruca-communis":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/gAAAAAAAAAAAAB//AAAAAAAAAAAAAf/+AAAAAAAAAAAAH//4AAAAAAAAAAAD///gAAAAAAAAAAD///+AAAAAAAAAAA////wAAAAAAAAAAB////AAAAAAAAAAAD///8AAAAAAAAAAAP///wAAAAAAAAAAB////AAAAAAAAAAAH////AAAAAAAAAAA/////AAAAAAAAAAD////+AAAAAAAAAAf////8AAAAAAAAAD/////4AAAAAAAAAP/////gAAAAAAAAB//////AAAAAAAAAP/////8AAAAAAAAB//////wAAAAAAAAP//////AAAAAAAAA//////+AAAAAAAAD//////8AAAAAAAAf//////wAAAAAAAD///////gAAAAAAAP//////+AAAAAAAB///////4AAAAAAAH///////gAAAAAAAf//////+AAAAAAAB///////4AAAAAAAH///////gAAAAAAAf//////8AAAAAAAD///////wAAAAAAAP///////gAAAAAAA///////+AAAAAAAB///////8AAAAAAAH///////wAAAAAAAP///////AAAAAAAA///////oAAAAAAAH//////+AAAAAAAA///////4AAAAAAAPH//////AAAAAAABwf/////wAAAAAAAGDB//D//AAAAAAAAgYCIAH/8AAAAAAAGAAZAAH/wAAAAAAAAABIAAH/AAAAAAAAAAFAAAH8AAAAAAAAAAwAAAfwAAAAAAAAAOAAAB/gAAAAAAAABgAAAH+AAAAAAAAAYAAAAf4AAAAAAAAGAAAAB/gAAAAAAABgAAAAH+AAAAAAAAYAAAAAP8AAAAAAAGAAAAAA/wAAAAAAAgAAAAAD/AAAAAAAMAAAAAAP8AAAAAADAAAAAAA/wAAAAA54AAAAAAD/AAAAAA/+AAAAAAP4AAAAD/hoAAAAAAfgAAAB5wAAAAAAABwAAAAIcAAAAAAAAAAAAAAGAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"curruca-curruca-2":{"w":80,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQgAAAAAAAAAAAGIAAAAAAAAAAABiAAAAAAAAAAAG5wAAAAIAAAAABvcAAAADgAAAAAb3AAAAAcAAAAAH9wAAAAHwAAAAB/cAAAAY+AAAACf/gAAADn4AAAA3/4AAAAe/gAAAP/+AAAAH38AAAD//gAAAA//wAAC//4AAABH/+AAA///AAAAcf/4AAP//wAAAD///AAD//8AAAAf//4AA///AAAAD///gA///wAAAAP//8AP//8AAAA////gD///gAAAH///8A///4AAAA////gf//+AAAAH///+P///gAAAAf///x///4AAAAH///+///+AAAAD////////gAAAAf///////4AAAAD///////+AAAAAf///////gAAAAP///////4AAAAB///////+AAAAAP///////gAAAAB///////4AAAAAf//////+AAAAAD///////gAAAAAf///////8AAAAD////////wAAAAf///////+AAAAB////////wAAAAf///////+AAAAH////////wAAAB/////////gAAAf////////+AAAH///////g8AAAB///////AIAAAAf//////AEAAAAH//////wCAAAAB//////4AAAAAAf/////+AgAAAAH//////gAAAAAB//////4AAAAAAP/////+AAAAAAD//////gAAAAAA//////4AAAAAAH/////+AAAAAAA//////IAAAAAAH/////0AAAAAAAx////+AAAAAAAA/////AAAAAAAAP////gAAAAAAAH////wAAAAAAAD////4AAAAAAAA////4AAAAAAAAf///8AAAAAAAAH///+AAAAAAAAD////kAAAAAAAA/////gAAAAAAAf////4AAAAAAAP////2AAAAAAAD///j5gAAAAAAB//vBuwAAAAAAA/+AA3MAAAAAAAf/AAZ2AAAAAAAP/wAEIAAAAAAAH/4AAEAAAAAAAD/+AAAAAAAAAAB//AAAAAAAAAAA//wAAAAAAAAAAf/4AAAAAAAAAAP/+AAAAAAAAAAH//AAAAAAAAAAB//gAAAAAAAAAA//4AAAAAAAAAAf/8AAAAAAAAAAP7/AAAAAAAAAAD8/gAAAAAAAAAA8HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"curruca-curruca":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAD/8AAAAAAAAAAAAB//4AAAAAAAAAAAA///gAAAAAAAAAAAP//+AAAAAAAAAAAD///4AAAAAAAAAAA////8AAAAAAAAAAP////4AAAAAAAAAD////+AAAAAAAAAA////8AAAAAAAAAAH////AAAAAAAAAAB////4AAAAAAAAAAf///+AAAAAAAAAAP////wAAAAAAAAAH////+AAAAAAAAAB/////gAAAAAAAAA/////8AAAAAAAAAf/////gAAAAAAAAH/////4AAAAAAAAB//////AAAAAAAAA//////4AAAAAAAAP//////AAAAAAAAD//////4AAAAAAAA///////AAAAAAAAP//////4AAAAAAAD///////AAAAAAAB///////4AAAAAAAf///////AAAAAAAH///////4AAAAAAB///////+AAAAAAAf///////wAAAAAAH///////+AAAAAAB////////gAAAAAAf///////4AAAAAAH////////AAAAAAA////////wAAAAAAP///////8AAAAAAD////////AAAAAAA////////4AAAAAAH///////+AAAAAAB////////gAAAAAAP///////4AAAAAAD///////+AAAAAAA////////gAAAAAAP///////4AAAAAAD///////+AAAAAAA////////AAAAAAAO///////wAAAAAADP//////4AAAAAAAz///////AAAAAAAA///////8AAAAAAAP///////wAAAAAAD///P//efAAAAAAA5//wH4DjwAAAAAAAP/8A+A4eAAAAAAAD/+ADwFHgAAAAAAAf/AAHAl4AAAAAAAH/gAAcEbAAAAAAAB/wAABwAYAAAAAAAf8AAADAGAAAAAAAH/AAAAMAAAAAAAAB/wAAAAwAAAAAAAAf+AAAADgAAAAAAAH/gAAAAOAAAAAAAA/4AAAAD4AAAAAAAP+AAAAD/gAAAAAAD/gAAADweAAAAAAA/8AAAA0B4AAAAAAP/AAAAEAeAAAAAAB/wAAAAgDwAAAAAAf8AAAACD8AAAAAAH/gAAAACPAAAAAAA/4AAAAAP4AAAAAAP+AAAAAADAAAAAAD/gAAAAAAQAAAAAAf4AAAAAAEAAAAAAD/AAAAAAAAAAAAAA/wAAAAAAAAAAAAAH8AAAAAAAAAAAAAA8AAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"cyanistes-caeruleus-2":{"w":91,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAABhgAAAAAAAAAAAAA44AAAAAAAAAAAAAOOAAAAAAAAAAAADHngAAAAAAAAAAAA594AAAAAAAAAAAAef+AAAAAAAAAAAAHv/gAAAAAAAAAAAB//4AAAAAAAAAAAA//+AAAAAAAAAAAHP//gAAAAAAAAAAB7//4AAAAAAAAAAA+//+AAAAAAAAAAAP///gAAAAAAAAAAD///4AAAAAAAAAAAf//8AAAAAAAAAABv///AAAAAAAAAAA////wAAAAAAAAAAP///8AAAAAAAAAAD///+AAAAAAAAAAA////gAAAAAAAAAA////4AAAAAAAAAAf///+AAAAAAAAAAH////gAAAAAAAAAB////wAAAAAAAAAAf///8AAAAAAAAAAP////AAAAAAAAAAH////wAAAAAAAAAB////4AAAAAAAAAAf///8AAwAAAAAAAH////AP/AAAAAAAD////gf/wAAAAAAB////wf/+AAAAAAA////8f//gAAAAAAf///////wAAAAAAH///////8AAAAAAH///////+AAAAAAB////////gAAAAAA////////wAAAAAAf///////4AAAAAAP///////8AAAAAAD///////8AAAAAAB////////AAAAAAA////////wAAAAAAP///////4AAAAAAH///////AAAAAAAD///////gAAAAAAAf//////gAAAAAAAP//////gAAAAAAAB//////4AAAAAAAAX//////AAAAAAAAA//////4AAAAAAAAf/////+AAAAAAAAP//////gAAAAAAAP//////4AAAAAAAH//////+AAAAAAAD///////AAAAAAAB///////wAAAAAAA///////8AAAAAAAf///////AAAAAAAf///////gAAAAAAP///////4AAAAAAH///////+AAAAAAH////////gAAAAAH////////4AAAAAH////////+AAAAAH/////////AAAAAH/////////wAAAAP///3/////8AAAAP//53//////AAAAP/8Azv/////wAAAP/8Ajg/////8AAAP/8ADgC/////AAAP/8AAAAC////wAAP/8AAAAAf///8AAP/+AAAAAH///+AAf/+AAAAAB////gAf/+AAAAAAP//94AP/+AAAAAAD///OAP//AAAAAAA///zgH//AAAAAAAD+98cA//AAAAAAAB3veAAB/AAAAAAAAb3ngAA/AAAAAAAAE554AAHAAAAAAAAAOcOAADAAAAAAAAADHDAAAAAAAAAAAAAhgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"cyanistes-caeruleus":{"w":93,"h":69,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAP//gAAAAAAAAAAAD///AAAAAAAAAAAA///8AAAAAAAAAAAP///wAAAAAAAAAAD////AAAAAAAAAAAf///8AAAAAAAAAAH////wAAAAAAAAAA/////AAAAAAAAAAH////+AAAAAAAAAB/////8AAAAAAAAA//////wAAAAAAAAP//////gAAAAAAAAf/////+AAAAAAAAAf/////8AAAAAAAAD//////wAAAAAAAAf//////AAAAAAAAB//////8AAAAAAAAP//////wAAAAAAAB///////AAAAAAAAH//////8AAAAAAAA///////4AAAAAAAH///////gAAAAAAA///////+AAAAAAAH///////8AAAAAAAf///////wAAAAAAD////////AAAAAAAf///////8AAAAAAB////////wAAAAAAP///////+AAAAAAA////////4AAAAAAD////////AAAAAAAf///////8AAAAAAB////////4AAAAAAH////////gAAAAAA////////+AAAAAAD////////4AAAAAAP////////wAAAAAA/////////AAAAAAD////////8AAAAAAH////////wAAAAAAP////+Zv/AAAAAAA/////AAf+AAAAAP/////gAA/8AAAAD/h///wAAD/4AAAAfOB//4AAAH/gAAAHweAfgAAAAP/AAAAsA4B4AAAAA/+AAABgDA+AAAAAB/4AAAMAIOAAAAAAD/wAAAgAHAAAAAAAP/AAACADgAAAAAAAf8AAAAB4AAAAAAAA/AAAAA+AAAAAAAADwAAAA/fwAAAAAAAGAAAAPwPAAAAAAAAAAAAB8AMAAAAAAAAAAAATgAgAAAAAAAAAAACcAAAAAAAAAAAAAADAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAgAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"cygnus-olor-2":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAGAAAAAAAAAAAAAADwAAAAAAAAAAAAAA8AAAABgAAAAAAAAfgAAAAOAAAAAAAAH8AAAAB8AAAAAAAD/AAAAMfwAAAAAAA/4AAAAH/AAAAAAAP/AAAAC/8AAAAAAD/wAAAA//4AAAAAB/+AAAAC//wAAAAAf/gAAAAP//AAAAAD/8AAAAB///AAAAB//gAAAAP//8AAAAf/4AAAAAf//wAAAD//AAAAAD///gAAA//wAAAAAP//+AAAP/8AAAAAA///8AAB//gAAAAAD///4AAf/8AAAAAAf///gAD//AAAAAAB///+AA//4AAAAAAD///4AP//AAAAAAAf///AD//wAAAAAAA///8A//4AAAAAAAD///gf/+AAAAAAAAH//+H//gAAAAAAAA///x//8AAAAAAAAH///P//gAAAAAAAAf//7//+H/gAAAAAD//////7///wAAAAf//////////AAAAB//////////+AAAAP//////+Af/4AAAB///////gA//AAAAP//////4AA/8AAAA///////AAAf4AAAH//////4AAADgAAA///////AAAAAAAAD//////8AAAAAAAAP//////gAAAAAAAA//////+AAAAAAAAD//////wAAAAAAAAP/////+AAAAAAAAB//////wAAAAAAAAP/////8AAAAAAAAB//////gAAAAAAAAf/////4AAAAAAAAH/////8AAAAAAAAB/////8AAAAAAAAA/////AAAAAAAAAAP////gAAAAAAAAAD////wAAAAAAAAAA////4AAAAAAAAAAf///4AAAAAAAAAAH///wAAAAAAAAAAB///4AAAAAAAAAAAP/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAPv4AAAAAAAAAAAADw8AAAAAAAAAAAAAIOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"cygnus-olor":{"w":82,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAD/AAAAAAAAAAAAf+AAAAAAAAAAAD/8AAAAAAAAAAAP/wAAAAAAAAAAB//gAAAAAAAAAAH/+AAAAAAAAAAAf/4AAAAAAAAAAD//gAAAAAAAAAAf/+AAAAAAAAAAB//4AAAAAAAAAAH//gAAAAAAAAAAP/+AAAAAAAAAAA//4AAAAAAAAAAH7/AAAAAAAAAAAfP8AAAAAAAAAAD4/wAAAAAAAAAAfD/AAAAAAAAAAD4P8AAAAAAAAAAPA/wAAAAAAAAAA4H+AAAAAAAAAAAAe4AAAAAAAAAAABxgAAAAAAAAAAAHCAAAAAAAAAAAAYAAAAAAAAAAAADgAAAAAAAAAAAAOAAAAAAAAAAAAA4AAAAAAAAAAAADAAAAAAAAAAAAAMAAAAAAAAAAAAAwAAAAAAAAAAAADAAAAAAAAAAAAAMAAAAAAAAAAAAAwAAAAAAAAAAAADAAAAAAAAAAAAAMAAAAAAAAAAAAAwAAAAAAAAA/8ADAgAAAAAAB///gMCAAAAAAAf///gwIAAAAAAf////jhwAAAAP//////uPAAAAD///////48AAAA////////n4AAAH///////+fgAAAP///////9/AAAA/////////8AAAD/////////4AAH//////////gAA///////////AAT//////////+AB///////////4AH///////////wAf///////////gA////////////AB+f/////////8AP8//////////4Afx//////////wAfD//////////AAeH/////////+AAMH/////////4AAYH/////////gAAYH/////////AAAwN////////8AABhz////////wAAH/H////////AAAP+f/B/////8AAAf8/4B/////gAAA/z/gB////+AAAA/v8AH////4AAAA//wAf////AAAAD//wA////4AAAAP////////AAAAAf///////4AAAAA///////+AAAAAAH//+A//gAAAAAAP//4H//AAAAAAA///A//+AAAAAAA//4H//+AAAAAAB//g///4AAAAAAH/+D//wAAAAAAAf/wAP8AAAAAAAB//AAHgAAAAAAAD/+AAEAAAAAAAAP8AAAAAAAAAAAAfgAAAAAAAAAAAA4AAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"delichon-urbicum-2":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAGAAAAAAAAAAAAAAcAAAAAAAAAAAAAB+AAAAAAAAAAAAAD8AAAAAAAAAAAAAP4AAAAAAAAAAAAAfwAAAAAAAAAAAAB/gAAAAAAAAAAAAD/AAAAAAAAAAAAAH/AAAAAAAAAAAAAP+AAAAAAAAAAAAAf+AAAAAAAAAAAAA/8AAAAAAAAAAAAB/4AAAAAAAAAAAAD/4AAAAAAAAAAAAH/wAAAAAAAAAAAAP/gAAAAAAAAAAAAf/AAAAAAA8AAAAA//AAAAAAf4AAAAB//AAAAAH/AAAAAD/+AAAAB//AAAAAH/8AAAAP/+AAAAAP/8AAAB//4AAAAAf/4AAAP//gAAAAA//4AAB//+AAAAAB//wAAP//+AAAAAD//gAA///4AAAAAD//wAH///wAAAAAH//wA////AAAAAAP//wH///+AAAAAAf//4f///8AAAAAAf//9////wAAAAAA////////gAAAAAA////////AAAAAAB///////+AAAAAAB///////4AAAAAAB///////gAAAAAAA//////+AAAAAAAAP/////4AAAAAAB/v/////gAAAAAAH///////AAAAAAAf//////8AAAAAAAf//////4AAAAAAA///////8AAAAAAB///////4AAAAAAH///////8AAAAAAA///////8AAAAAAAf//////8AAAAAAAP//////4AAAAAAAH//////8AAAAAAAD//////8AAAAAAAB//////4AAAAAAAAf/////wAAAAAAAAP/////wAAAAAAAAP/////wAAAAAAAAH/////gAAAAAAAAD/////gAAAAAAAAB/////wAAAAAAAAA/////8AAAAAAAAAP////8AAAAAAAAAH////+AAAAAAAAAB/////gAAAAAAAAAP////4AAAAAAAAAD////+AAAAAAAAAA/////gAAAAAAAAA/////4AAAAAAAAA/4B//+AAAAAAAAAHwAP//gAAAAAAAAAAAP//4AAAAAAAAAAAH/x+AAAAAAAAAAAD/4DwAAAAAAAAAAB/8AcAAAAAAAAAAA/+ACAAAAAAAAAAAfDAAAAAAAAAAAAAPhgAAAAAAAAAAAAPgwAAAAAAAAAAAAHwMAAAAAAAAAAAADwGAAAAAAAAAAAAB4DAAAAAAAAAAAAA4AwAAAAAAAAAAAAcAYAAAAAAAAAAAAMAMAAAAAAAAAAAAGACAAAAAAAAAAAADABAAAAAAAAAAAABgAAAAAAAAAAAAAAwAAAAAAAAAAAAAAIAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"delichon-urbicum":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH/AAAAAAAAAAAAAD/+AAAAAAAAAAAAA//4AAAAAAAAAAAAP//gAAAAAAAAAAAP//+AAAAAAAAAAAH///4AAAAAAAAAAAH///AAAAAAAAAAAAP//8AAAAAAAAAAAA///4AAAAAAAAAAAH///wAAAAAAAAAAAf///gAAAAAAAAAAD////AAAAAAAAAAAP///+AAAAAAAAAAB////4AAAAAAAAAAP////wAAAAAAAAAB/////AAAAAAAAAAf////+AAAAAAAAAD/////4AAAAAAAAAP/////gAAAAAAAAB/////+AAAAAAAAAP/////8AAAAAAAAB//////4AAAAAAAAP//////gAAAAAAAA//////+AAAAAAAAH//////8AAAAAAAAf//////wAAAAAAAD///////AAAAAAAAP//////8AAAAAAAA///////4AAAAAAAD///////gAAAAAAAP///////AAAAAAAA///////+AAAAAAAD///f///8AAAAAAAP//w////wAAAAAAA//+B////wAAAAAAB//gB////gAAAAAAH/8AB////AAAAAAAP/gAB///+AAAAAAA/wAAB///8AAAAAAH+AAAG//zwAAAAAB2AAGAYf/AAAAAAAMY4/ABw/+AAAAAABv/kAAHwP8AAAAAAH/DgAAfAHwAAAAAA8wAAAB/AAAAAAAADjAAAAH8AAAAAAAAMYAAAAfwAAAAAAAA3AAAAB/AAAAAAAAGgAAAAD+AAAAAAAAAAAAAAP4AAAAAAAAAAAAAA/gAAAAAAAAAAAAAD+AAAAAAAAAAAAAAPMAAAAAAAAAAAAAA4wAAAAAAAAAAAAADjAAAAAAAAAAAAAAGGAAAAAAAAAAAAAAYYAAAAAAAAAAAAABggAAAAAAAAAAAAAGDAAAAAAAAAAAAAAYMAAAAAAAAAAAAAAgQAAAAAAAAAAAAADAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAwAAAAAAAAAAAAAADAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAQAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"dendrocopos-major-2":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAADAAAAAAAAAAAAAAAOIAAAAAAAAAAAAAw5gAAAAAAAAAAAADnmAAAAAAAAAAAAAPeYAAAAAAAAAAAAA9/gAAAAAAAAAAABz/+AAAAAAAAAAAAHv/4AAAAAAAAAAAAf//gAAAAAAAAAAAA//+AAAAAAAAAAAAD//4AAAAAAAAAAAHv//wAAAAAAAAAAAf///AAAAAAAAAAAA///8AAAAAAAAAAAD///4AAAAAAAAAAB////gAAAAAAAAAAH///+AAAAAAAAAAAP///4AAAAAAAAAAA////wAAAAAAAAAAP////AAAAAAAAAAA////8AAAAAAAAAAD////wAAAAAAAAAAP///+AAfAAAAAAAA////wAP/AAAAAAAD////AD/8AAAAAAAf///4A//wAAAAAAB////gP//+AAAAAAP///8D///+AAAAAB////w///+AAAAAAP///////8AAAAAAB///////+AAAAAAAH///////AAAAAAAB///////gAAAAAAAH//////4AAAAAAAAf/////+AAAAAAAAD//////gAAAAAAAAP/////8AAAAAAAAB//////AAAAAAAAAP/////+AAAAAAAAA///////4AAAAAAAH///////wAAAAAAAP///////gAAAAAAAP///////AAAAAAAAf//////+AAAAAAAH///////8AAAAAAA////////4AAAAAAP////////wAAAAAD/////////gAAAAAf/////////gAAAAH//////////AAAAD///////////AAAB//////////+cAAA///////////4AAAH///////////4AAF///////////vwAAf//47//////+fAAB//8Mf//////4AAAP//ADH/////3wAAH//wAwF////fPAAA//+AAAAP//98MAAP//gAAAAf/7jwAAB//8AAAABf3OPAAAP//gAAAABu84IAAD/+gAAAAAAzjgAAAd/mAAAAAACEAAAAHP4AAAAAAAAAAAABj8AAAAAAAAAAAAAYYAAAAAAAAAAAAAAGAAAAAAAAAAAAAABgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"dendrocopos-major":{"w":57,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAH/wAAAAAAB//gAAAAAAf/+AAAAAAH//4AAAAAB////8AAAAP///+AAAAD///+AAAAAf//+AAAAAD///gAAAAAf//4AAAAAD//+AAAAAAf//gAAAAAD//4AAAAAA///AAAAAAH//4AAAAAB///AAAAAAf//4AAAAAH///gAAAAB///8AAAAAf///gAAAAH///+AAAAB////wAAAAP///+AAAAD////wAAAAf///+AAAAH////wAAAA////+AAAAP////wAAAB////8AAAAP////gAAAD////8AAAAf////gAAAH////8AAAA/////gAAAH////4AAAB/////AAAAP////wAAAB////+AAAAf////gAAAD////8AAAA/////AAAAH////wAAAA////+AAAAP////n4AAB////5/gAAP///+f+AAB////3wQAAf////4AAAD////2AAAAf///4gAAAD////cAAAAf///zAAAAD///8QAAAAf///GAAAAH//+AQAAAA///AAAAAAP//wAAAAABv/+AAAAAAb//wAAAAAC//8AAAAAA3v/AAAAAAF5/wAAAAABOP+AAAAAADh/gAAAAAAYP8AAAAAAAB/gAAAAAAAP8AAAAAAAB/wAAAAAAAP+AAAAAAAB/wAAAAAAAP+AAAAAAAB/gAAAAAAAP+AAAAAAAB/wAAAAAAAP4AAAAAAAD/gAAAAAAAf4AAAAAAAD/AAAAAAAAf4AAAAAAAD8AAAAAAAA/AAAAAAAAHwAAAAAAAAsAAAAAAAANAAAAAAAABYAAAAAAAASAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"egretta-garzetta-2":{"w":77,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAADAAAAAAAAAAAAeAAAAA2wAAAAD4AAAABtiAAAAP3AAAADbMgAAB/8AAAAH+ZAAAP/4AAAAP/+AAA//8AAAAf/9AAH//4AAAA//+AAf//gAAAB//+AD//+AAAAD//+AP//+AAAAH//4B///8AAAAP//4H///wAAAAf//wf///AAAAA///h///+AAAAB///P///4AAAAD//+////wAAAAH///////AAAAAP//////8AAAAA///////4AAAAB///////gAAAAD//////+AAAAAH//////8AAAAAP//////wAAAAAf//////AAAAAA//////8AAAAAB//////wAAAAAB/////8AAAAAAD/////4AAAAAAH/////4AAAAAAH/////wAAAAAAH/////gAAAAAAD/////AAAAAAAH////+AAAAAAAP////8AAAAAAAf////4AAAAAH5/////wAAAAA///////gAAAAH//////+AAAAAf//////8AAAAH///////4AAAB////////wAAAfj3//////AAABgAD/////+AAAAAAP/////4AAAAAA//////wAAAAAD//////AAAAAAH/////+AAAAAAP/////8AAAAAAP/////8AAAAAAP/////8AAAAAAP//////AAAAAAP//////AAAAAAH//////wAAAAAAP////+AAAAAAAD////gAAAAAAAB////AAAAAAAAA////gAAAAAAAAD///gAAAAAAAAB//+AAAAAAAAAA//4AAAAAAAAAAH/AAAAAAAAAAAGYAAAAAAAAAAADMAAAAAAAAAAADMAAAAAAAAAAABsAAAAAAAAAAADIAAAAAAAAAAADYAAAAAAAAAAACQAAAAAAAAAAAGwAAAAAAAAAAAEgAAAAAAAAAAANgAAAAAAAAAAAJAAAAAAAAAAAARAAAAAAAAAAAASAAAAAAAAAAAAiAAAAAAAAAAAAmAAAAAAAAAAABHwAAAAAAAAAABOwAAAAAAAAAAD+AAAAAAAAAAADOAAAAAAAAAAAHOAAAAAAAAAAAHOAAAAAAAAAAAHOAAAAAAAAAAAHOAAAAAAAAAAAHMAAAAAAAAAAAGMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"egretta-garzetta":{"w":65,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAA+AAAAAAAAAH/AAAAAAAAA//wAAAAAAAD//4AAAAAAD///4AAAAAB////8AAAAAfx///MAAAAAAAA//CAAAAAAAA//AAAAAAAAB//AAAAAAAAH//AAAAAAAAP//AAAAAAAAf/+AAAAAAAA//8AAAAAAAB//8AAAAAAAH//8AAAAAAAP//+AAAAAAAf//+AAAAAAA///+AAAAAAB///+AAAAAAD///+AAAAAAH///+AAAAAAP///+AAAAAAf///8AAAAAA////8AAAAAD////8AAAAAH////4AAAAAP////4AAAAAf////4AAAAAf////wAAAAAf////wAAAAA/////gAAAAA/////gAAAAB/////AAAAAB/////AAAAAD/////AAAAAD////+AAAAAD////+AAAAAD////8AAAAAA////8AAAAAAf///4AAAAAAf///wAAAAAAf///wAAAAAAf///wAAAAAAf///AAAAAAAf//+gAAAAAA///8QAAAAAA///4AAAAAAB///4AAAAAAB///4AAAAAAD///wAAAAAACn/+QAAAAAAFn/8AAAAAAAND/4AAAAAAAKA/wAAAAAAASB/wAAAAAAA0B/gAAAAAABsD+AAAAAAADIDwAAAAAAAGYDgAAAAAAAEgAAAAAAAAAZgAAAAAAAAAyAAAAAAAAABEAAAAAAAAACIAAAAAAAAAEQAAAAAAAAAZgAAAAAAAAAjAAAAAAAAABGAAAAAAAAACIAAAAAAAAAMQAAAAAAAAAQgAAAAAAAAAhAAAAAAAAABCAAAAAAAAACEAAAAAAAAAMIAAAAAAAAAYQAAAAAAAAAxgAAAAAAAAH/AAAAAAAAf+P8AAAAAAAH4/AAAAAAAB7TwAAAAAAAOMNAAAAAAAAAjmAAAAAAAAAcIAAAAAAAADAgAAAAAAAAACAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"emberiza-calandra-2":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAGIAAAAAAAAAAAAE5gAAAAAAAAAAAA3MAAAAAAAAAAAAH/wAAAAAAAAAAAA/+YAAAEAAAAAAAH//AAADwAAAAAAA//4AAA+AAAAAAAD//gAAPg4AAAAAAf/8AAD8fAAAAAAD//4AA/3wAAAAAAf//gAP/+AAAAAAB//8AD//hgAAAAAP//wA///8AAAAAB///gP///gAAAAAH//+D///8AAAAAA///wf///AAAAAAD//+H///wAAAAAAf//4////8AAAAAD///v////gAAAAAP///////8AAAAAB////////AAAAAAH///////8AAAAAAf///////4AAAAAD////////AAAAAAf///////4AAAAAB///////+AAAAAAP///////4AAAAAA////////AAAAAAH///////4AAAAAAf//////+AAAAAAB///////4AAAAAAH//////+AAAAAAAf//////wAAAAAPA//////+AAAAAP/z//////gAAAAD////////8AAAAAf////////4AAAAD/////////gAAAA/////////8AAAAP/////////wAAAB//////////gAAAD/////////+AAAAA/////////wAAAAB/////////AAAAAD////////+AAAAAH////////4AAAAAH////////AAAAAAP///////8AAAAAAf///////4AAAAAA////////gAAAAAB///////4AAAAAAH///////gAAAAAAP/////+eAAAAAAAf/////4AAAAAAAB//////wAAAAAAAD//////gAAAAAAAH//////AAAAAAAAP/////+AAAAAAAAf/////8AAAAAAAA//////wAAAAAAAA//////gAAAAAAAB//////AAAAAAAAD/////8AAAAAAAAD/////4AAAAAAAAD/////gAAAAAAAAB/////AAAAAAAAAB////+AAAAAAAAAH////8AAAAAAAAA/8G//4AAAAAAAAD/4A//wAAAAAAAAP4QA//wAAAAAAAAfwAB//gAAAAAAAA/wAH//AAAAAAAAAYAAP/+AAAAAAAAAAAAf/8AAAAAAAAAAAB//4AAAAAAAAAAAD//4AAAAAAAAAAAH//wAAAAAAAAAAAP//gAAAAAAAAAAA///AAAAAAAAAAAB//+AAAAAAAAAAAD/f8AAAAAAAAAAAP8/4AAAAAAAAAAAfw/wAAAAAAAAAAA/AAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"emberiza-calandra":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAD/8AAAAAAAAAAAAP//AAAAAAAAAAAAf//gAAAAAAAAAAB///wAAAAAAAAAAD///+AAAAAAAAAAH////gAAAAAAAAAP////4AAAAAAAAAf////4AAAAAAAAAf////gAAAAAAAAA////8AAAAAAAAAB////4AAAAAAAAAD////4AAAAAAAAAD////4AAAAAAAAAH////4AAAAAAAAAP////wAAAAAAAAA/////wAAAAAAAAD/////wAAAAAAAAH/////gAAAAAAAAf/////gAAAAAAAA//////AAAAAAAAB//////AAAAAAAAH//////AAAAAAAAP//////AAAAAAAAf//////AAAAAAAA///////AAAAAAAB///////AAAAAAAD///////AAAAAAAD///////AAAAAAAH///////AAAAAAAP///////AAAAAAAf///////AAAAAAA///////+AAAAAAB///////+AAAAAAD///////+AAAAAAH///////+AAAAAAH///////8AAAAAAP///////8AAAAAAf///////4AAAAAAf///////wAAAAAA////////wAAAAAB////////gAAAAAB////////AAAAAAD////////AAAAAAD///////+AAAAAAH///////8AAAAAAH///////4AAAAAAH///////wAAAAAAH///////AAAAAAAP//////+AAAAAAAf//////8AAAAAAA///////wAAAAAAB///////wAAAAAAH///////8AAAAAAP///////+AAAAAAf//////9+AAAAAA///////5+AAAAAB///////x4AAAAADz///+//j4AAAAACHP/84B/nwAAAAAAGf/4AHPkAAAAAAAMf/gAePgAAAAAAAA//AA4fAAAAAAAAA/+AAn+AAAAAAAAB/4AAz8AAAAAAAAB/4AAB4AAAAAAAAD/wAAAAAAAAAAAAH/wAAAAAAAAAAAAP/gAAAAAAAAAAAAP/AAAAAAAAAAAAAf/AAAAAAAAAAAAA/+AAAAAAAAAAAAA/8AAAAAAAAAAAAB/8AAAAAAAAAAAAD/4AAAAAAAAAAAAD/4AAAAAAAAAAAAH/wAAAAAAAAAAAAP/gAAAAAAAAAAAAP/gAAAAAAAAAAAAf/AAAAAAAAAAAAA/+AAAAAAAAAAAAA/+AAAAAAAAAAAAB/8AAAAAAAAAAAAD/4AAAAAAAAAAAAD94AAAAAAAAAAAAH5wAAAAAAAAAAAAHxgAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"emberiza-citrinella-2":{"w":93,"h":86,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIQAAAAAAAAAAAAADGAAAAAAAAAAAAABzgAAAAAAAAAAAAAc4AAAAAAAAAAAAAH/MAAAAAAAAAAAAD/3AAAAAAAAAAAAA//wAAAAAAAAAAAAP/8AAAAAAAAAAAAH//IAAAAAAAAAAAB//3AAAAAAAAAAAAf//wAAAAAAAAAAAH//8AAAAAAAAAAAD//+AAAAAAAAAAAA///8AAAAAAAAAAAP///AAAAAAAAAAAD///4AAAAAAAAAAA///+AAAAAAAAAAAf///gAAAAAAAAAAH///8AAAAAAAAAAB////AAAAAAAAAAAf///wAAAAAAAAAAH///8AAAAAAAAAAB////gAAAAAAAAAAf///4AAAAAAAAAAD///+AAAAAAAAAAA////gAAAAAAAAAAH///8AAAAAAAB/gB////AAAAAAAA//AP///gAAAAAAAP/8D///4AAAAAAAD//w///+AAAAAAAD///////wAAAAAAAf//////+AAAAAAAAf//////wAAAAAAAB//////+AAAAAAAAP//////wAAAAAAAA//////+AAAAAAAAD//////wAAAAAAAAP/////+AAAAAAAAB//////wAAAAAAAAH/////+AAAAAAAAA//////gAAAAAAAAP/////8AAAAAAAA///////gAAAAAAAf//////4AAAAAAAH/////9+AAAAAAAD//////ggAAAAAAA//////+AAAAAAAAP//////wAAAAAAAD///////AAAAAAAA///////4AAAAAAAP///////gAAAAAAD///////8AAAAAAA////////wAAAAAAP///////+AAAAAAD////////wAAAAAA/////////AAAAAAP////////4AAAAAD/////////gAAAAA//////v9/8AAAAAP/////xuH/wAAAAD/////AEwf/AAAAB////wAAzB/8AAAAf///4AADAP/wAAAH///+AAAAB//AAAB////gAAAAH/8AAAf///wAAAAA//wAAHP//8AAAAAD//AAAD3/7AAAAAAf/8AAA97uAAAAAAD//wAAOe5gAAAAAAP//AADHmYAAAAAAB//8AAAxgAAAAAAAH8/wAAAAAAAAAAAA/gfAAAAAAAAAAAAD4A4AAAAAAAAAAAAfAAAAAAAAAAAAAAD4AAAAAAAAAAAAAAOAAAAAAAAAAAAAABwAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"emberiza-citrinella":{"w":93,"h":71,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAH/gAAAAAAAAAAAAD//AAAAAAAAAAAAA//8AAAAAAAAAAAAf//wAAAAAAAAAAAf///AAAAAAAAAAAH///8AAAAAAAAAAAP///wAAAAAAAAAAAf//+AAAAAAAAAAAD///4AAAAAAAAAAAf///gAAAAAAAAAAB///+AAAAAAAAAAAP///8AAAAAAAAAAB////4AAAAAAAAAAP////gAAAAAAAAAA/////AAAAAAAAAAH////8AAAAAAAAAA/////4AAAAAAAAAH/////gAAAAAAAAA/////+AAAAAAAAAH/////4AAAAAAAAA//////gAAAAAAAAH/////+AAAAAAAAA//////4AAAAAAAAH//////gAAAAAAAA//////+AAAAAAAAH//////4AAAAAAAA///////gAAAAAAAD//////+AAAAAAAAf//////4AAAAAAAD///////gAAAAAAAP//////+AAAAAAAB///////4AAAAAAAH///////AAAAAAAA///////8AAAAAAAD///////wAAAAAAAP///////AAAAAAAB///////4AAAAAAAH///////AAAAAAAAf//////8AAAAAAAB///////wAAAAAAAH///////AAAAAAAAP//////8AAAAAAAA///////wAAAAAAAB///////AAAAAAAAD//////8AAAAAAAAH//////gAAAAAAAAP//////AAAAAAAA////j//8AAAAAAAP///gA//4AAAAAAH/+fgAA//gAAAAAA/gcAAAA//AAAAAA/+AgAAAA/8AAAAAP4PAAAAAB/4AAAAD8AcAAAAAH/gAAAA2AAAAAAAAP/AAAAIgAAAAAAAA/8AAAAIAAAAAAAAD/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAAf/AAAAAAAAAAAAAA/8AAAAAAAAAAAAAD94AAAAAAAAAAAAAP3gAAAAAAAAAAAAAfAAAAAAAAAAAAAAB4AAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"emberiza-schoeniclus-2":{"w":91,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAA8AAAAAAAAAAAAAOPgAAAAAAAAAAAAHz8AAAAAAAAAAAAB//gAAAAAAAAAAAAP/8AAAAAAAAAAABz//gAAAAAAAAAAAf//4AAAAAAAAAAAH///AAAAAAAAAAAB///4AAAAAAAAAAAf//+AAAAAAAAAAB////wAAAAAAAAAAf///8AAAAAAAAAAD////gAAAAAAAAAAf///4AAAAAAAAAA/////AAAAAAAAAAP////wAAAAAAAAAD////+AAAAAAAAAAf////gAAAAAAAAAP////4AAAAAAAAAH/////AAAAAAAAAA/////wAB+AAAAAAP////8AD/4AAAAAD////+AH/+AAAAAA/////gH//gAAAAAP////wP//8AAAAAH////8P///AAAAAB////+P///wAAAAAf////P///4AAAAAH////////AAAAAAD////////AAAAAAB////////gAAAAAA////////gAAAAAAP///////gAAAAAAH///////gAAAAAAD///////wAAAAAAB///////wAAAAAAA///////4AAAAAAAf//////8AAAAAAAP//////+AAAAAAAD//////+AAAAAAAB///////AAAAAAAA///////gAAAAAAAP//////8AAAAAAAH///////gAAAAAAD///////4AAAAAAA///////+AAAAAAAP///////gAAAAAAA9//////4AAAAAAAB//////8AAAAAAAA///////AAAAAAAA///////gAAAAAAAf//////4AAAAAAAP//////8AAAAAAAH///////AAAAAAAH///////gAAAAAAD///////4AAAAAAD///////8AAAAAAB////////AAAAAAB////////wAAAAAA////////4AAAAAA////////+AAAAAA/////////AAAAAA/////////wAAAAAf////////4AAAAAf/5//////+AAAAAf/4eP/////AAAAAf/wGOz////wAAAAf/4AcYP///4AAAAf/8AIcA///+AAAAf/8AI8AP///AAAAf/8AA8AB///wAAAf/+AAAAAf//4AAAf/+AAAAAP//8AAAf//AAAAAD///AAAf//AAAAAAf//gAAf//gAAAAAH//4AAf//gAAAAAD//8AAf//wAAAAAA//+AAf//wAAAAAAL//gAP//4AAAAAAA/9wAA//4AAAAAAAd/YAAAf8AAAAAAAG7sAAAP8AAAAAAAANzAAAD+AAAAAAAAHcAAAA+AAAAAAAABmAAAAPAAAAAAAAABAAAADAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"emberiza-schoeniclus":{"w":93,"h":70,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAH/gAAAAAAAAAAAAD//AAAAAAAAAAAAA//+AAAAAAAAAAAAP//4AAAAAAAAAAAP///gAAAAAAAAAAH///+AAAAAAAAAAB////4AAAAAAAAAAD////AAAAAAAAAAAD///8AAAAAAAAAAAP///4AAAAAAAAAAB////4AAAAAAAAAAP////wAAAAAAAAAB/////wAAAAAAAAAP/////AAAAAAAAAA/////+AAAAAAAAAH/////8AAAAAAAAA//////wAAAAAAAAH//////gAAAAAAAA///////AAAAAAAAH//////8AAAAAAAA///////4AAAAAAAH///////gAAAAAAA////////AAAAAAAH///////8AAAAAAAf///////wAAAAAAD////////AAAAAAAf///////8AAAAAAB////////gAAAAAAP///////+AAAAAAA////////8AAAAAAH////////wAAAAAAf////////AAAAAAB////////8AAAAAAH////////wAAAAAAf///////+AAAAAAB////////4AAAAAAD////////wAAAAAAP////////gAAAAAAf////////AAAAAAA/////H//+AAAAAAB////gA//8AAAAAAB///gAA//4AAAAAAA//gAAD//wAAAAAAHwgAAAH//gAAAAAH5EAAAAP//AAAAAB/8gAAAA//8AAAAAeD8AAAAB//4AAAAHgPAAAAAH//gAAAA4DkAAAAAP/8AAAAGA4AAAAAAf7AAAAAwcAAAAAAB/AAAAAEHAAAAAAAD8AAAAABwAAAAAAAPgAAAAA4AAAAAAAAAAAAAAPgAAAAAAAAAAAAAH/8AAAAAAAAAAAAP8DQAAAAAAAAAAAD/AAAAAAAAAAAAAAGQAAAAAAAAAAAAABmAAAAAAAAAAAAAA5gAAAAAAAAAAAAAMMAAAAAAAAAAAAACBAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"eremophila-alpestris-2":{"w":93,"h":71,"bits":"AAAAAAAAAAAAAAAIAAAAAAAAAAAAABGAAAAAAAAAAAAAA7wAAAAAAAAAAAAAf8AAAAAAAAAAAAAH/wAAAAAAAAAAAAD/8AAAAAAAAAAAAB//AAAAAAAAAAAAAf/wAAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAB//+AAAAAAAAAAAAf//gAAAAAAAAAAAP//4AAAAAAAAAAAD//+AAAAAAAAAAAA///wAAAAAAAAAAAf//8AAAAAAAAAAAH///AAAAAAAAAAAD///wAAAAAAAAAAA///8AAAAAAAAAAAf///gAAAAAAAAAAH///4AAAAAAAAAAB///+AAAAAAAAAAAf///gAAAAAAAAAAH///4AAAAAAAAAAB///+AAAAAAAAAAAP///gAAAAAAACYAD///wAAAAAAAA2AAf//8AAAAAAAAP8AH///AAAAAAAAD/8B///4AAAAAAAA//wP///AAAAAAAAP//z///4AAAAAAAP///////AAAAAAAB///////4AAAAAAAA///////AAAAAAAAD//////4AAAAAAAAP//////AAAAAAAAA//////4AAAAAAAAH//////AAAAAAAAAf/////4AAAAAAAB//////+AAAAAAAA///////wAAAAAAAf//////+AAAAAAAH///////gAAAAAAD///////AAAAAAAA///////8AAAAAAAf///////wAAAAAAH////////AAAAAAD////////8AAAAAB/////////gAAAAAf////////+AAAAAP/////////4AAAAD//////////gAAAA//////////8AAAAf//////////wAAAH///+AQAP///AAAB////AAAAH//+AAA////gAAAAPn/4AAP///wAAAAB8P/gAH///wAAAAAPA/+AAH//4AAAAADwD/4AB7zgAAAAAAf4P/wAAIQAAAAAAH6A//AAAAAAAAAAA/AD/8AAAAAAAAAAD+AP/4AAAAAAAAAAf8A//gAAAAAAAAAB/wD5+AAAAAAAAAADgAfAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAYAAA=="},"eremophila-alpestris":{"w":93,"h":73,"bits":"AAAAAAAAAAAAAAAAACQAAAAAAAAAAAAAA8AAAAAAAAAAAAAAPAAAAAAAAAAAAAAD/AAAAAAAAAAAAAA//AAAAAAAAAAAAAP/+AAAAAAAAAAAAD//4AAAAAAAAAAAD///gAAAAAAAAAAD///+AAAAAAAAAAAf///wAAAAAAAAAAAP///AAAAAAAAAAAA///8AAAAAAAAAAAH///gAAAAAAAAAAA///+AAAAAAAAAAAD///wAAAAAAAAAAAf///gAAAAAAAAAAD////gAAAAAAAAAAf////AAAAAAAAAAD/////AAAAAAAAAAf////+AAAAAAAAAD/////8AAAAAAAAAf/////4AAAAAAAAD//////gAAAAAAAAf//////AAAAAAAAD//////8AAAAAAAAf//////4AAAAAAAD///////gAAAAAAAf//////+AAAAAAAB///////4AAAAAAAP///////wAAAAAAB////////AAAAAAAP///////8AAAAAAA////////4AAAAAAH////////gAAAAAAf///////+AAAAAAD////////4AAAAAAP////////wAAAAAA/////////AAAAAAH////////+AAAAAAf////////4AAAAAB/////////gAAAAAH/////////AAAAAAf/////////AAAAAB/////////+AAAAAD/////////8AAAAAP/////////4AAAAAf///////f/wAAAAA///////8//gAAAAB////+Afw//AAAAAD///8AAOB/+AAAAAD//+AAAAD/8AAAAAB//wAAAAH/wAAAAAYH8AAAAAP4AAAAAOAPAAAAAAfAAAAAHADgAAAAAAwAAAADgAwAAAAAAAAAAAB9AcAAAAAAAAAAAB8cGAAAAAAAAAAAAzgDgAAAAAAAAAAAEoAwAAAAAAAAAAAANAOAAAAAAAAAAAABYH/gAAAAAAAAAAARPwCAAAAAAAAAAACDeAAAAAAAAAAAAAAigAAAAAAAAAAAAABkAAAAAAAAAAAAAAIgAAAAAAAAAAAAACGAAAAAAAAAAAAAAgYAAAAAAAAAAAAAEAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAA"},"erithacus-rubecula-2":{"w":84,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAABAAACDAAAAAAAAjGAABjgAAAAAAAzGAABxwAAAAAAB3OAAA54AAAAAAJ3OAAI+8AAAAAAJ3eAAGfeAAAAAAZ/+AAHP/gAAAAAf/+AADn/wAAAACf/8AAB//4AAAAD//8AAB//8AAAAH//8AAGf/+AAAAH//8AAHf//AAAAf//8AAD///gAAA///8AAB///wAAA///8AAA///4AAA///4AAAf//8AAD///4AADv//+AAD///4AAB////AAH///4AAB////gAH///4AAA////wAP///wAAAf///4AP///wAAA////8AP///wAAA/////AP///gAAAf////g////gAAAP////w////gAAAH////5////AAAAH/////////AAAAH/////////AAAAD////////+AAAAB////////+AAAAA/////////8AAAA//////////AAAAf/////////wAAAP/////////4AAAP/////////4AAAP/////////8AAAD/////////+AAAB//////////AAAD//////////wAAD//////////4AAB/////////+AAAD/////////4AAAD/////////wAAAB/////////wAAAB/////////gAAAD/////////AAAAB////////+AAAAB////////+AAAAB////////8AAAAB////////8AAAAA////////8AAAAA////////8AAAAA////////4AAAAAf///////4AAAAAP///////4AAAAAH+//////4AAAAAAA//////wAAAAAAB//////wAAAAAAB//////wAAAAAAD//////gAAAAAAD//////AAAAAAAD//////AAAAAAAH/////+AAAAAAAH/////8AAAAAAAP/////4AAAAAAAf/////wAAAAAAAf/////gAAAAAAA//////AAAAAAAB/////8AAAAAAAD/////wAAAAAAAH/////AAAAAAAAP/////4AAAAAAAf/////8AAAAAAA//B//h8AAAAAAB/+AAJncAAAAAAD/8AATscAAAAAAH/4AAjo8AAAAAAP/4AADg4AAAAAAf/wAAHAwAAAAAA//gAAGBgAAAAAB//AAAECAAAAAAD//AAAAAAAAAAAH/+AAAAAAAAAAAP/8AAAAAAAAAAAP/4AAAAAAAAAAAD/wAAAAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"erithacus-rubecula":{"w":93,"h":78,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf/gAAAAAAAAAAAAP//AAAAAAAAAAAAH//+AAAAAAAAAAAB///8AAAAAAAAAAAf///4AAAAAAAAAAH////wAAAAAAAAAA/////gAAAAAAAAAP/////AAAAAAAAAH/////+AAAAAAAAD//////+AAAAAAAA///////8AAAAAAAAf//////wAAAAAAAA///////gAAAAAAAD///////AAAAAAAAP//////8AAAAAAAB///////wAAAAAAAH///////gAAAAAAA///////+AAAAAAAD///////4AAAAAAAf///////AAAAAAAB///////8AAAAAAAP///////wAAAAAAB////////AAAAAAAP///////8AAAAAAB////////wAAAAAAH////////AAAAAAA////////8AAAAAAH////////gAAAAAA////////+AAAAAAH////////4AAAAAA/////////gAAAAAD////////8AAAAAAf////////gAAAAAB////////+AAAAAAP////////wAAAAAB/////////AAAAAAH////////8AAAAAAf////////wAAAAAD////////+AAAAAAP////////4AAAAAA/////////gAAAAAD////////+AAAAAAP////////4AAAAAAf/////8f/gAAAAAB/////+Af/AAAAAAH/////AA/8AAAAAAP////wAD/4AAAAAAf///4AAP/gAAAAAAf//8AAAf+AAAAAAAf//AAAB/8AAAAAADD/wAAAH/wAAAAABgAMAAAAP/AAAAAAYADAAAAA/8AAAAAOAAwAAAADxAAAAADgAEAAAAAAAAAAAA4ABgAAAAAAAAAAAfgAYAAAAAAAAAAAHnwGAAAAAAAAAAAD4ABgAAAAAAAAAAA/AAcAAAAAAAAAAANwAHwAAAAAAAAAABKAf/4AAAAAAAAAADQHODwAAAAAAAAAAaBDwAAAAAAAAAAACIA0AAAAAAAAAAAAQAEgAAAAAAAAAAAAABkAAAAAAAAAAAAAAIwAAAAAAAAAAAAABGAAAAAAAAAAAAAAYQAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"falco-columbarius-2":{"w":77,"h":93,"bits":"AAAAAAAAAAABAAAAAAAAAAAAO4AAAAAAAAAAD/gAAAAAAAAAA//gAAAAAAAAAP/+AAAAAAAAAD//4AAAAAAAAA///wAAAAAAAAH///AAAAAAAAA///4AAAAAAAAP///gAAAAAAAD////AAAAAAAAf///8AAAAAAAB////gAAAAAAAP///+AAAAAAAA////4AAAAAAAH////gAAAAAAAf///8AAAAAAAB////wAAAAAAAD///+AAAAAAAAH///4AAAAAAAAP///gAAAAAAAAf//+AAAAAAAAA///4AAAAAAAAB///wAAAAAAAAD///gAAAAAAAAH///AAAAAAAAAP//+AAAAAAAcA///8AAAAAAP/////4AAAAAA//////4AAAAAD//////wAAAAAH//////gAAAAAf//////AAAAAA//////+AAAAABP/////4AAAAAAP/////wAAAAAAP/////gAAAAAAP////+AAAAAAAP////8AAAAAAAf////wAAAAAAAf////wAAAAAAA/////wAAAAAAB/////wAAAAAAH/////wAAAAAA//////wAAAAAH//////wAAAAA///////wAAAAD///////4AAAAP///////4AAAAf///////8AAAB////////8AAAD////////+AAAP////j///+AAAf///+B////AAB////4Ad///AAD////gAR///gAH///8AAh///gAf///wAB////AA///+AADg//+AB///4AADA//4AH///AAAHg//4AP//8AAADg//gAf//wAAADw/+AA///AAAADA/4AB//8AAAAAAeAAH//wAAAAAAAAAP//gAAAAAAAAAf/+AAAAAAAAAB//8AAAAAAAAAD//4AAAAAAAAAH//gAAAAAAAAAP/+AAAAAAAAAA//8AAAAAAAAAB//wAAAAAAAAAD//AAAAAAAAAAH/+AAAAAAAAAAf/4AAAAAAAAAA//wAAAAAAAAAB/+AAAAAAAAAAH/8AAAAAAAAAAP/wAAAAAAAAAAf/AAAAAAAAAAA/4AAAAAAAAAAD/wAAAAAAAAAAH/AAAAAAAAAAAP+AAAAAAAAAAA/gAAAAAAAAAAB/AAAAAAAAAAAD0AAAAAAAAAAANYAAAAAAAAAAAWAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAA="},"falco-columbarius":{"w":59,"h":93,"bits":"AP8AAAAAAAB/+AAAAAAAP//AAAAAAAf//AAAAAAB///AAAAAAD///AAAAAAH//+AAAAAAf//+AAAAAA///8AAAAAB///8AAAAAC///4AAAAAB///4AAAAAD///wAAAAAH///wAAAAAP///4AAAAAf///4AAAAB////8AAAAD////8AAAAP////8AAAA/////8AAAB/////8AAAH/////8AAAP/////8AAAf/////8AAA//////4AAB//////4AAD//////wAAH//////wAAP//////wAAP//////gAAf//////gAA///////AAA//////+AAB//////+AAD//////8AAD//////8AAH//////4AAP//////wAAP//////wAAf//////gAAf//////AAAf/////+AAA//////8AAA//////8AAA//////4AAA//////wAAA//////wAAB//////gAAB//////AAAB//////AAAD/////+AAAD/////8AAAH/////4AAAP/////wAAAP/////gAAAf/////AAAA/////+AAAB/////8AAAB/////4AAAD/////wAAAD/////wAAAH/////gAAD//////gAAH//////AAAf//////AAA//////+AAA//////8AAA/J////8AAA+D////4AAAAH/f//4AAAAP+///wAAAAP4///wAAAAMB///gAAAAAD///gAAAAAD///AAAAAAH/73AAAAAAP/z2AAAAAAP/jmAAAAAAf/DkAAAAAA//BMAAAAAA/+AIAAAAAB/8AAAAAAAD/4AAAAAAAD/wAAAAAAAH/wAAAAAAAP/gAAAAAAAP/AAAAAAAAf+AAAAAAAAf8AAAAAAAAf8AAAAAAAA/4AAAAAAAA/wAAAAAAAAfAA="},"falco-peregrinus-2":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAACMAAAAAAAAAAAAAAzAAAAAAAAAAAAAAMwAAAAAAAAAAAAADewAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/wAAAAAAAAAAAAB//BAAAAAAAAAAAAf/4MAAAAAAAAAAAH/+AwAAAAAAAAAAD//g2wAAAAAAAAAA//4D+AAAAAAAAAAP//Af4AAAAAAAAAD//4B/oAAAAAAAAA///AP/gAAAAAAAAP//wB/+AAAAAAAAH//8AH/wAAAAAAAB///AA//gAAAAAAAf//8AH/+AAAAAAAH///AAf/4AAAAAAD///4AD//wAAAAAA///+AAP//AAAAAAP///gAB//+AAAAAD///4AAH//4AAAAA////AAAf//wAAAAf///wAAD//+AAAAH///+AAAP//4AAAA////gAAA///gAAAP///4AAAH//+AAAD////AAAAf//4AAA////wAAAB///AAAP///4AAAAH///AAB////AAAAAf///AAf///wAAAAD///8AD///8AAAAAP///4Af///AAAAAB////gD///4AAAAAH///+A///+AAAAAAf///4H///4AAAAAB////g////AAAAAAH///+P///wAAAAAAf///5///+AAAAAAA////v///4AAAAAAA///////+AAAAAAAD///////wAAAAAAAH//////8AAAAAAAAf//////gAAAAAAAB//////8AAAAAAAAH//////AAAAAAAAA//////4AAAAAAAAP//////AAAAAAAAH//////wAAAAAAAB//////+AAAAAAAAf//////wAAAAAAAD//////8AAAAAAAAf//////gAAAAAAAD//////4AAAAAAAA///////AAAAAAAAH//////8AAAAAAAAb//////wAAAAAAACH//////AAAAAAAAAH/////8AAAAAAAAAP/////4AAAAAAAAAf/////wAAAAAAAAAH/////AAAAAAAAAAP////+AAAAAAAAAAP////8AAAAAAAAAA/////4AAAAAAAAAD/////wAAAAAAAAAP/////wAAAAAAAAAfz////gAAAAAAAAA+N///+AAAAAAAAABxn///wAAAAAAAAAMMf///AAAAAAAAAB55///wAAAAAAAAAd/n//8AAAAAAAAABhsf//AAAAAAAAAAOOg//4AAAAAAAAAA5wAboAAAAAAAAAAHnAAAAAAAAAAAAAAccAAAAAAAAAAAAAAAAAAAA="},"falco-peregrinus":{"w":65,"h":93,"bits":"AAAAAAAABgAAAAAAAAA/8AAAAAAAAH/+AAAAAAAAf/+AAAAAAAB//+AAAAAAAH//8AAAAAAAP//4AAAAAAA///4AAAAAAD///wAAAAAAH///wAAAAAAf///gAAAAAD///6AAAAAAf///gAAAAAB///+AAAAAAH///4AAAAAAf///wAAAAAB////gAAAAAP////AAAAAA/////AAAAAD////+AAAAAP////+AAAAA/////8AAAAD/////8AAAAP/////4AAAA//////wAAAD//////gAAAH//////AAAAf/////+AAAA//////8AAAD//////4AAAH//////gAAAP//////AAAA//////+AAAB//////4AAAD//////wAAAP//////gAAAf/////+AAAA//////8AAAD//////4AAAH//////gAAAP//////AAAA//////8AAAB//////4AAAD//////gAAAP/////+AAAAf/////8AAAA//////gAAAD//////AAAAH/////8AAAAP/////wAAAAf/////gAAAB//////AAAAD/////8AAAAH/////4AAAAP/////wAAAAf/////AAAAA/////+AAAAD/////4AAAAH/////wAAAAf/////4AAAB//////8AAAH//////8AAAf//////8AAB////+/j4AAH////w+PwAAf+///w4PgAB/5///xw3AAD/z///zDcAAP/H///2AYAA98P//vmDgADzwf/+fgAAAOHB//8/AAAAQeD//w8AAAAA4H//hgAAAADgP//HAAAAAGAf/6OAAAAAcB//gYAAAAAwD//AgAAAABAH/+AAAAAACAP/4AAAAAAAA//wAAAAAAAB//gAAAAAAAD/+AAAAAAAAH/8AAAAAAAAP/wAAAAAAAA//gAAAAAAAB/+AAAAAAAAD/8AAAAAAAAH/wAAAAAAAAP/AAAAAAAAAf8AAAAAAAAA/wAAAAAAAAAAAAAAAAAA"},"falco-subbuteo-2":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAABoAAAAAAAAAAAAAAPgAAAAAAAAAAAAAB8AAAAAAAAAAAAGAH8AAAAAAAAAAAHjg/gAAAAAAAAAAH/wH/AAAAAAAAAAH/8Af8AAAAAAAAAH//gD/wAAAAAAAAD//4Af/gAAAAAAAB//+AD/+AAAAAAAA///AAP/4AAAAAAAf//wAB//gAAAAAAP//8AAH/+AAAAAAH///AAA//4AAAAAD///wAAD//wAAAAB///8AAAf//AAAAA////gAAB//4AAAAf///4AAAP//wAAAP///8AAAA//+AAAD////AAAAD//4AAB////4AAAAf//gAAf///8AAAAB///gAH////AAAAAP//+AD////wAAAAB///8A////8AAAAAH///wP////AAAAAA////B////wAAAAAD///+f///4AAAAAAH///z///+AAAAAAAf///////AAAAAAAB///////4AAAAAAAD///////AAAAAAAAH//////wAAAAAAAAf//////AAAAAAAAB//////4AAAAAAAAH/////+AAAAAAAAA//////wAAAAAAAA//////+AAAAAAAAf//////wAAAAAAAH//////8AAAAAAAB///////gAAAAAAAP//////4AAAAAAAB///////AAAAAAAAf//////4AAAAAAAD//////+AAAAAAAAf//////gAAAAAAACf/////8AAAAAAAAB//////AAAAAAAAAD/////wAAAAAAAAAP/////AAAAAAAAAA/////+AAAAAAAAAD/////4AAAAAAAAAP/////gAAAAAAAAAf////+AAAAAAAAAA/////4AAAAAAAAAA/////gAAAAAAAAAB/////AAAAAAAAAAA////+AAAAAAAAAAA////4AAAAAAAAAAB/+//wAAAAAAAAAAAdj//gAAAAAAAAAACMn//AAAAAAAAAAA/8f/+AAAAAAAAAAH8B//8AAAAAAAAABxwH//4AAAAAAAAAHXwP//4AAAAAAAAAeeA///AAAAAAAAAAwAB//wAAAAAAAAAAAAD/gAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"falco-subbuteo":{"w":43,"h":93,"bits":"AAAAAAAAAAAAAAAAAAfAAAAAA/8AAAAB//AAAAA//wAAAA//8AAAAf//AAAAP//gAAAH//wAAAD//8AAAB//+AAAA///AAAAf//gAAAf//wAAAf//8AAA///+AAA////gAA////4AA////8AA/////AAf////gAf////4Af////8AP////+AP/////AH/////gD/////wD/////4B/////8A/////+A//////Af/////gP/////wH/////wD/////4B/////8A/////+A//////Af/////AP/////gH/////gD/////wB/////wA/////wAf////4AP////4AH////8AD////8AB////+AA////+AAf////AAP////gAH////gAD////wAB////4AAf///4AAP///4AAH///8AAD////8AB/////AB/////AA////8AAP//38AAP//78AAHv/4AAADn/8AAABz/8AAAA7/+AAAAd//AAAAM//AAAAGf/gAAADP/wAAABn/4AAAAj/4AAAAR/8AAAAJ/+AAAAE//AAAAAf/AAAAAP/gAAAAH/wAAAAD/wAAAAB/4AAAAA/8AAAAAf8AAAAAP+AAAAAH/AAAAAD/AAAAAB/gAAAAA/gAAAAAIgAAAAAAAAAAAAAAAAAAA="},"falco-tinnunculus-2":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAJwAAAAAAAAAAAAAGcAgAAAAAAAAAAAB/MGAAAAAAAAAAAAf3A2AAAAAAAAAAAH/wPwAAAAAAAAAAD/8B/wAAAAAAAAAA//gP+AAAAAAAAAAf/4A/+AAAAAAAAAP/+AH/4AAAAAAAAD//wA//wAAAAAAAB//8AD//AAAAAAAAf//AAf/8AAAAAAAP//4AD//4AAAAAAD//+AAP//gAAAAAB///wAB//+AAAAAAf//8AAH//4AAAAAP///AAAf//gAAAAH///wAAD//+AAAAB///+AAAP//4AAAAf///gAAA///gAAAP///4AAAH//+AAAD///+AAAAf//4AAA////wAAAB///wAAP///8AAAAH///AAD////AAAAAf//+AA////wAAAAB///8AP///8AAAAAP///4B////AAAAAA////gf///wAAAAAD///+D///8AAAAAAP///4////gAAAAAAf///n///4AAAAAAB////////AAAAAAAD///////4AAAAAAAH//////+AAAAAAAAP//////wAAAAAAAA//////8AAAAAAAAD//////gAAAAAAAA//////4AAAAAAAAP//////AAAAAAAAD//////wAAAAAAAA//////+AAAAAAAAH//////gAAAAAAAA//////8AAAAAAAAH//////AAAAAAAAA//////4AAAAAAAAH/////4AAAAAAAAAH/////gAAAAAAAAAf/////AAAAAAAAAA/////8AAAAAAAAAD/////wAAAAAAAAAP/////AAAAAAAAAAf////+AAAAAAAAAAf////8AAAAAAAAAAf////4AAAAAAAAAAH////wAAAAAAAAAAP////gAAAAAAAAAAD/f//gAAAAAAAAAAf5///gAAAAAAAAAD/j///wAAAAAAAAA7kP///gAAAAAAAADuA///8AAAAAAAAAP4B///gAAAAAAAAA/wH//4AAAAAAAAAAMAP//AAAAAAAAAAAAAf/AAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"falco-tinnunculus":{"w":47,"h":93,"bits":"AAAAAAAAAAAAAAAAA/AAAAAAH/gAAAAAf/wAAAAB//wAAAAH//gAAAAP//gAAAAf//gAAAAf//AAAAB//+AAAAD//+AAAAD//8AAAAH//8AAAAP//8AAAAf//8AAAA///+AAAB///+AAAH///+AAAP///8AAA////8AAB////8AAD////4AAH////4AAP////wAAf////gAA/////gAA/////AAB////+AAD////+AAH////8AAH////4AAP////wAAf////gAA/////gAA/////AAB////+AAD////8AAD////4AAH////wAAH////gAAP////gAAP////AAAP///+AAAf///8AAAf///4AAA////wAAA////gAAB////AAAB///+AAAD///8AAAD///4AAAH///4AAA////wAAP////gAAA////AAAA////AAAB///+AAAHOf/8AAAGAf/4AAAAA//wAAAAA//gAAAAA//gAAAAA//gAAAAA//AAAAAB//AAAAAD//AAAAAD//AAAAAH/+AAAAAP/OAAAAAP+MAAAAAf+AAAAAAf8AAAAAA/4AAAAAB/4AAAAAB/wAAAAAD/gAAAAAD/gAAAAAH/AAAAAAP+AAAAAAP+AAAAAAf8AAAAAAf4AAAAAA/4AAAAAA/wAAAAAB/gAAAAAB/gAAAAAD/AAAAAAD+AAAAAAD8AAAAAAAgAAAAAAAAAAAAAAAAA=="},"fringilla-coelebs-2":{"w":76,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADGAAAAAAAAAAAYwAAAAAAAAAADnAAAAAAAAAAAc4gAAAAAAAAADnOAAAAAAAAAA/5wCAAAAAAAAH/uAMwAAAAAAA//4AbAAAAAAAH//MJ2AAAAAAA//7g3dgAAAAAH//8Bv2AAAAAA///wH/9AAAAAH//+AP/+AAAAA///yA//4AAAAH///wD//4AAAA////AH//wAAAH///4Af//gAAA////AA///gAAH///+AD//+AAA////4AH//+AAH////AAPv/4AA////4AA+/PwAH////AABj+fgA////+AAD/4/AH////wAAH/z+Af///+AAAP//8D////wAAA///8f////AAAB///5////8AAAD////////gAAAH///////8AAAAf///////gAAAD///////4AAAAf///////gAAAH///////+AAAA////////4AAAA////////gAAAA///////+AAAAB///////4AAAAD///////gAAAAH//////+AAAAAf//////4AAAAA///////gAAAAD//////+AAAAAH//////4AAAAAf//////gAAAAB//////+AAAAAD//////4AAAAAP//////gAAAAA//////8AAAAAB////+fwAAAAAH////8IAAAAAAP////wAAAAAAA/////gAAAAAAB////+AAAAAAAD////4AAAAAAAH////wAAAAAAAP////AAAAAAAAf///8AAAAAAAAf///4AAAAAAAA////gAAAAAAAA////AAAAAAAAH///8AAAAAAAA////4AAAAAAAD////gAAAAAAAM5///AAAAAAAAxxh/8AAAAAAABjiD/4AAAAAAAGOAD/gAAAAAAAMYAH/AAAAAAAAYAAP8AAAAAAAAAAA/4AAAAAAAAAAB/wAAAAAAAAAAH/gAAAAAAAAAAP/AAAAAAAAAAA/8AAAAAAAAAAB/4AAAAAAAAAAH/wAAAAAAAAAAP/gAAAAAAAAAA//AAAAAAAAAAB/+AAAAAAAAAAH/8AAAAAAAAAAP/4AAAAAAAAAA/fgAAAAAAAAAB8OAAAAAAAAAAHgAAAAAAAAAAAOAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"fringilla-coelebs":{"w":93,"h":64,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAAAAH/wAAAAAAAAAAAAD//gAAAAAAAAAAAA//+AAAAAAAAAAAAP//8AAAAAAAAAAAP///gAAAAAAAAAAH///+AAAAAAAAAAA////4AAAAAAAAAAB////gAAAAAAAAAAB///8AAAAAAAAAAAP///wAAAAAAAAAAA////gAAAAAAAAAAH////AAAAAAAAAAAf///+AAAAAAAAAAD////8AAAAAAAAAAf////4AAAAAAAAAD/////gAAAAAAAAAf/////AAAAAAAAAD/////8AAAAAAAAAP/////wAAAAAAAAB//////gAAAAAAAAP/////+AAAAAAAAB//////4AAAAAAAAP//////wAAAAAAAB///////gAAAAAAAP//////+AAAAAAAB///////4AAAAAAAH///////wAAAAAAA////////AAAAAAAH///////8AAAAAAAf///////wAAAAAAD////////AAAAAAAP///////8AAAAAAA////////gAAAAAAH////////AAAAAAAf///////8AAAAAAB////////wAAAAAAH////////AAAAAAAf///////8AAAAAAB////////wAAAAAAD////////AAAAAAAP///////4AAAAAAAf///////gAAAAAAA////////AAAAAAAA///+A//+AAAAAAAA//+AAD/8AAAAAADh/8AAAH/4AAAAAB//8AAAAf/wAAAAA///gAAAA//gAAAAAfB+AAAAB/+AAAAAGA4AAAAAH/8AAAAAAcAAAAAAP/wAAAAAOAAAAAAAf/AAAAHngAAAAAAB/sAAAP//wAAAAAAD+AAAFn4PQAAAAAAPwAAAA8AAAAAAAAAeAAAAMAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"fulica-atra-2":{"w":93,"h":44,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf+AAAAAAAAAAAAA////AAAAAAAAAAAD////wAAAD///+AAP////gAAB/////AAP////gAAf/////AAP////AAH/////wAAP///8AB/////+AAAH///4A/////+AAAAD/////////+AAAAAB////////+AAAAAA////////8AAAAAAD///////4AAAAAAA///////wAAAAAAAP//////8AAAAAAAD///////AAAAAAAB///////wAAAAAAAP//////4AAAAAAADAB////+AAAAAAAAAAD////gAAAAAAAAAAH///+AAAAAAAAAAAf///4AAAAAAAAAAB////gAAAAAAAAAAH///+AAAAAAAAAAAf///wAAAAAAAAAAA////AAAAAAAAAAAD///cAAAAAAAAAAAH//74AAAAAAAAAAAH//+AAAAAAAAAAAAP//gAAAAAAAAAAAAf/wAAAAAAAAAAAAAGDAAAAAAAAAAAAAAYMAAAAAAAAAAAAADo+AAAAAAAAAAAAAPHgAAAAAAAAAAAAA8fAAAAAAAAAAAAAD4+AAAAAAAAAAAAAP7+AAAAAAAAAAAAAfHgAAAAAAAAAAAAA4MAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"fulica-atra":{"w":93,"h":86,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAB/4AAAAAAAAAAAAA//gAAAAAAAAAAAAD//AAAAAAAAAAAAAP/4AAAAAAAAAAAAB//gAAAAAAAAAAAAf/+AAf///AAAAAAD//4Af////4AAAAA///Af/////8AAAAP//4P///////4AAD///j////////gAAf//9////////AAAB///////////wAAB////////////ngAX////////////4AB////////////+AAYH////////////AMA////////////4DAH////////////BgA////////////4AAP///////////+AAB////////////wAAf///////////8AAD///////////8AAAf///////////AAAD///////////wAAA///////////8AAAH///////////AAAAf//////////4AAAD//////////+AAAAf//////////wAAAD//////////8AAAAP//////////gAAAB//////////4AAAAH//////////AAAAAf/////////wAAAAD/////////8AAAAAP/////////AAAAAAf////////gAAAAAB////////4AAAAAAB///////+AAAAAAAD///////gAAAAAAAAf/////wAAAAAAAAAAf///+AAAAAAAAAAAP///gAAAAAAAAAD////8AAAAAAAAAA///P/AAAAAAAAAAP8H4f8AAAAAAAAAD/gAAPgAAAAAAAAA/uAAB+AAAAAAAAAP4AAAPgAAAAAAAAD/CAAB8AAAAAAAAA/4AAAfAAAAAAAAAN/AAAHgAAAAAAAADs4AAB4AAAAAAAAA5iAAAOAAAAAAAAAEc4AADgAAAAAAAAADHAAA4AAAAAAAAAAY4AAPAAAAAAAAAADAAADwAAAAAAAAAA4QAA84AAAAAAAAAHBAAP+gAAAAAAAAAQAAD/gAAAAAAAAAAAAB/AAAAAAAAAAAQAD/gAAAAAAAAAAAAP/8AAAAAAAAAAAAH//gAAAAAAAAAAABA/4AAAAAAAAAAAAAH/AAAAAAAAAAAAAA/4AAAAAAAAAAAAAP+AAAAAAAAAAAAAD/wAAAAAAAAAAAABx+AAAAAAAAAAAAAcHgAAAAAAAAAAAAHA4AAAAAAAAAAAAB4HAAAAAAAAAAAAAQA4AAAAAAAAAAAAGAGAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"fulmarus-glacialis-2":{"w":64,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAA8AAAAAAAAAD8AAAAAAAAAP4AAAAAAAAA/4AAAAAAAAB/gAAAAAAAAH/gAAAAAAAAf/AAAAAAAAB/8AAAAAAAAD/4AAAAAAAAP/wAAAAAAAAf/gAAAAAAAB//AAAAAAAAD/8AAAAAAAAP/4AAAAAAAAf/wAAAAAAAA//gAAAAAAAD//AAAAAAAAH/+AAAAAAAAP/8AAAAAAAAf/8AAAAAAAA//4AAAAAAAB//wAAAAAAAD//gAAAAAAAH//AAAAAAAAP/+AAAAAAAAP/8AAAAAAAAf/4AAAAAAAA//wAAAAAAAB//AAAAAAAAD/+AAAAAAAAP/4AAAAAAAAf/wAAAAAAAB//gAAAAAAAH//AAAAAAAAP/+AAAAAAAA//8BgAAAAAH//4PgAAAAD///5/gAAAD//////AAAAf/////+AAAD//////8AAAf//////4AAB///////wAAH///////gAA///////+AAH///////8AA////////4ADgf//////wAAAf8/////AAAAD/////8AAAAAA//v/gAAAAAB//TAAAAAAAH/8AAAAAAAAP/4AAAAAAAA//gAAAAAAAB/+AAAAAAAAH/8AAAAAAAAf/wAAAAAAAB//AAAAAAAAH/+AAAAAAAAP/4AAAAAAAA//gAAAAAAAB//AAAAAAAAH/8AAAAAAAAf/wAAAAAAAA//AAAAAAAAB/+AAAAAAAAH/8AAAAAAAAf/wAAAAAAAA//gAAAAAAAD/+AAAAAAAAH/8AAAAAAAAf/wAAAAAAAA//gAAAAAAAB/+AAAAAAAAH/4AAAAAAAAP/wAAAAAAAAf/AAAAAAAAA/+AAAAAAAAB/4AAAAAAAAD/gAAAAAAAAH+AAAAAAAAAP8AAAAAAAAAfgAAAAAAAAAfAAAAAAAAAA4AAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAA"},"fulmarus-glacialis":{"w":93,"h":54,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/4AAAAAAAAAAAAH//gAAAAAAAAAAAB//+AAAAAAAAAAAAP//wAAAAAAAAAAAD///AAAAAAAAAAAA///8AAAAAAAAAAA////wAAAAAAAAAA///////8AAAAAAAH///////+AAAAAAB////////+AAAAAAP4P//////+AAAAAB8B///////8AAAAAAAP///////8AAAAAAD////////8AADgAAf/////////gD4AAD///////////+AAAf///////////gAAD////////////AAAf////////////AAD///////////AAAAf///////////4AAD////////////wAAf////////////AAB////////////4AAP///////////+AAA////////////gAAD////////8CAAAAAP////////gAAAAAA/////////AAAAAAD////////AAAAAAAH///////wAAAAAAAP//////4AAAAAAAAf/////8AAAAAAAAAf////+AAAAAAAAAAP////gAAAAAAAAAD////4AAAAAAAAAA////+AAAAAAAAAAB/3//gAAAAAAAAAAH+//AAAAAAAAAAAA/h/wAAAAAAAAAAAEEP+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAP+AAAAAAAAAAAAAB/gAAAAAAAAAAAAAP8AAAAAAAAAAAAAADgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"gallinago-gallinago-2":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAGAAAAAAAAAAAAAAB2AAAAAAAAAAAAAANgAAAAAAAAAAAAAD9AAAAAAAAAAAAAA/4AAAAAAAAAAAAAP+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAf/AAAAAAAAAAAAAH/4AAAAGAAAAAAAA/+AAAADgAAAAAAAP/4AAAD5gAAAAAAB//AAAB/4AAAAAAAf/4AAA/+AAAAAAAD/+AAAP/AAAAAAAA//4AAH/2AAAAAAAH//AAD//gAAAAAAB//wAA//4AAAAAAAP/+AAf/+AAAAAAAB//wAH//wAAAAAAAf/+AD//8AAAAAAAD//wA///AAAAAAAA//8Af//wAAAAAAAH//gP//+AAAAAAAA//8D///gAAAAAAAP//A///4AAAAAAAB//wf//+AAAAAAAAf//H///wAAAAAAAD//5///8AAAAAAAAf/////+AAAAAAAAD//////wAAAAAAAA//////8AAAAAAAAH//////AAAAAAAAA//////gAAAAAAAAH/////4AAAAAAAAAf////+AAAAAAAAAB////+AAAAAAAAAAH////4AAAAAAAA/gf////AAAAAAAAf+D////wAAAAAAAH/4f////AAAAAAAA///////4AAAAAAAP//////+AAAAAAAB///////4AAAAAAAf//////+AAAAAAAH///////wAAAAAAB///////+AAAAAAA////////wAAAAAAPAf/////+AAAAAAHgB//////gAAAAABwAP/////4AAAAAA8AA//////AAAAAAOAAH/////4AAAAADgAAf/////wAAAABwAAD//////AAAAAcAAAP/////8AAAAGAAAA//////4AAADgAAAD//////gAAAwAAAAP//////AAAMAAAAA///////AAAAAAAAB///////AAAAAAAAH//////8AAAAAAAAP//////AAAAAAAAAP/////4AAAAAAAAAH/////AAAAAAAAAAH////8AAAAAAAAAAP//geAAAAAAAAAAAD/+AwAAAAAAAAAAAAH4AAAAAAAAAAAAAAPgAAAAAAAAAAAAAA+AAAAAAAAAAAAAAD4AAAAAAAAAAAAAAPgAAAAAAAAAAAAAA/4AAAAAAAAAAAAAD/AAAAAAAAAAAAAAP+AAAAAAAAAAAAAA/+AAAAAAAAAAAAAB/4AAAAAAAAAAAAABwAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"gallinago-gallinago":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAP+AAAAAAAAAAAAAD/4AAAAAAAAAAAAB//gAAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAA//+AAAAAAAAAAAAH//4AAAAAAAAAAAA///AAAAAAAAAAAAP//4AAAAAAAAAAAB///gAAAAAAAAAAAf//+AAAAAAAAAAAD///4AAAAAAAAAAB////gAAAAAAAAAAf//4eAAAAAAAAAAP///B8AAAAAAAAAD///8DwAAAAAAAAB////gPAAAAAAAAA////+A+AAAAAAAAP////wB4AAAAAAAH/////AHgAAAAAAB/////4APAAAAAAAf/////AA8AAAAAAP/////4ADwAAAAAD//////AAHAAAAAA//////4AAeAAAAAP//////AAA4AAAAD//////4AADgAAAA///////AAAGAAAAH//////4AAAYAAAB///////AAAAAAAAf//////4AAAAAAAH//////+AAAAAAAB///////wAAAAAAAP//////+AAAAAAAD///////gAAAAAAA///////8AAAAAAAH///////AAAAAAAB///////4AAAAAAAf//////+AAAAAAAH///////gAAAAAAA///////4AAAAAAAP//////+AAAAAAAD///////wAAAAAAAf//////8AAAAAAAP///////AAAAAAAD///////gAAAAAAB///////4AAAAAAAf//////+AAAAAAAH///////AAAAAAAAB//////gAAAAAAAAf/////wAAAAAAAAH/////8AAAAAAAAB//////AAAAAAAAAP/////gAAAAAAAAB//wf/4AAAAAAAAAf/4AP+AAAAAAAAAH/8AB/gAAAAAAAAB//AAD4AAAAAAAAAf/gAAPAAAAAAAAAD/4AAA8AAAAAAAAA//AAADgAAAAAAAAH/wAAAPAAAAAAAAB/8AAAB8fwAAAAAAP/AAAB///8AAAAAA3AAAAef//4AAAAAAAAAAAD/AAAAAAAAAAAAAAM8AAAAAAAAAAAAABw8AAAAAAAAAAAAAGA4AAAAAAAAAAAAA4AAAAAAAAAAAAAAHgAAAAAAAAAAAAAD//wAAAAAAAAAAAB7/gAAAAAAAAAAAAAP//wAAAAAAAAAAAAc/8AAAAAAAAAAAAAwAAAAAAAAAAAAAADgAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"gallinula-chloropus-2":{"w":93,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARgAAAAABgAAAAAACMAAAAAA4AAAAAAAzmAAAAAeAAAAAAAGZgAAAAPjgAAAAAB3MAAAAD54AAAAAAP7kAAAB/+AAAAAAB+5gAAA//AAAAAAAf/cAAAP/zgAAAAAD//AAAD//4AAAAAAf/4AAB//+AAAAAAH/+QAAf//AAAAAAA//+AAH//3AAAAAAH//wAB///wAAAAAA//8AA///8AAAAAAP//wAP///AAAAAAB//+AD///4AAAAAAP//wA////AAAAAAB//+AP///wAAAAAAf//wD///8AAAAAAD//+A////AAAAAAAf//wf///4AAAAAAD//8H///+AAAAAAAf//h////gAAAAAAH//8f///4AAAAAAA///H////AAAAAAAH//4////wAAAAAAA///P///8AAAAAAAH//////+AAAAAAAA///////gAAAAAAAH//////4AAAAAAAA//////4AAAAAAAAD/////4AAAAAAAAAP////+AAAAAAAAAA/////8AAAAAAAAAH/////AAAAAAAMAAf////4AAAAAAP8AD/////AAAAAAH/4Af////+AAAAAA//wD/////AAAAAAP//gf////4AAAAAD///H/////AAAAAA/////////+AAAAAP/////////AAAAAD/////////4AAAAA8H////////AAAAAEAB///////8AAAAAAAD///////gAAAAAAAP//////4AAAAAAAA///////AAAAAAAAD//////4AAAAAAAAf//////AAAAAAAAB//////gAAAAAAAAH/////+AAAAAAAAA//////8AAAAAAAAD//////wAAAAAAAAP//////gAAAAAAAA///////AAAAAAAAD///////8AAAAAAAH///////4AAAAAAAf///////AAAAAAAA///////4AAAAAAAD//////+AAAAAAAAH/////4AAAAAAAAAf////8AAAAAAAAAA/////AAAAAAAAAAB////wAAAAAAAAAAB///8AAAAAAAAAAAD//+AAAAAAAAAAAAH//4AAAAAAAAAAAAf//wAAAAAAAAAAAAP//AAAAAAAAAAAAAB88AAAAAAAAAAAAADjgAAAAAAAAAAAAAOOAAAAAAAAAAAAAA44AAAAAAAAAAAAADjxwAAAAAAAAAAAAMP8AAAAAAAAAAAABw+AAAAAAAAAAAAAHf8AAAAAAAAAAAAAfv4AAAAAAAAAAAAB4f4AAAAAAAAAAAAHw/wAAAAAAAAAAAAfh/gAAAAAAAAAAAB/D/AAAAAAAAAAAAD/AAAAAAAAAAAAAAH+AAAAAAAAAAAAAAP4AAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"gallinula-chloropus":{"w":91,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAAAAAAAAAAAAAB/4AAAAAAAAAAAAB/+AAAAAAAAAAAAD//gAAAAAAAAAAAD//4AAAAAAAAAAAB//8AAAAAAAAAAAB///AAAAAAAAAAAB///wAAAAAAAAAAA///8AAAAAAAAAAAf///gAAAAAAAAAAf///4AAAAAAAAAAP///8AAAAAAAAAAH//8fAAAAAAAAAAH//4BwAAAAAAA/////wAAAAAAAAH/////4AAAAAAAAf/////8AAAAAAAB///////AAAAAAAD///////gAAAAAAH///////4AAAAAAP///////8AAAAAAP////////AAAAAAf////////gAAAAA/////////wAAAAA/////////4AAAAB/////////8AAAAB/////////+AAAAB//////////AAAAD//////////gAAAD//////////wAAAD//////////wAAAH//////////4AAAP//////////8AAAP//////////8AAAf//////////8AAAP//////////+AAAP//////////+AAAD//////////+AAAA//////////+AAAAD/////////+AAAAD/////////+AAAAD/////////+AAAAH/////////+AAAAH/////////+AAAAP/////////8AAAAP/////////8AAAAP/////////8AAAADw////////8AAAAAAA///////4AAAAAAAH//////4AAAAAAAAf/////4AAAAAAAAD/////wAAAAAAAAAf////wAAAAAAAAAD////gAAAAAAAAAAf///AAAAAAAAAAAB///AAAAAAAAAAAA///AAAAAAAAAAAA+H/AAAAAAAAAAAA+D/AAAAAAAAAAAAPA+AAAAAAAAAAAAHAeAAAAAAAAAAAADgeAAAAAAAAAAAABwPAAAAAAAAAAAABwHwAAAAAAAAAAAA4D4AAAAAAAAAAAAcA8AAAAAAAAAAAAOAPAAAAAAAAAAAAHAHgAAAAAAAAAAAHgB4AAAAAAAAAAADwAeAAAAAAAAAAABwAHgAAAAAAAAAAB4ADwAAAAAAAAAAB8Dg8AAAAAAAAAAH/PgfAAAAAAAAAAPv+AHwAAAAAAAAALD/D/4AIAAAAAAAAA//5+B4AAAAAAAAAMMA//wAAAAAAAAADgH//wAAAAAAAAAA8Fx///wAAAAAAAAPAAf///AAAAAAAAAwAB4AOgAAAAAAAAAAAeAAAAAAAAAAAAAADwAAAAAAAAAAAAAAeAAAAAAAAAAAAAADwAAAAAAAAAAAAAA4AAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"garrulus-glandarius-2":{"w":93,"h":69,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAACMAAAAAAAAAAAAAAziAAAAAAAAAAAAAG5wAAAAAAAAAAAABvcAAAAAAAAAAAAAf3AAAAAAAAAAAAAH/5gAAAAAAAAAAAB/+4AAAAAAAAAAAAf//AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAAf//cAAAAAAAAAAAH///AAAAAAAAAAAB///wAAAAAAAAAAAf//4AAAAAAAAAAAH///AAAAAAAAAAAD///8AAAAAAAAAAA////AAAAAAAAAAAP///wAAAAAAAAAAD///+AAAAAAAAAAA////wAAAAAAAAAAP///4AAAAAAAAAAB///+AAAAAAAAf4Af///gAAAAAAAP/wH///4AAAAAAAD//g///+AAAAAAAB///v///4AAAAAAB////////AAAAAAAf///////4AAAAAAAH///////gAAAAAAAf//////4AAAAAAAA///////AAAAAAAAD//////8AAAAAAAAP//////AAAAAAAAAf/////4AAAAAAAAB//////AAAAAAAAD//////gAAAAAAAB//////8AAAAAAAA//////8AAAAAAAAf//////gAAAAAAAP//////+AAAAAAAD///////4AAAAAAA////////wAAAAAAf////////gAAAAAP/////////gAAAAH//////////gAAAD///////////gAAD////////////gAB///////5/////gB///////+Pz///+A////////z+P///wAP//////8/g///+AD///////DYD///4B///////AZgf///g/f/////IAwB///wAH////9AAAAH///AB7///oAAAAAf//4A89//8AAAAAB///gAPe/8AAAAAAP//4ADnuZAAAAAAA//8AAA53AAAAAAAD//gAAMYgAAAAAAAMcIAAACAAAAAAAAAQAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"garrulus-glandarius":{"w":93,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAB/8AAAAAAAAAAAAA//4AAAAAAAAAAAAf//gAAAAAAAAAAAP//+AAAAAAAAAAAD///4AAAAAAAAAAAf///AAAAAAAAAAAH///8AAAAAAAAAAA////gAAAAAAAAAAP////gAAAAAAAAAB////+AAAAAAAAAAf////4AAAAAAAAAH/////gAAAAAAAAA/////AAAAAAAAAAP///+AAAAAAAAAAD////gAAAAAAAAAA////8AAAAAAAAAAf////AAAAAAAAAAH////4AAAAAAAAAD/////AAAAAAAAAA/////4AAAAAAAAAf/////AAAAAAAAAH/////4AAAAAAAAB//////AAAAAAAAAf/////4AAAAAAAAH//////AAAAAAAAB//////4AAAAAAAAf//////AAAAAAAAH//////4AAAAAAAA///////AAAAAAAAf//////4AAAAAAAH//////+AAAAAAAD///////wAAAAAAA///////+AAAAAAAP///////gAAAAAAB///////4AAAAAAAf///////AAAAAAAD///////wAAAAAAA///////+AAAAAAAP///////gAAAAAAD///////4AAAAAAA///////+AAAAAAAH///////gAAAAAAB///////4AAAAAAAP//////+AAAAAAAD///////gAAAAAAAf//////4AAAAAAAD//////+AAAAAAAA///////gAAAAAAAH//////4AAAAAAAB//////8AAAAAAAAf//////AAAAAAAAH//////gAAAAAAAB9/////wAAAAAAAAeP////4AAAAAAAAHj/////4AAAAAAAAw////4H8AAAAAAAMP/4HwAD8AAAAAAAB/+A/AAf4AAAAAAAf/AAcA/fgAAAAAAH/gAA4FB8AAAAAAB/4AADgAHgAAAAAAP+AAAPAA4AAAAAAD/wAAA+AeAAAAAAA/8AAA/8AwAAAAAAP/AAAcPgMAAAAAAB/wAAEA8AAAAAAAAf+AAAAHgAAAAAAAH/gAAAFwAAAAAAAB/4AAAAeAAAAAAAAf/AAAABgAAAAAAAD/wAAAAYAAAAAAAA/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAB/4AAAAAAAAAAAAAf+AAAAAAAAAAAAAH/wAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/AAAAAAAAAAAAAD/4AAAAAAAAAAAAA/+AAAAAAAAAAAAAP/gAAAAAAAAAAAAB/4AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/wAAAAAAAAAAAAA/8AAAAAAAAAAAAAP+AAAAAAAAAAAAAB/AAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"gavia-immer-2":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAACAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAMwAAAAAAQAAAAAADsAAAAAACQAAAAAA/gAAAAAAegAAAAAP/AAAAAAH8AAAAAD/wAAAAAA/wAAAAA/8AAAAAAH+AAAAAP/wAAAAAB/4AAAAD/+AAAAAAP/gAAAA//gAAAAAB/8AAAAP/8AAAAAAf/wAAAD//gAAAAAD/+AAAA//8AAAAAAf/wAAAP//gAAAAAD//AAAD//4AAAAAA//4AAA///AAAAAAH//AAAf//wAAAAAA//4AAH//+AAAAAAH//AAB///gAAAAAB//4AAP//8AAAAAAP//gAD///AAAAAAB//4AA///4AAAAAAP//AAP//+AAAAAAB//8AH///wAAAAAAP//AB///8AAAAAAB//4Af///AAAAAAAP//AH///4AAAAAAD//4B///+AAAAAAAf//AP///gAAAAAAD//8D///8AAAAAAAf//wf///AAAAAAAD///D///gAAAAAAAf//4f//4AAAAAAAB///n//+AAAAAAAAH//8///wAAAAB/gAf//n//8AAAAA//gB//+///gAAAAf//AH/////8AAAAf//8Af/////gAAB////wD/////8AAD/////AP/////gAA/////8B/////8AAAAD///wP/////AAAAAD///B/////4AAAAAD//4P////+AAAAAAB//h/////wAAAAAAD/8f////8AAAAAAAP//////+AAAAAAAA///////wAAAAAAAH//////+AAAAAAAAf//////wAAAAAAAD//////+AAAAAAAAf//////wAAAAAAAD//////+AAAAAAAAf//////4AAAAAAAB///////AAAAAAAAP//////8AAAAAAAA///////AAAAAAAAD//////gAAAAAAAAP/////+AAAAAAAAA//////4AAAAAAAAB//////gAAAAAAAAB/////+AAAAAAAAAH/////4AAAAAAAAAf/////gAAAAAAAAA/////+AAAAAAAAAD/////8AAAAAAAAAH/////wAAAAAAAAAf/////AAAAAAAAAA/////4AAAAAAAAAB/////gAAAAAAAAAB/////gAAAAAAAAAD/////AAAAAAAAAAA////8AAAAAAAAAAAB///gAAAAAAAAAAAH//+AAAAAAAAAAAAf//gAAAAAAAAAAAB//gAAAAAAAAAAAAH/+AAAAAAAAAAAAAP/8AAAAAAAAAAAAAfvwAAAAAAAAAAAAB4eAAAAAAAAAAAAADgwAAAAAAAAAAAAAEBAA="},"gavia-immer":{"w":93,"h":38,"bits":"AAADgAAAAAAAAAAAAAD/4AAAAAAAAAAAAB//wAAAAAAAAAAAAf//AAAAAAAAAAAAP//8AAAAAAAAAAAP///gAAAAAAAAAA////+AAAAAAAAAA/////wAAAAAAAAAf/////AAAAAAAAAAD////4AAAAAAAAAAAB///AAAAAAAAAAAAB//8AAAAAAAAAAAAD//gAAAAAAAAAAAAP/8AAAAAAAAAAAAA//gAAAAAAAAAAAAD/8AAAAAAAAAAAAA//gAAAAAAAAAAAAH/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/4ADgAAAAAAAAAB//B///AAAAAAAAAf/z////wAAAAAAAH///////wAAAAAAB////////4AAAAAAf////////4AAAAAH/////////+AAAAA///////////gAAAP//////////8AAAB//////////+AAAAP///////////wAAB///////////+AAAP///////////+AAB////////////wAAH///////////+AAAf///////////gAAB/////////8DwAAAB///////4AAAAAAAAAAAAAAAAAAAA=="},"gavia-stellata-2":{"w":93,"h":89,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAGgAAAAAAAAAAAAAB8AAAAAwAAAAAAAAfwAAAA8AAAAAAAAH8AAAAf4AAAAAAAA/gAAAP+AAAAAAAAP+AAAH/wAAAAAAAD/gAAB//AAAAAAAA/8AAA//wAAAAAAAP/wAAf/8AAAAAAAB/8AAH//AAAAAAAAf/gAD//4AAAAAAAH/4AA///AAAAAAAB//gAP//wAAAAAAAP/4AH//8AAAAAAAD//AB///AAAAAAAAf/4A///4AAAAAAAH/+AP//+AAAAAAAB//wD///wAAAAAAAf/+A///8AAAAAAAD//gf///AAAAAAAAf/8H///wAAAAAAAH//h///8AAAAAAAA//4f///AAAAAAAAP//H///wAAAAAAAB//5///+AAAAAAAAf/+P///AAAAAAAAD//5///wAAAAAAAAf//f//8AAAAAAAAD//////AAAAAAIAAP/////gAAAAAf8AB/////4AAAAAP/8AH////+AAAAH///wAf////4AAAAf///gD////+AAAAAD//+AP////wAAAAAH//4B////+AAAAAAP//AP////wAAAAAAf/8B////+AAAAAAAf/gP////wAAAAAAA/+B////+AAAAAAAD/wf////gAAAAAAAP/D////8AAAAAAAB///////gAAAAAAAH//////4AAAAAAAA//////+AAAAAAAAH//////wAAAAAAAA//////8AAAAAAAAH//////gAAAAAAAAf/////8AAAAAAAAD//////gAAAAAAAAf/////8AAAAAAAAB//////wAAAAAAAAP/////+AAAAAAAAA//////wAAAAAAAAD/////8AAAAAAAAAP/////AAAAAAAAAAf////8AAAAAAAAAB/////wAAAAAAAAAD/////AAAAAAAAAAH////8AAAAAAAAAAf////wAAAAAAAAAB/////AAAAAAAAAAD////4AAAAAAAAAAP////gAAAAAAAAAAf///+AAAAAAAAAAB////4AAAAAAAAAAD////AAAAAAAAAAAH///8AAAAAAAAAAAP///wAAAAAAAAAAAP//+AAAAAAAAAAAAH//8AAAAAAAAAAAAH//wAAAAAAAAAAAAf//gAAAAAAAAAAAD///AAAAAAAAAAAAf//OAAAAAAAAAAAB//wMAAAAAAAAAAAP/+AAAAAAAAAAAAAf/8AAAAAAAAAAAAB+PwAAAAAAAAAAAAHg4AAAAAAAAAAAAAOBgAAAAAAAAAAAAAwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"gavia-stellata":{"w":93,"h":61,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAB/4AAAAAAAAAAAAD//wAAAAAAAAAAB////AAAAAAAAAAAB///4AAAAAAAAAAAB///gAAAAAAAAAAAA//+AAAAAAAAAAAAD//wAAAAAAAAAAAAP/+AAAAAAAAAAAAA//wAAAAAAAAAAAAD//AAAAAAAAAAAAAP/4AAAAAAAAAAAAB//AAAAAAAAAAAAAP/4AAAAAAAAAAAAB//AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAD/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAD/8A///wAAAAAAAA//h////8AAAAAAAH/9//////AAAAAAB/////////gAAAAAP//////////4AAAD//////////8AAAAf///////////wAAH///////////4AAA////////////AAAH////////////4AA/////////////gAH////////////4AA////////////+AAH////////////gAAf/////////4fwAAD/////////8AAAAAP/////////AAAAAA/////////4AAAAAB/////////gAAAAAD////////4AAAAAAB///////+AAAAAAAAH/////+AAAAAAAAAAAH///gAAAAAAAAAAA///4AAAAAAAAAAAH//gAAAAAAAAAAAA/n4AAAAAAAAAAAAD4/gAAAAAAAAAAAAbHmAAAAAAAAAAAABJ+AAAAAAAAAAAAAIPwAAAAAAAAAAAAAB/AAAAAAAAAAAAAAP8AAAAAAAAAAAAAB/gAAAAAAAAAAAAAfwAAAAAAAAAAAAADYAAAAAAAAAAAAAARAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"haematopus-ostralegus-2":{"w":93,"h":90,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAADwAAAAAAAAAAAAAD8AAYAAAAAAAAAAB/4ABgAAAAAAAAAA/+AANAAAAAAAAAAf/gAB8AAAAAAAAAP/+AAPwAAAAAAAAH//gAB/gAAAAAAAD//4AAP+AAAAAAAA///AAA/8AAAAAAAf//4AAH/wAAAAAAP//+AAA/+AAAAAAD///AAAH/8AAAAAB///4AAAf/wAAAAAf//+AAAD//AAAAAP///wAAAf/8AAAAD///8AAAB//wAAAB////AAAAP//AAAAf///wAAAA//4AAAH///8AAAAH//gAAD////gAAAAf/+AAA////4AAAAD//wAAP///+AAAAAP/+AAD////gAAAAB//4AA////4AAAAAP//gAP///8AAAAAA//8AD////AAAAAAH//4Af///wAAAAAAf//gD///4AAAAAAD///A///+AAAAAAAP//8H///AAAAAAAA///w///wAAAAAAAB///H//+AAAAAAAAD//9///wAAAAAAAAP//v//+AAAAAAAAA//////gAAAAAAAAD/////8AAAAAAAAAP/////gAAAAAAAAB/////8AAAAAAAAAH/////gAAAAAAAAA/////4AAAAAAAAAH/////AAAAAAAAAA/////4AAAAAAAH/v////+AAAAAAAD///////wAAAAAAAf//////8AAAAAAAH///////gAAAAAAA///////4AAAAAAAP///////AAAAAAAD///////4AAAAAAA////////AAAAAAAf///////4AAAAAAHw///////AAAAAAB4A//////4AAAAAA8AB//////AAAAAAOAAP/////8AAAAAHgAA//////wAAAABwAAD//////AAAAAAAAAH/////8AAAAAAAAAH/////wAAAAAAAAAf/////AAAAAAAAAA/////8AAAAAAAAAB/////4AAAAAAAAAD/////4AAAAAAAAAD/////4AAAAAAAAAA/////4AAAAAAAAAB/////gAAAAAAAAAB/+//4AAAAAAAAAAB47//AAAAAAAAAAADnP/wAAAAAAAAAAAMY/+AAAAAAAAAAABhj/gAAAAAAAAAAAEMHwAAAAAAAAAAAAwwAAAAAAAAAAAAACGAAAAAAAAAAAAAAYYAAAAAAAAAAAAADDAAAAAAAAAAAAAAMPAAAAAAAAAAAAAB54AAAAAAAAAAAAAGHgAAAAAAAAAAAAA+eAAAAAAAAAAAAAB44AAAAAAAAAAAAAHDAAAAAAAAAAAAAAMMAAAAAAAAAAAAAAwwAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"haematopus-ostralegus":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4AAAAAAAAAAAAAB/wAAAAAAAAAAAAA//AAAAAAAAAAAAAP/8AAAAAAAAAAAAD//gAAAAAAAAAAAA//+AAAAAAAAAAAAH//wAAAAAAAAAAAB//+AAAAAAAAAAAAP//4AAAAAAAAAAAD///gAAAAAAAAAAAf//+AAAAAAAAAAAP///8AAAAAAAAAAP//+PwAAAAAAAAB////g/AAAAAAAAD////8B8AAAAAAAD/////wHwAAAAAAB/////+AfAAAAAAA//////wA+AAAAAAf/////+AD4AAAAAP//////4AHgAAAAD///////AAeAAAAB///////wAA4AAAB///////+AABgAAA////////wAAAAAAf///////8AAAAAAH////////AAAAAAD////////4AAAAAA////////+AAAAAAP////////gAAAAAf////////4AAAAAf/////////AAAAAP/////////wAAAACf////////8AAAAAH/////////AAAAAH/////////wAAAAAD////8///4AAAAAAf/gAAAH/+AAAAAAP/wAAAAP/AAAAAAH/wAAAAAfwAAAAAA/wAAgAAB4AAAAAAD4AABAAAYAAAAAAAQAAADAAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAAAAAAAAAAAAB8AAAAAAAAAAAAAAP/AAAAAAAAAAAAADz/wAAAAAAAAAAAAOA/AAAAAAAAAAAABwH4AAAAAAAAAAAAOBngAAAAAAAAAAAAwI8AAAAAAAAAAAAGAHwAAAAAAAAAAAAwA+AAAAAAAAAAAAGAFwAAAAAAAAAAAAwAmAAAAAAAAAAAADAAwAAAAAAAAAAAAYAEAAAAAAAAAAAAHAAAAAAAAAAAAAAD+eAAAAAAAAAAAAAD+AAAAAAAAAAAAAAP8AAAAAAAAAAAAAA9+AAAAAAAAAAAAABgAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"hirundo-rustica-2":{"w":86,"h":93,"bits":"AAAAAAAAAAAAAAMAAAAAAAAAAAAADAAAAAAAAAAAAAAYAAAAAAAAAAAAAHgAAAAAAAAAAAAB4AAAAAAAAAAAACPAAAAAAAAAAAADj4AAAAAAAAAAADw/gAAAAAAAAAADwH8AAAAAAAAAAD8B/gAAAAAAAAAD+Af4AAAAAAAAAD/AD/gAAAAAAAAB/gA/8AAAAAAAAB/4AH/gAAAAAAAA/8AB/+AAAAAAAA/+AAP/wAAAAAAAf/AAD/+AAAAAAAf/gAAf/4AAAAAAP/wAAH/+AAAAAAP/4AAA//wAAAAAH/8AAAH//AAAAAH/+AAAB//4AAAAD//AAAAP/+AAAAB//wAAAB//4AAAB//4AAAAf/+AAAA//8AAAAD//gAAA//+AAAAAf//gAAf//AAAAAD//+AAf//gAAAAA///4AP//wAAAAAP///AH//4AAAAAB///4D//8AAAAAAP///B///AAAAAAB///4///AAAAAAAP///f//gAAAAAAA//////wAAAAAAAB/////wAAAAAAAAD////8AAAAAAAAAf////AAAAAAAAAf////wAAAAAAAAf////8AAAAAAAAP/////AAAAAAAAH/////wAAAAAAAD/////8AAAAAAAA//////AAAAAAAAP/////wAAAAAAAH/////4AAAAAAAD/////+AAAAAAAAD/////gAAAAAAAAf////wAAAAAAAAB////4AAAAAAAAAH////AAAAAAAAAA////4AAAAAAAAAD///+AAAAAAAAAAP///wAAAAAAAAAA///+AAAAAAAAAAD///gAAAAAAAAAA///8AAAAAAAAAANt//gAAAAAAAAADjb/4AAAAAAAAAAMYP/AAAAAAAAAAAAB/wAAAAAAAAAAAAP+AAAAAAAAAAAAD/wAAAAAAAAAAAAf+AAAAAAAAAAAAH/wAAAAAAAAAAAA/+AAAAAAAAAAAAP/wAAAAAAAAAAAB/+AAAAAAAAAAAAfjwAAAAAAAAAAADwOAAAAAAAAAAAA4AwAAAAAAAAAAAOADAAAAAAAAAAABgAYAAAAAAAAAAAYADAAAAAAAAAAAGAAYAAAAAAAAAAAwADAAAAAAAAAAAMAAYAAAAAAAAAADAADAAAAAAAAAAAQAAYAAAAAAAAAAEAADAAAAAAAAAABAAAYAAAAAAAAAAYAADAAAAAAAAAACAAAQAAAAAAAAAAgAACAAAAAAAAAAMAAAQAAAAAAAAABAAAAAAAAAAAAAAQAAAAAAAAAAAAACAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAA=="},"hirundo-rustica":{"w":70,"h":93,"bits":"ABwAAAAAAAAAA/4AAAAAAAAAP/4AAAAAAAAB//wAAAAAAAA///gAAAAAAAH//+AAAAAAAAD//8AAAAAAAAH//wAAAAAAAAP//gAAAAAAAA//+AAAAAAAAB//8AAAAAAAAH//4AAAAAAAAf//wAAAAAAAB///gAAAAAAAP///AAAAAAAA///+AAAAAAAD///8AAAAAAAP///4AAAAAAA////wAAAAAAD////gAAAAAAP////AAAAAAA////+AAAAAAB////4AAAAAAH////wAAAAAAP////gAAAAAA////+AAAAAAD////8AAAAAAH////4AAAAAAP////gAAAAAA/////AAAAAAB////+AAAAAAD////4AAAAAAP////wAAAAAAf////AAAAAAA////+AAAAAAB////4AAAAAAD////wAAAAAAH////AAAAAAAP///+AAAAAAA////8AAAAAAH////4AAAAAAb////gAAAAABv////AAAAAADz///+AAAAAAHAf//8AAAAAAAAf//wAAAAAAAA///gAAAAAAAB///AAAAAAAAB//+AAAAAAAAD//8AAAAAAAAH//wAAAAAAAAP//gAAAAAAAAf//AAAAAAAAA//+AAAAAAAAD/f8AAAAAAAAH+f4AAAAAAAAf4/wAAAAAAAB/w/AAAAAAAAD/g+AAAAAAAAP+AwAAAAAAAAf8AAAAAAAAAB/4AAAAAAAAAH7gAAAAAAAAAPHAAAAAAAAAA8GAAAAAAAAABwMAAAAAAAAAHAQAAAAAAAAAcBgAAAAAAAAAwDAAAAAAAAADAGAAAAAAAAAEAIAAAAAAAAAYAQAAAAAAAABgAgAAAAAAAACADAAAAAAAAAMAEAAAAAAAAAQAIAAAAAAAABAAQAAAAAAAAGABgAAAAAAAAIACAAAAAAAAAwAEAAAAAAAABAAIAAAAAAAAGAAgAAAAAAAAIABAAAAAAAAAgAAAAAAAAAABAAIAAAAAAAAEAAAAAAAAAAAIAAAAAAAAAAAgAAAAAAAAAABAAAAAAAAAAAEAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"ichthyaetus-melanocephalus-2":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAD8AAAAAAAAAAAAAD/AAAAAAAAAAAAAD/4AAAAAAAAAAAAB/+AAAAAAAAAAAAB//gOAAAAAAAAAAA//4B4AAAAAAAAAAf/+AHwAAAAAAAAAP//gA/AAAAAAAAAH//4AH8AAAAAAAAD//+AAfwAAAAAAAB///gAD/AAAAAAAA///4AAf+AAAAAAAf//+AAB/4AAAAAAP///gAAP/gAAAAAD///4AAA/+AAAAAA///+AAAD/4AAAAAf///gAAAf/wAAAAP///4AAAB//AAAAD///+AAAAH/8AAAA////gAAAA//wAAAP///4AAAAD//AAAD///+AAAAAP/8AAA////gAAAAA//wAAH///4AAAAAD//AAB///8AAAAAAP/4AAP///AAAAAAA//wAB///wAAAAAAH//AAP//+AAAAAAAf/+AD///gAAAAAAB//8Af//4AAAAAAAH//wD///AAAAAAAAf//Af//4AAAAAAAA//+D///AAAAAAAAD//4f//wAAAAAAAAH//n//+AAAAAAAAAf/+///wAAAAAAAAB/////+AAAAAAAAAH/////gAAAAAAAAAf////8AAAAAAAAAD/////gAAAAAAAAAP////4AAAAAAAAAB/////AAAAAAAAAAH////4AAAAAAAAAA////+AAAAAAAAAf/////wAAAAAAAAP/////8AAAAAAAAD//////gAAAAAAAA//////4AAAAAAAAP//////AAAAAAAAP//////4AAAAAAAH///////AAAAAAAA4f/////4AAAAAAAAA//////AAAAAAAAAB/////4AAAAAAAAAH/////wAAAAAAAAAf/////gAAAAAAAAB/////+AAAAAAAAAH/////+AAAAAAAAAf//////8AAAAAAAA///////8AAAAAAAB///////AAAAAAAAD//////4AAAAAAAAB/////+AAAAAAAAAA//+D/AAAAAAAAAAAAfwDwAAAAAAAAAAAD/AAAAAAAAAAAAAAf+AAAAAAAAAAAAAB/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAAeMAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"ichthyaetus-melanocephalus":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAA/4AAAAAAAAAAAAAP/wAAAAAAAAAAAAD//AAAAAAAAAAAAA//4AAAAAAAAAAAAP//gAAAAAAAAAAAB//+AAAAAAAAAAAAP//8AAAAAAAAAAAD///8AAAAAAAAAAAf///wAAAAAAAAAAD//8/AAAAAAAAAAAf/+A8AAAAAAAAAAD//gAAAAAAAAAAAAf/4AAAAAAAAAAAAD//gAAAAAAAAAAAA//8AAAAAAAAAAAB///wAAAAAAAAAA////+AAAAAAAAAB/////4AAAAAAAAA//////AAAAAAAAAf/////4AAAAAAAAP/////+AAAAAAAAH//////wAAAAAAAH//////+AAAAAAAP///////gAAAAAAP///////8AAAAAAP////////gAAAAAH////////8AAAAAD/////////AAAf///////////4AAH////////////AAAH///////////wAAA///////////+AAAD///////////gAAAD//////////8AAAAD//////////AAAAAf/////////wAAAAH/////////8AAAAAf/////////gAAAAAAAP//////8AAAAAAAAP/////jAAAAAAAAAfP///4gAAAAAAAAAZ////wAAAAAAAAAAP///wAAAAAAAAAAB///gAAAAAAAAAAAD//wAAAAAAAAAAAAD/MAAAAAAAAAAAAAHwwAAAAAAAAAAAAAMGAAAAAAAAAAAAABggAAAAAAAAAAAAAOGAAAAAAAAAAAAABwwAAAAAAAAAAAAAEGAAAAAAAAAAAAAAgwAAAAAAAAAAAAAGCAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGGAAAAAAAAAAAAAAw8AAAAAAAAAAAAAGH/wAAAAAAAAAAAAQ/4AAAAAAAAAAAAGH/AAAAAAAAAAAAA4/4AAAAAAAAAAAAH/ggAAAAAAAAAAAA/4AAAAAAAAAAAAAH+AAAAAAAAAAAAAAfwAAAAAAAAAAAAAD/AAAAAAAAAAAAAAcAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-argentatus-2":{"w":93,"h":62,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAB4AAAAAAAAAAAAAB/AAAAAAAAAAAAAB/wAAAAAAAAAAAAB/+AAAAAAAAAAAAA//gPAAAAAAAAAAAf/4A/AAAAAAAAAAP/+AH+AAAAAAAAAH//gAf8AAAAAAAAH//4AB/8AAAAAAAD//+AAH/wAAAAAAB///gAAf/wAAAAAA///4AAB//gAAAAAP//+AAAH//AAAAAH///gAAAf/8AAAAB///4AAAB//4AAAA///8AAAAH//gAAAP///AAAAAP/+AAAD///wAAAAA//8AAA///8AAAAAB//wAAH//+AAAAAAH//gAB///gAAAAAAf//AAP//4AAAAAAD//8AB///AAAAAAAH//4AP//wAAAAAAAf//gD//+AAAAAAAA//+Af//gAAAAAAAB//4D//8AAAAAAAAD//gf//gAAAAAAAAP/+H//8AAAAAAAAA//4///AAAAAAAAAD//P//4AAAAAAAAAP/9///AAAAAAAAAB/////wAAAAAAAAAH////+AAAAAAAAAA/////gAAAAAAAAAD////8AAAAAAAAAAf////AAAAAAAAAAD////wAAAAAAAAAAP///+AAAAAAAAAA/////gAAAAAAAAA/////8AAAAAAAAAP/////gAAAAAAAAD/////8AAAAAAAAA//////gAAAAAAAA//////8AAAAAAAAP//////4AAAAAAAB4//////gAAAAAAAAB//////gAAAAAAAAD//////wAAAAAAAAP///////gAAAAAAA///////8AAAAAAAB///////AAAAAAAAD//////4AAAAAAAAB/////8AAAAAAAAAA/////AAAAAAAAAAAAAf/gAAAAAAAAAAAABOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"larus-argentatus":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAf/AAAAAAAAAAAAAH/8AAAAAAAAAAAAB//wAAAAAAAAAAAAf//AAAAAAAAAAAAH//4AAAAAAAAAAAH///gAAAAAAAAAAP///8AAAAAAAAAAD////gAAAAAAAAAA////8AAAAAAAAAAP////gAAAAAAAAAB8D//+AAAAAAAAAAAAP//wAAAAAAAAAAAA//+AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAAX//wAAAAAAAAAAAAf/+AAAAAAAAAAAAD//8AAAAAAAAAAAAf//8AAAAAAAAAAAD///8AAAAAAAAAAAf///+AAAAAAAAAAD////+AAAAAAAAAAf////8AAAAAAAAAD/////4AAAAAAAAAf/////wAAAAAAAAD//////gAAAAAAAAf/////+AAAAAAAAD//////8AAAAAAAAP//////wAAAAAAAB+P/////AAAAAAAAHA/////8AAAAAAAAAD/////wAAAAAAAAAf/////gAAAAAAAAD//////gAAAAAAAAP/////+AAAAAAAAB//////8AAAAAAAAP//////wAAAAAAAB///////AAAAAAAAH//////8AAAAAAAA///////wAAAAAgAD///////AAAAACAAf//////4AAAAAIAD///////gAAAAAgAf//////8AAAAACAB///////wAAAAAAAP///////gAAAAAAB////////AAAAAAAH////////AAAAAAA////////+AAAAAAH////////+AAAAAA/////////4AAAAAH//wB/////gAAAAA//4AH////4AAAAAD/+AAA////AAAAAAP/wAAA//gIAAAAABswAAAA/8AAAAAAAc8AAAAA/AAAAAAADjAAAAAAgAAAAAAAM4AAAAAAAAAAAAABnAAAAAAAAAAAAAAI4AAAAAAAAAAAAABHAAAAAAAAAAAAAAYwAAAAAAAAAAAAADGAAAAAAAAAAAAAAYwAAAAAAAAAAAAADGAAAAAAAAAAAAAw8wAAAAAAAAAAAB//mAAAAAAAAAAAAD/4wAAAAAAAAAAAAP/GAAAAAAAAAAAAD//wAAAAAAAAAAAAA/+AAAAAAAAAAAAAD/wAAAAAAAAAAAAA/+AAAAAAAAAAAAAP/gAAAAAAAAAAAAAH4AAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"larus-cachinnans-2":{"w":93,"h":33,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAA/wAAAAAAAAAAAAAB///AAAAAAP////gB///wAAAAP////4AH///gAAAD////4AAH///AAAB////4AAAH//+AAAf///8AAAAH//8AAP///wAAAAAD//4AD///AAAAAAAD//gA///AAAAAAAAD//Af//gAAAAAAAAD//v//wAAAAAAAAAH////4AAAAAAAAAAP///+AAAAAAAAAAB////gAAAAAAAAAAP///wAAAAAAAAAAH///4AAAAAAAAAABn//+AAAAAAAAAAAAP//wAAAAAAAAAAAA///AAAAAAAAAAAAD///AAAAAAAAAAAAH///gAAAAAAAAAAAH///AAAAAAAAAAAAH//4AAAAAAAAAAAAD/+AAAAAAAAAAAAAP/AAAAAAAAAAAAAA/4AAAAAAAAAAAAADnAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-cachinnans":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAB/4AAAAAAAAAAAAAf/wAAAAAAAAAAAAH//AAAAAAAAAAAAB//4AAAAAAAAAAAAP//gAAAAAAAAAAAD//8AAAAAAAAAAAB///gAAAAAAAAAAB///+AAAAAAAAAAAf///wAAAAAAAAAAH///+AAAAAAAAAAB+P//wAAAAAAAAAABA//+AAAAAAAAAAAAD//wAAAAAAAAAAAA//8AAAAAAAAAAAAH//gAAAAAAAAAAAB//8AAAAAAAAAAAAf//wAAAAAAAAAAAD///gAAAAAAAAAAA////wAAAAAAAAAAH/////AAAAAAAAAA//////gAAAAAAAAH//////gAAAAAAAB///////AAAAAAAAP///////AAAAAAAB///////+AAAAAAAP///////8AAAAAAB////////wAAAAAAP////////AAAAAAA/////////gAAAAAH/////////AAAAAAf////////+AAAAAD/////////4AAAAAf/////////wAAAAB//////////AAAAAP/////////8AAAAB//////////wAAAAH//////////AAAAA//////////8AAAAH///////////AAAA////////////wAAD////////////4AAP////////////gAA////////////gAAD///////////+AAAP///////////wAAAf/////////+AAAAA//////////4AAAAB//////////AAAAAB/////wAD/wAAAAAA////wAAAcAAAAAAD///wAAAAAAAAAAAP//wAAAAAAAAAAAA/+AAAAAAAAAAAAAP/AAAAAAAAAAAAAB3wAAAAAAAAAAAAAGcAAAAAAAAAAAAAAzwAAAAAAAAAAAAAGeAAAAAAAAAAAAAAxgAAAAAAAAAAAAAGMAAAAAAAAAAAAAAxgAAAAAAAAAAAAAGMAAAAAAAAAAAAAA5gAAAAAAAAAAAB9/MAAAAAAAAAAAAH/xgAAAAAAAAAAAA/+MAAAAAAAAAAAAP/hwAAAAAAAAAAAB/4eAAAAAAAAAAAAAf/gAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/AAAAAAAAAAAAAD/4AAAAAAAAAAAAA/+AAAAAAAAAAAAAAfgAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-canus-2":{"w":84,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPgAAAAAAAAAAAAH4AAAAAAAMAAAAH/AAAAAAAMAAAAH/wAAAAAAOAAAAD/8AAAAAAfAAAAA//gAAAAAfgAAAAf/4AAAAAPwAAAAf/8AAAAAPwAAAAf//AAAAAP4AAAAP//wAAAAf4AAAAD//8AAAAf8AAAAD//+AAAAf+AAAAD///gAAAf+AAAAB///4AAAf/AAAAAf//+AAAf/AAAAAP///AAAf/gAAAAH///wAAf/gAAAAH///4AA//gAAAAD///8AA//wAAAAB///+AA//wAAAAA////AA//wAAAAAf///wA//4AAAAAP///4A//4AAAAAH///8A//4AAAAAD///+A//4AAAAAA///+A//8AAAAAAf///A//8AAAAAAP///gf/8AAAAAAD///gf/8AAAAAAD///gf/8AAAAAAD///g//8AAAAAAD///h//8AAAAAAD///h//8AAAAAAD///j//4AAAAAAB///3//4AAAAAAB///3//wAAAAAAB//////gAAAAAAB//////AAAAAAAB/////+AAAAAAAA/////8AAAAAAAA/////4AAAAAAAA/////4AAAAAAAAf////wAAAAAAAAf////wAAAAAAAAf////gAAAAAAAAP////gAAAAAAAAP////gAAAAAAAAP////gAAAAAAAAH////gAAAAAAAAH////gAAAAAAAAD////g4AAAAAAAD//////gAAAAAAB//////wAAAAAAB//////4AAAAAAB//////8AAAAAAA//////+AAAAAAA///////wAAAAAA///////4AAAAAB//////w8AAAAAB//////AAAAAAAB/////4AAAAAAAD/////wAAAAAAAH/////gAAAAAAAP/////AAAAAAAA/////+AAAAAAAf/////8AAAAAAf//////wAAAAAP///////gAAAAAP//////8AAAAAAP//////wAAAAAAH/////+AAAAAAAH/////wAAAAAAAD//+5+AAAAAAAAD//8w4AAAAAAAAB//4RgAAAAAAAAA//wQgAAAAAAAAAP/wYwAAAAAAAAABsAYQAAAAAAAAAAAAIYAAAAAAAAAAAAYYAAAAAAAAAAAAcYAAAAAAAAAAAA48AAAAAAAAAAAB54AAAAAAAAAAADz4AAAAAAAAAAADjwAAAAAAAAAAADhwAAAAAAAAAAADBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"larus-canus":{"w":93,"h":71,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB+AAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAH//AAAAAAAAAAAAB//8AAAAAAAAAAAAf//gAAAAAAAAAAAP//8AAAAAAAAAAAf///wAAAAAAAAAAH///+AAAAAAAAAAB////wAAAAAAAAAAAA//+AAAAAAAAAAAAD//wAAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAB//+AAAAAAAAAAAAD//8AAAAAAAAAAAAf//4AAAAAAAAAAAD///4AAAAAAAAAAAP///8AAAAAAAAAAA////8AAAAAAAAAAH////4AAAAAAAAAA/////wAAAAAAAAAD/////gAAAAAAAAAf////+AAAAAAAAAB/////8AAAAAAAAAP/////wAAAAAAAAA//////gAAAAAAAAH/////+AAAAAAAAA//////8AAAAAAAAD//////4AAAAAAAAf//////4AAAAAAAD///////wAAAAAAAP///////AAAAAAAB///////+AAAAAAAP///////4AAAAAAB////////gAAAAAAP///////+AAAAAAA////////4AAAAAAH////////8AAAAAA/////////+AAAAAH/////////+AAAAA//////////+AAAAD//////////+AAAAH//////////4AAAAH/////////wAAAAAP///+B////gAAAAA///4AA//wEAAAAAD/fwAAAf+AAAAAAAPwAAAAAfAAAAAAAA2AAAAAAAAAAAAAAGwAAAAAAAAAAAAAB2AAAAAAAAAAAAAAOwAAAAAAAAAAAAAAmAAAAAAAAAAAAAAEwAAAAAAAAAAAAAAmAAAAAAAAAAAAAAEwAAAAAAAAAAAAAd/AAAAAAAAAAAAAH/wAAAAAAAAAAAAD/+AAAAAAAAAAAAD//AAAAAAAAAAAAAP/gAAAAAAAAAAAAAf8AAAAAAAAAAAAAD4AAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"larus-delawarensis-2":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAwAAAAAAAAAAAAAP+AAAAAAAAAAAAB//gAAAAAAAAAAAH//4AAAAAAAAAAAf//+AAAAAAAAAAA////AAAAAAAAAAA////wAAAAAAAAAAf///4AAAAAAAAAAf///8AAAAAAAAAAP////AAAAAAAAAAD////gAAAAAAAAAA////wAAAAAAAAAAP///4AAAAAAAAAAD///+AAAAAAAAAAAf///gAAAAAAAAAAD///wAAAAAAAAAAA///4AAAAAAAAAAAH//+AAAAAAAAAAAA///gAAAAAAAAAAAH//4AAAAAAAAAAAA///AAAAAAAAAAAAH//4AAAAAAAAAAAB//+AAAAAAAAAAAAP//wAAAAAAAAAAAB//+AAAAAAAAAAAAf//wAAAAAAAAAAAD//8AAAAAAAAAAAA///gAAAAAAAAAAAP//8AAAAAAAAAAAB///AAAAAAAAAAAAf//4AAAAAAAAA/gP//+AAAAAAAAAf/////wAAAAAAAAH/////8AAAAAAAAA//////gAAAAAAAAP/////8AAAAAAAAP//////gAAAAAAAD//////8AAAAAAAA8P/////gAAAAAAAEAP////+AAAAAAAAAB/////8AAAAAAAAD//////wAAAAAAAP/////////gAAAAH/////////+AAAAB//////////wAAAAf/////////+AAAAH//////////gAAAB//////////8AAAAP//////////AAAAD/////f////4AAAAf////AH///+AAAAH////gAAH//gAAAA////AAAAf/4AAAAP///AAAAD/4AAAAD///AAAAAPzAAAAAf//gAAAAA8AAAAAH//gAAAAADwAAAAA//8AAAAAAGAAAAAH//AAAAAAAAAAAAB//wAAAAAAAAAAAAP/+AAAAAAAAAAAAD//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+AAAAAAAAAAAAA//wAAAAAAAAAAAAP/8AAAAAAAAAAAAB/+AAAAAAAAAAAAAf/wAAAAAAAAAAAAD/4AAAAAAAAAAAAAf+AAAAAAAAAAAAAH/wAAAAAAAAAAAAA/8AAAAAAAAAAAAAP+AAAAAAAAAAAAAB/gAAAAAAAAAAAAAP4AAAAAAAAAAAAAB8AAAAAAAAAAAAAAfAAAAAAAAAAAAAADwAAAAAAAAAAAAAAcAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-delawarensis":{"w":93,"h":70,"bits":"AAAAAAAAAAAAAAAAAA/4AAAAAAAAAAAAAf/wAAAAAAAAAAAAH//AAAAAAAAAAAAB//8AAAAAAAAAAAAf//gAAAAAAAAAAAH//+AAAAAAAAAAAB///wAAAAAAAAAAB///+AAAAAAAAAAA////wAAAAAAAAAAP////AAAAAAAAAAD+f//4AAAAAAAAAAeB///AAAAAAAAAAAAH//4AAAAAAAAAAAA///wAAAAAAAAAAAP///4AAAAAAAAAAD////4AAAAAAAAAAf////4AAAAAAAAAH/////4AAAAAAAAA//////4AAAAAAAAH//////wAAAAAAAA///////AAAAAAAAH//////+AAAAAAAA///////4AAAAAAAH///////wAAAAAAA////////AAAAAAAH///////8AAAAAAA////////wAAAAAAD////////AAAAAAAf///////8AAAAAAD////////4AAAAAAP////////wAAAAAB/////////gAAAAAH////////+AAAAAA/////////4AAAAAD/////////wAAAAAP/////////AAAAAB/////////8AAAAAH/////////wAAAAAf/////////AAAAAB/////////8AAAAAH/////////gAAAAAP/////////AAAAAA//////////AAAAAB//////////AAAAAD/////////+AAAAAD/////////+AAAAAH/////////8AAAAAf//+AB////wAAAAB/9+AAA///wAAAAAHmAAAAA//gAAAAAA4wAAAAA/4AAAAAAGGAAAAAAcAAAAAAA4wAAAAAAAAAAAAAHGAAAAAAAAAAAAAA4wAAAAAAAAAAAAAGGAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGGAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGGAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGPAAAAAAAAAAAAAD/wAAAAAAAAAAAAH/+AAAAAAAAAAAAB//AAAAAAAAAAAAB//AAAAAAAAAAAAAD/wAAAAAAAAAAAAA/AAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"larus-fuscus-2":{"w":81,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAB4AAAAAAAAAAAAPwAAAAAAAAAAAA/gAAAAAAAAAAAH+AAAAAAAAAAAAf8AAAAAAAAAAAD/4AAAAAAAAAAAP/gAAAAAAAAAAB//AAAAAAAAAAAH/+AAAAAAAAAAA//4AAAAAAAAAAD//gAAAAAAAAAAP/+AAAAAAAAAAB//4AAAAAAAAAAH//4AAAAAAAAAAf//4AAAAAAAAAD///4AAAAAAAAAP///wAAAAAAAAA////gAAAAAAAAD///+AAAAAAAAAP///8AAAAAAAAA////wAAAAAAAAD////AAAAAAAAAD///8AAAAAAAAAD///wAAAAAAAAAD///AAAAAAAAAAH//8AAAAAAAAAAf//wAAAAAAAAAB///AAAAAAAAAAP//+AAAAAAAAAB///4AAAAAAAAAP///8AAPgAAAAB/////B/8AAAAAP///////gAAAAB///////8AAAAD////////wAAAD////////+AAAB/////////4AAAf/////////gAAD/////////8AAA/////////4AAAf////////4AAAP/////////AAAD9////////8AAAcB//////j/wAAAAB/////8PgAAAAAH/////wAAAAAAAH////+AAAAAAAAAAH//wAAAAAAAAAA//+AAAAAAAAAAH//wAAAAAAAAAA//+AAAAAAAAAAH//wAAAAAAAAAA//+AAAAAAAAAAH//wAAAAAAAAAB//8AAAAAAAAAAP//gAAAAAAAAAB//8AAAAAAAAAAP//gAAAAAAAAAB//8AAAAAAAAAAH//wAAAAAAAAAAf//AAAAAAAAAAB//4AAAAAAAAAAH//AAAAAAAAAAA//8AAAAAAAAAAD//wAAAAAAAAAAf/+AAAAAAAAAAB//4AAAAAAAAAAP//AAAAAAAAAAA//8AAAAAAAAAAD//gAAAAAAAAAAP/8AAAAAAAAAAA//wAAAAAAAAAAD/+AAAAAAAAAAAP/wAAAAAAAAAAA//AAAAAAAAAAAH/4AAAAAAAAAAAf/AAAAAAAAAAAB/4AAAAAAAAAAAH/gAAAAAAAAAAAf8AAAAAAAAAAAB/gAAAAAAAAAAAD+AAAAAAAAAAAAPwAAAAAAAAAAAA+AAAAAAAAAAAAD4AAAAAAAAAAAAPAAAAAAAAAAAAAYAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-fuscus":{"w":93,"h":73,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAB/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAf//AAAAAAAAAAAAf//4AAAAAAAAAAAf///gAAAAAAAAAAH///8AAAAAAAAAAB/H//gAAAAAAAAAAPAP/8AAAAAAAAAAAAA//gAAAAAAAAAAAAP/8AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH//AAAAAAAAAAAAA//8AAAAAAAAAAAAP//wAAAAAAAAAAAB///wAAAAAAAAAAAP///wAAAAAAAAAAD////4AAAAAAAAAAf////8AAAAAAAAAD/////8AAAAAAAAAf/////8AAAAAAAAD//////4AAAAAAAAf//////wAAAAAAAD///////AAAAAAAAf//////+AAAAAAAB///////8AAAAAAAP///////wAAAAAAB////////AAAAAAAD////////AAAAAAAP///////+AAAAAAB////////8AAAAAAH////////wAAAAAAf////////gAAAAAD////////+AAAAAAf////////4AAAAAB/////////gAAAAAH////////+AAAAAA/////////8AAAAAH//////////gAAAAf//////////gAAAB///////////wAAAD///////////gAAAH/////////+AAAAAP/////////wAAAAAP/////////gAAAAAP///gP////AAAAAA///gAD//gAAAAAAD//gAAB/8AAAAAAAPwAAAAA+AAAAAAAB4AAAAAAAAAAAAAAGAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAGAAAAAAAAAAAAAAYwAAAAAAAAAAAAAH/AAAAAAAAAAAAAH/4AAAAAAAAAAAAAP+AAAAAAAAAAAAAA84AAAAAAAAAAAAAP/gAAAAAAAAAAAAP/wAAAAAAAAAAAAAf+AAAAAAAAAAAAAB+AAAAAAAAAAAAAAHAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-marinus-2":{"w":93,"h":80,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAD8AAAAAAAAAAAAAAP8AAAAAAAAAAAAAAf8AAAAAAAAAAAAAA/+AAAAAAAAAAAAAB/+AAAAAAAAAAAAAD//AAAAAAAAAAAAAD//AAAAAAAAAAAAAD//gAAAAAAAAAAAAP//8AAAAAAAAAAAAf//4AAAAAAAAAAAAP//wAAAAAAAAAAAAf//gAAAAAAAAAAAAf//AAAAAAAAAAAAA//8AAAAAAAAAAAAB//wAAAAAAAAAAAAH//AAAAAAAAAAAAAP/8AAAAAAAAAAAAB//wAAAAAAAAAAAAH//AAAAAAAAAAAAA//8AAAAAAAAAAAAD//wAAAAAAAAAAAAf//4AAAAAAAAAAAD///8AAAAAAAAAAH////8AAAAAAAAAf/////8AAAAAAAAP//////+AAAAAAAD////////+AAAAAA/////////wAAAAAP///n/////AAAAAP///4H////8AAAAD///+Af////wAAAA////wA////+AAAAHAf/+AD///wAAAAAAA//wAf//gAAAAAAAD/+AB//4AAAAAAAAH/wAH//gAAAAAAAAP+AA//8AAAAAAAAAHwAH//wAAAAAAAAAAAAf/+AAAAAAAAAAAAD//wAAAAAAAAAAAAf/+AAAAAAAAAAAAD//wAAAAAAAAAAAAf/+AAAAAAAAAAAAB//wAAAAAAAAAAAAH/+AAAAAAAAAAAAA//4AAAAAAAAAAAAD//AAAAAAAAAAAAAP/8AAAAAAAAAAAAB//wAAAAAAAAAAAAH/+AAAAAAAAAAAAA//4AAAAAAAAAAAAD//gAAAAAAAAAAAAP/+AAAAAAAAAAAAB//wAAAAAAAAAAAAH//AAAAAAAAAAAAAf/4AAAAAAAAAAAAB//AAAAAAAAAAAAAH/8AAAAAAAAAAAAAf/gAAAAAAAAAAAAB/+AAAAAAAAAAAAAH/wAAAAAAAAAAAAA/+AAAAAAAAAAAAAD/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAA/8AAAAAAAAAAAAAD/gAAAAAAAAAAAAAP8AAAAAAAAAAAAAA/wAAAAAAAAAAAAAD+AAAAAAAAAAAAAAHwAAAAAAAAAAAAAAfAAAAAAAAAAAAAAB8AAAAAAAAAAAAAAHgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-marinus":{"w":93,"h":89,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgAAAAAAAAAAAAAf/AAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAf//AAAAAAAAAAAAH//8AAAAAAAAAAAD///gAAAAAAAAAAP///+AAAAAAAAAAD////wAAAAAAAAAA////+AAAAAAAAAAH////wAAAAAAAAAB+B//+AAAAAAAAAAAAH//wAAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAA//8AAAAAAAAAAAAP//gAAAAAAAAAAAD//8AAAAAAAAAAAA///gAAAAAAAAAAAH//8AAAAAAAAAAAB///gAAAAAAAAAAAP//+AAAAAAAAAAAB///4AAAAAAAAAAAf///wAAAAAAAAAAD////gAAAAAAAAAAf////AAAAAAAAAAD/////gAAAAAAAAAf/////gAAAAAAAAD//////gAAAAAAAAf//////AAAAAAAAD//////+AAAAAAAAf//////4AAAAAAAH///////wAAAAAAA////////AAAAAAAH///////+AAAAAAA////////4AAAAAAH////////gAAAAAA////////+AAAAAAH////////wAAAAAAf////////gAAAAAD/////////AAAAAAf////////+AAAAAD/////////4AAAAAD/////////gAAAABf////////+AAAAAF/////////wAAAAAH/////////gAAAAC/////////+AAAAAL/////////4AAAAA//////////AAAAAD/////////4AAAAAP/////////gAAAAA/////////8AAAAAB/////////wAAAAAD/////////gAAAAAH/////////AAAAAAP/////////AAAAAAP////////+AAAAAA/////////8AAAAAB/////////4AAAAAP///AH////gAAAAB/5/AAB///wAAAAAD4AAAAB//+AAAAAAfAAAAAB/z4AAAAAD4AAAAAB4BgAAAAAfAAAAAAAAAAAAAAH4AAAAAAAAAAAAAAeAAAAAAAAAAAAAADwAAAAAAAAAAAAAAeAAAAAAAAAAAAAADwAAAAAAAAAAAAAAeAAAAAAAAAAAAAADwAAAAAAAAAAAAAAeAAAAAAAAAAAAAAD4AAAAAAAAAAAAAOfAAAAAAAAAAAAAf/4AAAAAAAAAAAAB/+AAAAAAAAAAAAAP/gAAAAAAAAAAAAP/8AAAAAAAAAAAAA/+AAAAAAAAAAAAAB/gAAAAAAAAAAAAAHgAAAAAAAAAAAAAA4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-michahellis-2":{"w":93,"h":42,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAB+AAAAAAAAAAAAAB/gAAAAAAAAAAAAD/4AAAAAAAAAAAAD/+AAAAAAAAAAAAP//AEAAAAAAAAAAP//wAwAAAAAAAAAP//8AB4AAAAAAAAP//+AAD8AAAAAAAD///AAAP/4AAAAAA///gAAAP//gAAAAP//wAAAAf//gAAAD//8AAAAAf//wAAA//8AAAAAA///wAAP/+AAAAAAAf//wAD//gAAAAAAA///AA//4AAAAAAAAf/+AP/+AAAAAAAAAf/4D//wAAAAAAAAAP/w//8AAAAAAAAAA/////AAAAAAAAAAA////wAAAAAAAAAAA///8AAAAAAAAAAAH///gAAAAAAAAAAF/5/4AAAAAAAAAANv8APAAAAAAAAAAHwCAAYAAAAAAAAAAwAAAAQAAAAAAAAAAAAAABgAAAAAAAAAAAAAAP4AAAAAAAAAAAAAH//AAAAAAAAAAAAQ//4AAAAAAAAAAAB//+AAAAAAAAAAAAf//AAAAAAAAAAAAAf/AAAAAAAAAAAAAB/8AAAAAAAAAAAAAH7AAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"larus-michahellis":{"w":93,"h":79,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAH//AAAAAAAAAAAAB//8AAAAAAAAAAAAP//wAAAAAAAAAAAB///wAAAAAAAAAAAf///wAAAAAAAAAAD////AAAAAAAAAAAf///8AAAAAAAAAAD//4PgAAAAAAAAAAf/8AAAAAAAAAAAAB//AAAAAAAAAAAAAP/4AAAAAAAAAAAAB//AAAAAAAAAAAAAP/8AAAAAAAAAAAAB//gAAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAAf//AAAAAAAAAAAAH//4AAAAAAAAAAAB//+AAAAAAAAAAAAf//wAAAAAAAAAAAP//+AAAAAAAAAAAP///wAAAAAAAAAAH////AAAAAAAAAAH////4AAAAAAAAAD/////AAAAAAAAAA/////4AAAAAAAAAf/////AAAAAAAAAH/////4AAAAAAAAD//////AAAAAAAAA//////4AAAAAAAAf//////AAAAAAAAH//////4AAAAAAAB//////+AAAAAAAAf//////gAAAAAAAP//////9AAAAAAAH///////oAAAAAAH///////+AAAAAAD////////wAAAAAA////////8AAAAAAf////////AAAAAAH////////4AAAAAD////////+AAAAAA/////////gAAAAAP////////4AAAAAH////////+AAAAAP/////////gAAAAP/////////wAAAAP/////////8AAAAP/////////+AAAAH//////////AAAAAv/////////AAAAAA/////////wAAAAA////+B///8AAAAAP///wAA3/3gAAAAAAH/wAAAAMYAAAAAAAf4AAAABzAAAAAAAB4AAAAAOcAAAAAAAAAAAAABzgAAAAAAAAAAAAAGcAAAAAAAAAAAAAAzgAAAAAAAAAAAAAGMAAAAAAAAAAAAAAxgAAAAAAAAAAAAAGMAAAAAAAAAAAAAAxgAAAAAAAAAAAAAGMAAAAAAAAAAAAAA5wAAAAAAAAAAAAAH/gAAAAAAAAAAAAB//4AAAAAAAAAAAAB//4AAAAAAAAAAAAD/+AAAAAAAAAAAAAH/4AAAAAAAAAAAAAAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"leucophaeus-atricilla-2":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAACAAAAAAAAAAAAAAeAAAAAAAAAAAAAB8AAAAAAAAAAAAAH+OAAAAAAAAAAAAf+fgAAAAAAAAAAB/8fgAAAAAAAAAAH/4fwAAAAAAAAAAf/wf8AAAAAAAAAA//wf8AAAAAAAAAD//wP+AAAAAAAAAP//gP/gAAAAAAAA///AP/gAAAAAAAB//+AP/wAAAAAAAH//8AP/4AAAAAAAP//8AP/8AAAAAAA///8AP/+AAAAAAD///4AP/+AAAAAAP///wAP//AAAAAAf///gAH//gAAAAB////AAH//gAAAAD////AAH//wAAAAH////AAH//4AAAAP///+AAD//4AAAAf///4AAD//4AAAB////4AAD//8AAAD////wAAB//8AAAH////gAAB//8AAAP////AAAB//+AAAf///+AAAA//+AAA////8AAAA//+AAB////4AAAA///AAB////wAAAAf//gAD////AAAAAf//wAD///+AAAAAP//8AD///8AAAAAH//+AH///8AAAAAD///AH///8AAAAAB///gH///4AAAAAA///wP///4AAAAAAf//wP///wAAAAAAP//4P///wAAAAAAH//8f///gAAAAAAD//+f///gAAAAAAB///f///gAAAAAAB///////AAAAAAAA//////+AAAAAAAAf/////+AAAAAAAAf/////+AAAAAAAAf/////8AAAAAAAAP/////8AAAAAAAAP/////4AAAAAAAAP/////4AAAAAAAf//////wAAAAAAB///////wAAAAAAD///////gAAAAAAH///////gAAAAAAP///////AAAAAAAf///////AAAAAAB///////+AAAAAAH///////+AAAAAAPn//////+AAAAAAcA//////8AAAAAAAAf/////8AAAAAAAAP/////8AAAAAAAAH/////8AAAAAAAAH/////8AAAAAAAAD/////8AAAAAAAAD/////8AAAAAAAAB//////AAAAAAAAA//////gAAAAAAAAf/////4AAAAAAAAP/////8AAAAAAAAD//////AAAAAAAAA//////wAAAAAAAAP/////+AAAAAAAAD//////8AAAAAAAAP/////+AAAAAAAAAP/5//+AAAAAAAAADzwB/4AAAAAAAAAAwYAfwAAAAAAAAAAQYABAAAAAAAAAAAYIAAAAAAAAAAAAAIMAAAAAAAAAAAAAMEAAAAAAAAAAAAAMGAAAAAAAAAAAAAGHAAAAAAAAAAAAAHHgAAAAAAAAAAAAH74AAAAAAAAAAAAD/8AAAAAAAAAAAAA8eAAAAAAAAAAAAAcPAAAAAAAAAAAAAOAAAAAAAAAAAAAACAAAAAAA"},"leucophaeus-atricilla":{"w":89,"h":93,"bits":"AAAAAAAAAAAAAAAAAB/gAAAAAAAAAAAAP/wAAAAAAAAAAAB//wAAAAAAAAAAAH//wAAAAAAAAAAAP//wAAAAAAAAAAA///gAAAAAAAAAAD///gAAAAAAAAAAH///AAAAAAAAAAAf//+AAAAAAAAAAD///+AAAAAAAAAA////8AAAAAAAAAH////4AAAAAAAAAf8///wAAAAAAAAB+Af//gAAAAAAAADwAf//AAAAAAAAAIAA//+AAAAAAAAAAAD//8AAAAAAAAAAAH//4AAAAAAAAAAAf//wAAAAAAAAAAA///gAAAAAAAAAAD///AAAAAAAAAAAH//+AAAAAAAAAAAP///AAAAAAAAAAA////AAAAAAAAAAB////gAAAAAAAAAD////4AAAAAAAAAH////+AAAAAAAAAf/////gAAAAAAAA//////wAAAAAAAB//////4AAAAAAAD//////4AAAAAAAH//////8AAAAAAAP//////8AAAAAAAf//////8AAAAAAA///////+AAAAAAB///////+AAAAAAD///////+AAAAAAH///////+AAAAAAP///////8AAAAAAf///////8AAAAAA////////+AAAAAB/////////AAAAAB/////////gAAAAD/////////gAAAAH/////////gAAAAH/////////gAAAAP/////////gAAAAP/////////gAAAAP/////////gAAAAP/////////gAAAAP/////////4AAAAP/////////+AAAAP//////////gAAAP//////////4AAAH//////////4AAAH/////////9wAAAD/////////4AAAAB/////////8AAAAB/////////+AAAAB/////////8AAAAB////4AP/8AAAAAB8f//AAH/4AAAAABgf/4AAB/gAAAAADAfwAAAAcAAAAAAGAeAAAAAAAAAAAAMAcAAAAAAAAAAAAYAYAAAAAAAAAAAAwBwAAAAAAAAAAABgDgAAAAAAAAAAADAHAAAAAAAAAAAAGAEAAAAAAAAAAAAMAIAAAAAAAAAAAAYAQAAAAAAAAAAAAwAgAAAAAAAAAAABgBAAAAAAAAAAAADACAAAAAAAAAAAAGAMAAAAAAAAAAAAMAYAAAAAAAAAAAA8AwAAAAAAAAAAADwBgAAAAAAAAAAf/gDAAAAAAAAAAB//AGAAAAAAAAAAA//AcAAAAAAAAAAA///4AAAAAAAAAAB///4AAAAAAAAAAEAj/wAAAAAAAAAAAAH/gAAAAAAAAAAAAP/AAAAAAAAAAAAA/+AAAAAAAAAAAABAcAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAA"},"limosa-lapponica-2":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAYAAAAAA4AAAAAAAcAAAAAAHQAAAAAAPMAAAAAB+AAAAAAD/AAAAAAPwAAAAAB/gAAAAAB/AAAAAA/+AAAAAAf4AAAAAf/gAAAAAD/AAAAAP/4AAAAAAf8AAAAD/+AAAAAAH/wAAAB//wAAAAAA/+AAAAf/8AAAAAAH/wAAAP//AAAAAAA//AAAD//wAAAAAAP/4AAA//+AAAAAAB//AAAf//gAAAAAAP/4AAH//4AAAAAAB//AAD//+AAAAAAAP/4AA///wAAAAAAD//gAP//8AAAAAAAf/8AD///AAAAAAAD//AB///wAAAAAAAf/8Af//+AAAAAAAD//gH///gAAAAAAAf/8B///4AAAAAAAD//gf//+AAAAAAAAf/8H///AAAAAAAAD//w///4AAAAAAAAf//P//+AAAAAAAAD//9///AAAAAAAAAf/////4AAAAAAAAD//////AAAAAAAAAf/////4AAAAAAAAB//////AAAAAAAAAD/////4AAAAAAAAAP/////AAAAAAAAAA/////wAAAAAAAAAD////+AAAAAAAAPgP////wAAAAAAAH/B////+AAAAAAAB/8P////wAAAAAAAP/x////+AAAAAAAD///////gAAAAAAA///////8AAAAAAAf///////gAAAAAAP///////4AAAAAAPw///////AAAAAAHwA//////4AAAAAHwAB//////gAAAADwAAH/////8AAAABwAAA//////gAAAA4AAAD/////+AAAAAAAAAf/////wAAAAAAAAB//////gAAAAAAAAH//////AAAAAAAAAf/////8AAAAAAAAAf/////4AAAAAAAAA//////8AAAAAAAAB//////8AAAAAAAAH//////4AAAAAAAAP//////AAAAAAAAAf/////4AAAAAAAAAf////+AAAAAAAAAAA//APgAAAAAAAAAAAf+AIAAAAAAAAAAAAM4AAAAAAAAAAAAAAxgAAAAAAAAAAAAABGAAAAAAAAAAAAAAEYAAAAAAAAAAAAAAQgAAAAAAAAAAAAABj8AAAAAAAAAAAAAH/AAAAAAAAAAAAAAe/AAAAAAAAAAAAAB48AAAAAAAAAAAAADw8AAAAAAAAAAAAADggAAAAAAAAAAAAAGAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"limosa-lapponica":{"w":93,"h":51,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAAAAH/gAAAAAAAAAAAAB/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAD//AAAAAAAAAAAAA//4AAAAAAAAAAAAP//gAAAAAAAAAAAH//8AAAAAAAAAAAB///gAAAAAAAAAAA/P/8AAAAAAAAAAAfAP/wAAAAAAAAAAPgB/////wAAAAAAHgAP/////4AAAAADwAB//////4AAAAB4AAP///////AAAAcAAD////////wBgOAAAf/////////8AAAAD//////////gAAAAf/////////8AAAAD//////////8AAAAf//////////AAAAD//////////4AAAAf/////////8AAAAB/////////wAAAAAP////////4AAAAAA////////4AAAAAAD///////8AAAAAAAP///////AAAAAAAA///////gAAAAAAAD//////4AAAAAAAAH/////+AAAAAAAAAP/////AAAAAAAAAAf////AAAAAAAAAAA////AAAAAAAAAAAAP//4AAAAAAAAAAAA///gAAAAAAAAAAAPB/8AAAAAAAAAAAB///AAAAAAAAAAAAPgAAAAAAAAAAAAAD8AAAAAAAAAAAAAA8YAAAAAAAAAAAAAHhAAAAAAAAAAAAAA8AAAAAAAAAAAAAADgAAAAAAAAAAAAAAWAAAAAAAAAAAAAACQAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"limosa-limosa-2":{"w":92,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAD/AAAAAAAAAAAAAH/gAAAAAAAAAAAAf/wAAAAAAAAAAAAf/8AAAAAAAAAAAA//8AAAAAAAAAAAB//+AAAAAAAAAAAB///gAAAAAAAAAAB///gAAAAAAAAAAB///wAAAAAAAAAAB///4AAAAAAAAAAB///8AAAAAAAAAAA///+AAAAAAAAAAA////AAAAAAAAAAA////gAAAAAAAAAAf///wAAAAAAAAAAP///wAAAAAAAAAAH///4AAAAAAAAAAD///8AAAAAAAAAAB///+AAAAAAAAAAAf//+AAAAAAAAAAAH///AAAAAAAAAAAB///AAAAAAAAAAAAf//gAAAAAAAAAAAH//4AAAAAAAAAAAB//+AAAAAAAAAAAAf//gAAAAAAAD+AAH//4AAAAAAAB/4AD//+AAAAAAAA//AA///gAAAAAAAP/4Af//4AAAAAAAH//AH//+AAAAAAAB//4D///gAAAAAAA///////4AAAAAAA///////+AAAAAAA////////AAAAAAAeAf/////wAAAAAAeAD/////8AAAAAAeAA//////AAAAAAOAAP/////wAAAAAOAAB/////8AAAAAOAAAf/////AAAAAGAAAH/////wAAAAHAAAB/////+AAAADAAAAP/////gAAAAAAAAH/////8AAAAAAAAf//////wAAAAAAAP//////+AAAAAAAD///////4AAAAAAB////////gAAAAAAf///////8AAAAAAP////////wAAAAAD/////////wAAAAA//////////gAAAAf///f/////4AAAAH//+Af////8AAAAD//+AA//wD+AAAAA//+AAD/gAAAAAAAP/+AAAD8AAAAAAAD//gAAAPwAAAAAAB//4AAAA+AAAAAAAf/8AAAAHgAAAAAAH//AAAABsAAAAAAB//wAAAANAAAAAAAf/4AAAABIAAAAAAH/+AAAAAbAAAAAAD//AAAAACQAAAAAA//wAAAAASAAAAAAP/8AAAAAGwAAAAAD/+AAAAAAkAAAAAA//AAAAAAMgAAAAAP/wAAAAABsAAAAAH/8AAAAAAP4AAAAB/+AAAAAAD+AAAAAf/AAAAAAAfwAAAAH/wAAAAAAD/AAAAB/8AAAAAAAewAAAAf+AAAAAAAB3AAAAH/AAAAAAAAMQAAAB/gAAAAAAABgAAAAf4AAAAAAAAMAAAAH8AAAAAAAAAAAAAB+AAAAAAAAAAAAAAfgAAAAAAAAAAAAAHwAAAAAAAAAAAAABwAAAAAAAAAAAAAAcAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"limosa-limosa":{"w":93,"h":84,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAA/wAAAAAAAAAAAAAP/AAAAAAAAAAAAAD/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAH/+AAAAAAAAAAAAA//wAAAAAAAAAAAAP//AAAAAAAAAAAAD//4AAAAAAAAAAAA///AAAAAAAAAAAAf//8AAAAAAAAAAAPwf/gAAAAAAAAAAD4B//wAAAAAAAAAB4AP//wAAAAAAAAA8AB///gAAAAAAAAeAAP///gAAAAAAAPAAD////AAAAAAAHAAAf////AAAAAADgAAD////+AAAAAAwAAA/////4AAAAAAAAAH/////wAAAAAAAAA//////AAAAAAAAAH/////+AAAAAAAAA//////4AAAAAAAAH//////wAAAAAAAAf//////AAAAAAAAD//////+AAAAAAAAP//////4AAAAAAAA///////gAAAAAAAD///////AAAAAAAAf//////+AAAAAAAB///////8AAAAAAAH///////4AAAAAAAf///////wAAAAAAB////////gAAAAAAH////////wAAAAAAf////////gAAAAAA////////gAAAAAAB///////+AAAAAAAD///////AAAAAAAAH//////4AAAAAAAAP//+AAAAAAAAAAAA//AAAAAAAAAAAAAD/AAAAAAAAAAAAAAZwAAAAAAAAAAAAABDAAAAAAAAAAAAAAMIAAAAAAAAAAAAABhgAAAAAAAAAAAAAEEAAAAAAAAAAAAAAwwAAAAAAAAAAAAAGHAAAAAAAAAAAAAAw4AAAAAAAAAAAAAHDAAAAAAAAAAAAAAwYAAAAAAAAAAAAAGCAAAAAAAAAAAAAAwQAAAAAAAAAAAAAECAAAAAAAAAAAAABgQAAAAAAAAAAAAAMCAAAAAAAAAAAAABAQAAAAAAAAAAAAAICAAAAAAAAAAAAADAQAAAAAAAAAAAAAQCAAAAAAAAAAAAACAQAAAAAAAAAAAAAwCAAAAAAAAAAAAAGAQAAAAAAAAAAAAAgCAAAAAAAAAAAAAEAQAAAAAAAAAAAABgCAAAAAAAAAAAAAMAQAAAAAAAAAAAABADAAAAAAAAAAAAAYA8AAAAAAAAAAAADweQAAAAAAAAAAAA7/gAAAAAAAAAAAD+AYAAAAAAAAAAABjgMAAAAAAAAAAAABwOAAAAAAAAAAAAA4DAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"linaria-cannabina-2":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAOGAAAAAAAAAAAAADzgAAAAAAAAAAAAB94AAAAAAAAAAAAAf+4AAAAAAAAAAAAP/+AAAAAAAAAAAAD//gAAAAAAAAAAAB//4AAAAAAAAAAAAf/8AAAAAAAAAAAAH//cAAAAAAAAAAAD///AAAAAAAAAAAA///gAAAAAAAAAAAP//4AAAAAAAAAAAD//+gAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAH///gAAAAAAAAAAD///8AAAAAAAAAAA////AAAAAAAAAAAP///wAAAAAAAAAAD///8AAAAAAAAAAA////AAAAAAAAB+AH///wAAAAAAAA/8B///4AAAAAAAAf/4f///AAAAAAAAH//j///wAAAAAAAB//////+AAAAAAAAf//////wAAAAAAAH//////+AAAAAAAAP//////wAAAAAAAAf//////AAAAAAAAB//////4AAAAAAAAH/////+AAAAAAAAA//////4AAAAAAAAD//////AAAAAAAAAf/////wAAAAAAAB//////+AAAAAAAA///////wAAAAAAAf//////8AAAAAAAP///////gAAAAAAD//////+gAAAAAAB///////wAAAAAAAf///////AAAAAAAH///////8AAAAAAD////////gAAAAAA////////+AAAAAAf////////4AAAAAH/////////AAAAAB/////////8AAAAA//////////wAAAAP/////////+AAAAD//////9///4AAAA///////P///wAAAP/////9D////AAAH////AAAc7//8AAB////gAADfH//4AAf///4AAAM4B//gAGf//6AAABwgH//AAH//+AAAAGAA//8AB739gAAAAAAD//4Ac9zAAAAAAAAP//wGPMwAAAAAAAA///ABjAAAAAAAAAH//8AQQAAAAAAAAAfwQAAAAAAAAAAAAD+AAAAAAAAAAAAAAPwAAAAAAAAAAAAAA+AAAAAAAAAAAAAAHwAAAAAAAAAAAAAAcAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"linaria-cannabina":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAAAAAH/4AAAAAAAAAAAAB//wAAAAAAAAAAAA///AAAAAAAAAAAAP//8AAAAAAAAAAAH///wAAAAAAAAAAD////AAAAAAAAAAA////8AAAAAAAAAAH////wAAAAAAAAAAP///+AAAAAAAAAAAf///4AAAAAAAAAAB////gAAAAAAAAAAP///8AAAAAAAAAAB////wAAAAAAAAAAH////gAAAAAAAAAA/////AAAAAAAAAAH////8AAAAAAAAAA/////4AAAAAAAAAD/////wAAAAAAAAAf/////AAAAAAAAAD/////8AAAAAAAAAf/////4AAAAAAAAD//////gAAAAAAAAf/////+AAAAAAAAD//////4AAAAAAAAf//////gAAAAAAAD//////+AAAAAAAAP//////4AAAAAAAB///////gAAAAAAAP///////AAAAAAAA///////8AAAAAAAH///////wAAAAAAA////////AAAAAAAD///////8AAAAAAAf///////wAAAAAAB///////+AAAAAAAH///////4AAAAAAAf///////gAAAAAAD///////+AAAAAAAP///////4AAAAAAA////////AAAAAAAB///////8AAAAAAAH///////gAAAAAAAf//////+AAAAAAAA///////4AAAAAAAD///////gAAAAAAAH//////+AAAAAAAAP//////4AAAAAAAAf//////AAAAAAAAAf//+P/8AAAAAAAAP///w//wAAAAAAAHwf/+D//AAAAAAAB/B8AAP/IAAAAAAAOMHgAA/8AAAAAAABgzwAAD/wAAAAAAAIG4AAAP/AAAAAAABA8AAAA/8AAAAAAAAPAAAAD/wAAAAAAADgAAAAP/AAAAAAAB4AAAAA/8AAAAAAA+AAAAAD/4AAAAAAf4AAAAAH/gAAAAADxwAAAAA/+AAAAAAcDAAAAAB/4AAAAADAYAAAAAH/gAAAAAYDAAAAAAf+AAAAADAgAAAAAB/4AAAAAIAAAAAAAH/gAAAABAAAAAAAA/+AAAAAAAAAAAAAD/4AAAAAAAAAAAAAP/gAAAAAAAAAAAAA+MAAAAAAAAAAAAAD4AAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"loxia-curvirostra-2":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAIQAAAAAAAAAAAAADGAAAAAAAAAAAAAAxgAAAAAAAAAAAAAOcgAAAAAAAAAAAABnMAAAAAAAAAAAAAdzAAAAAAAAAAAAAH84AAAAAAAAAAAAB/+AAAAAAAAAAAAAf/kAAAAAAAAAAAAH/7gAAAAAAAAAAAB//4AAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAB//9AAAAAAAAAAAAf//4AAAAAAAAAAAH//+AAAAAAAAAAAB///wAAAAAAAAAAAf//8AAAAAAAAAAAH///AAAAAAAAAAAB///8AAAAAAAAAAAf///gAAAAAAAAAAH///4AAAAAAAAAAB////AAAAAAAAAAAf///wAAAAAAAAAAH///8AAAAAAAAAAA////gAAAAAAAAAAP///8AAAAAAAAAAD////AAAAAAAAAAA////wAAAAAAAAAAH///8AAAAAAAH/AB////AAAAAAAD//AP///wAAAAAAA//8D///+AAAAAAAP//4////4AAAAAAD////////AAAAAAA////////4AAAAAAP////////AAAAAAB////////4AAAAAAB////////AAAAAAAD///////4AAAAAAAP///////AAAAAAAA///////wAAAAAAAD//////+AAAAAAAAf//////wAAAAAAAB//////8AAAAAAAAH//////gAAAAAAAH//////8AAAAAAAH///////AAAAAAAD//////2QAAAAAAB///////AAAAAAAA///////8AAAAAAAP///////gAAAAAAD///////+AAAAAAB////////wAAAAAA/////////AAAAAAf////////8AAAAAP/////////wAAAAP//////////AAAP///////////4AAAf///////////gAAAf//////////+AAD////////////8AAf///////+/3//wAAD///////h/P//gAD///////gb4P//AAYP////9gDng//+AAHz///4AAMCD//8ABx9//wAAB4AP//8AAee9gAAADgA///wAACGAAAAAAAH//+AAAAAAAAAAAAf//gAAAAAAAAAAAB//4AAAAAAAAAAAAH/wAAAAAAAAAAAAA/wAAAAAAAAAAAAAD+AAAAAAAAAAAAAAPwAAAAAAAAAAAAAB+AAAAAAAAAAAAAAHgAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAA"},"loxia-curvirostra":{"w":93,"h":65,"bits":"AAf8AAAAAAAAAAAAAf/4AAAAAAAAAAAAH//wAAAAAAAAAAAD///gAAAAAAAAAAA///+AAAAAAAAAAAf///4AAAAAAAAAAH////gAAAAAAAAAB////+AAAAAAAAAAf////wAAAAAAAAAH/////AAAAAAAAAAD////8AAAAAAAAAAH////4AAAAAAAAAA/////8AAAAAAAAAH/////4AAAAAAAAAf/////wAAAAAAAAB//////gAAAAAAAAP//////AAAAAAAAB//////+AAAAAAAAH//////4AAAAAAAA///////wAAAAAAAH///////AAAAAAAA///////+AAAAAAAH///////8AAAAAAAf///////wAAAAAAD////////gAAAAAAf///////+AAAAAAD////////4AAAAAAP////////gAAAAAB/////////AAAAAAH////////8AAAAAA/////////wAAAAAD/////////AAAAAAf////////4AAAAAB/////////gAAAAAH/////////AAAAAA/////////8AAAAAD/////////4AAAAAP/////////gAAAAA/////////+AAAAAD/////////8AAAAAP/////////wAAAAA//////////AAAAAB/////////+AAAAAH////////+AAAAAAP////////4AAAAAAf///////hgAAAAAA///////+AAAAAAAB////gf/4AAAAAAAH///AA//gAAAAAAA///AAA//AAAAAAAH//4AAA/8AAAAAAA//+AAAD/wAAAAAAD/4AAAAP/AAAAAAAP4AAAAA/+AAAAAAA+AAAAAD/4AAAAAAP/gAAAAP/gAAAAAD4+AAAAA/+AAAAAAeBwAAAAD/4AAAAAByCAAAAAH/gAAAAAP4wAAAAAf+AAAAAA+AAAAAAB/4AAAAAB8AAAAAAH8AAAAAAHAAAAAAAfgAAAAAAAAAAAAAB8AAAAAAAAAAAAAADA"},"lullula-arborea-2":{"w":93,"h":67,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABkAAAAAAAAAAAAAAH4AAAAAAAAAAAAAAf8AAAAAAAAAAAAAD/4AAAAAAAAAAAAAP/4AAAAAAAAAAAAA//gAAAAAAAAAD/AH/+AAAAAAAAAf/wAf/+AAAAAAAA//9AB//4AAAAAAB///4AH//wAAAAAD///8AAf//AAAAAD////AAB//8AAAAH////4AAH//4AAAD////+AAAf//AAAB/////AAAB//+AAB/////wAAAH//+AA/////8AAAAf//4AP////+AAAAB///wH/////AAAAAP///h/////wAAAAA///+P////8AAAAAB///7////+AAAAAAB////////gAAAAAAf///////gAAAAAAH///////wAAAAAAB///////4AAAAAAAf///////gAAAAAAH///////8AAAAAAD////////AAAAAAA////////8AAAAAAP////////gAAAAAAD///////4AAAAAAAH///////gAAAAAAAf//////8AAAAAAAB///////AAAAAAAAH//////4AAAAAAAAf//////AAAAAAAAD//////wAAAAAAAAP/////+AAAAAAAAB//////wAAAAAAAAH/////gAAAAAAAAAf////+AAAAAAAAAB/////wAAAAAAAAAP/////AAAAAAAAAA/////8AAAAAAAAAB/////gAAAAAAAAAD////+AAAAAAAAAAH////4AAAAAAAAAAP////AAAAAAAAAAAP///8AAAAAAAAAAB////wAAAAAAAAAA4/+//AAAAAAAAAAPvAA/8AAAAAAAAABnsAD/wAAAAAAAAAOc4Af/AAAAAAAAAB7wAB/8AAAAAAAAAN7AAH/wAAAAAAAAAxoAAf/AAAAAAAAAAGAAB/8AAAAAAAAAAAAAH/wAAAAAAAAAAAAAefAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"lullula-arborea":{"w":93,"h":64,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/AAAAAAAAAAAAAD/+AAAAAAAAAAAA///8AAAAAAAAAAAH///wAAAAAAAAAAAH//+AAAAAAAAAAAAP//4AAAAAAAAAAAB///gAAAAAAAAAAAH//8AAAAAAAAAAAA///wAAAAAAAAAAAD///AAAAAAAAAAAAf//8AAAAAAAAAAAD///+AAAAAAAAAAAf////AAAAAAAAAAD/////AAAAAAAAAAf////+AAAAAAAAAB/////8AAAAAAAAAP/////4AAAAAAAAD//////8AAAAAAAAf//////8AAAAAAAD///////4AAAAAAAf///////wAAAAAAB////////gAAAAAAP////////AAAAAAB////////8AAAAAAP////////4AAAAAA/////////4AAAAAH/////////wAAAAA//////////wAAAAD/////////+AAAAAP/////////4AAAAB//////////8AAAAH//////////8AAAAf//////////8AAAB///////////4AAAH///////////wAAAf//////wAH//AAAA//////wAAH/wAAAD/////4AAAH/AAAAH////+AAAAH4AAAAH////AAAAAGAAAAAH///AAAAAAAAAAAAD//gAAAAAAAAAAAADj4AAAAAAAAAAAABweAAAAAAAAAAAAA4HAAAAAAAAAAAAf/9wAAAAAAAAAAAH/h8AAAAAAAAAAAD/wOAAAAAAAAAAAAhwDAAAAAAAAAAAAAQBwAAAAAAAAAAAACg+AAAAAAAAAAAAAX//wAAAAAAAAAAAA/gAAAAAAAAAAAAB+YAAAAAAAAAAAAA8OAAAAAAAAAAAAAADAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"luscinia-megarhynchos-2":{"w":93,"h":89,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAABZAAAAAAAAAAAAAAbYAAAAAAAAAAAAAD+AAAAAAAAAAAAAA/0AAAAAAAAAAAAAH9gAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/AAAAAAAAAAAAAD/4AAAAAAAAAAAAAf+AAAAAAAAAAAAAH/8AAAAAAAAAAAAA//gAAAAAAAAAAAAP/8AAAAAAAAAAAAB//AAAAAAAAAAAAAf/4AAAAAAAAAAAAD/+AAAAAAAAAAAAA//4AAAAAAAAAAAAH//AAAAAAAAAAAAA//4AAAAAAAAAAAAP/+AAAAAAAAAAAAB//wAAAAAAAAAAAAf/8AAAAAAAAAAAAD//wAAAAAAAAAAAA//+AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAAP//4AAAAAAAAAAAD///AAAB//AAAAAAf//8AD///4AAAAAD///w////wAAAAAAf////////4AAAAAD/////////AAAAAAf///////+AAAAAAD////////gAAAAAAf///////+AAAAB/5///////+AAAAA//////////AAAAAP/////////wAAAAH/////////wAAAAP/////////8AAAAD/////////+AAAAAB/////////AAAAAAD////////gAAAAAAP///////wAAAAAAA///////8AAAAAAAD///////gAAAAAAAf//////8AAAAAAAB///////gAAAAAAAH//////8AAAAAAAA///////gAAAAAAAD//////8AAAAAAAAf//////gAAAAAAAP//////8AAAAAAAH///////AAAAAAAB///////wAAAAAAAf//////+AAAAAAAH///////wAAAAAAA////////gAAAAAAP///////8AAAAAAB////////wAAAAAAf////////AAAAAAH////////8AAAAAA/////////gAAAAAP////////+AAAAAD/////////4AAAAAf/////////AAAAAH/////v///+AAAAB/////z/AP/4AAAAf////weMAf/gAAAD//8gABoAA/+AAAA///AAAOgAB/8AAAP//gAAA6AAH/wAAB//8AAABgAAf/AAAf//AAAAAAAB/8AAH//AAAAAAAAH/wAA//wAAAAAAAAf/gAP/0AAAAAAAAA/+AB/dAAAAAAAAAD/4AdzAAAAAAAAAAP/AHcwAAAAAAAAAA/wAzmAAAAAAAAAADwAI4AAAAAAAAAAAEAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"luscinia-megarhynchos":{"w":93,"h":75,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAB4AAAAAAAAAAAAAA/AAAAAAAAAAAAAAP/4AAAAAAAAAAAAD//AAAAAAAAAAAAA//8AAAAAAAAAAAAP//AAAAAAAAAAAAH//4AAAAAAAAAAAB//+AAA/4AAAAAAAf//gAA//wAAAAAAH//4AAP//gAAAAAB//+AAH//+AAAAAAf//AAP///4AAAAAH//wAH////gAAAAB//4AAf///+AAAAA//+AAAf///4AAAAf//AAAA///////4f//wAAAH//////////4AAAAf/////////+AAAAD//////////wAAAAP/////////8AAAAB//////////AAAAAP/////////4AAAAB/////////+AAAAAH/////////wAAAAA/////////8AAAAAH/////////gAAAAAf////////4AAAAAD/////////AAAAAAf////////8AAAAAD/////////8AAAAAP/////////4AAAAB//////////wAAAAP//////////gAAAA//////////8AAAAH/////////8AAAAAf////////AAAAAAB///////+AAAAAAAH///////gAAAAAAA///////4AAAAAAAD//////8AAAAAAAAH//////gAAAAAAAAf/////4AAAAAAAAB/////8AAAAAAAAAD/////AAAAAAAAAAD////8AAAAAAAAAAD////gAAAAAAAAAAP/8B4AAAAAAAAAAHx4AOAAAAAAAAAAB8AgDAAAAAAAAAAATgAAwAAAAAAAAAAC8AAcAAAAAAAAAAAHgAGAAAAAAAAAAAA8ABgAAAAAAAAAAAGwA4MAAAAAAAAAAASAP/QAAAAAAAAAABgH8AAAAAAAAAAAAAD4AAAAAAAAAAAAADvAAAAAAAAAAAAAAhYAAAAAAAAAAAAAAaAAAAAAAAAAAAAAGQAAAAAAAAAAAAABmAAAAAAAAAAAAAAYwAAAAAAAAAAAAADDAAAAAAAAAAAAAAgOAAAAAAAAAAAAAMAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"mareca-penelope-2":{"w":80,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAD+AAAAAAAAAAAD/AAAAAAAAAAAH/wAAAAAAAAAAH/4AAAAAAAAAAD/8AAAAAAAAAAD/+AAAAAAAAAAD//AAAAAAAAAAB//wAAAAAAAAAB//4AAAAAAAAAB//8AAAAAAAAAA//+AAAAAAAAAAf//AAAAAAAAAAP//gAAAAAAAAAP//4AAAAAAAAAH//8AAAAAAAAAD//+AAAAAAAAAB///AAAAAAAAAA///AAAAAAAAAAf//gAAAAAAAAAP//wAAAAAAAAAD//4AAAAAAAAAA//8AAAAAAAAAAP//gAAAAAAAAAD//4AAAAAAAAAAf/+AAAAAAAAAAH//gAAAAAAAAAB//8AAAAAAAAAAf//AAAAAAAAAAP//wAAAAAAAAAH//8AAAAAAAAAD//+AAAAADgAAB///gAAAAH/wAP///4AAAAH//gP///+AAAAB////////AAAAA////////4AAAA/////////AAAA/////////wAAA//+H/////8AAAAAAAf/////wAAAAAAB/////+AAAAAAAf//////gAAAAAD//////+AAAAAAP//////gAAAAAB//////8AAAAAAH//////AAAAAAAf/////4AAAAAAB//////AAAAAAAD/////4AAAAAAAf////+AAAAAAAP/////AAAAAAAD/////AAAAAAAB///H+AAAAAAAAf//x/wAAAAAAAH//4AYAAAAAAAB//+AAAAAAAAAAf//AAAAAAAAAAH//gAAAAAAAAAA//4AAAAAAAAAAP/8AAAAAAAAAAB//gAAAAAAAAAAf/4AAAAAAAAAAH/+AAAAAAAAAAA//wAAAAAAAAAAP/8AAAAAAAAAAB//AAAAAAAAAAAf/4AAAAAAAAAAD/+AAAAAAAAAAA//gAAAAAAAAAAH/8AAAAAAAAAAA//AAAAAAAAAAAP/wAAAAAAAAAAB/8AAAAAAAAAAAP/gAAAAAAAAAAD/4AAAAAAAAAAAf+AAAAAAAAAAAD/gAAAAAAAAAAAf4AAAAAAAAAAAH/AAAAAAAAAAAA/gAAAAAAAAAAAH4AAAAAAAAAAAA/AAAAAAAAAAAAHgAAAAAAAAAAAA4AAAAAAAAAAAAPAAAAAAAAAAAABgAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"mareca-penelope":{"w":93,"h":56,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAP/AAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAf//wAAAAAAAAAAAH///AAAAAAAAAAAA///4AAAAAAAAAAAP///gAAAAAAAAAAB///8AAAAAAAAAAAP///wAAAAAAAAAAD///+P//wAAAAAAA////////wAAA4AAP/////////8A/AAH////////////gAD////////////4AA/gf/////////+AAPgD//////////wAAAB///////////8AAAf///////////4AAH///////////AAAB////////////wAAP////////////4AD////////////+AAf////////////wAD////////////8AAf////////////AAD////////////AAAf//////////4AAAD//////////8AAAAf/////////+AAAAB//////////gAAAAP/////////4AAAAA/////////8AAAAAD/////////AAAAAAf////////wAAAAAA////////4AAAAAAD///////wAAAAAAAH//////8AAAAAAAAP//////AAAAAAAAAH/////4AAAAAAAAAB////+AAAAAAAAAAAAD+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAP5AAAAAAAAAAAAAA/AAAAAAAAAAAAAAH4AAAAAAAAAAAAAA/gAAAAAAAAAAAAAH8AAAAAAAAAAAAABngAAAAAAAAAAAAAIcAAAAAAAAAAAAACBgAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"mareca-strepera-2":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAAAAAARAAAAAAAAAAAAAADbAAAAAAAAAAAAAAbYAAAAAAAAAAAAAD/QAAAAAAAAAAAAAf+AAAAAAAwAAAAAD/wAAAAAAcAAAAAA/+gAAAAAfAAAAAAH/8AAAAAPzwAAAAA//AAAAAP/4AAAAAH/+AAAAH/+AAAAAB//wAAAD//8AAAAAP/+AAAD///AAAAAB//wAAA///gAAAAAP/+AAAf//+AAAAAD//wAAf///gAAAAAf/+AAH///4AAAAAD//4AD///+AAAAAAf//AA////gAAAAAD//wAf///4AAAAAA//+AP////AAAAAAH//wD////wAAAAAA//+A////8AAAAAAP//wP////AAAAAAB//8H////wAAAAAAP//x////8AAAAAAB///P///+AAAAAAAP///////wAAAAAAB///////4AAAAAAAP//////+AAAAAAAA///////AAAAAD/AD//////gAAAAA/+AP/////4AAAAAP/4A//////AAAAAD//wD/////4AAAAA//+Af/////AAAAAP//4B/////4AAAAD///gP/////AAAAB///8B/////4AAAB////wP////+AAAAfwP//B/////wAAAAAAD/8f////+AAAAAAAH///////gAAAAAAA///////8AAAAAAAH///////gAAAAAAAf//////4AAAAAAAD///////AAAAAAAAf//////wAAAAAAAD//////8AAAAAAAAf//////gAAAAAAAD//////4AAAAAAAAf//////gAAAAAAAB//////8AAAAAAAAP//////wAAAAAAAA//////8AAAAAAAAD//////wAAAAAAAAP//////AAAAAAAAA//////8AAAAAAAAB//////wAAAAAAAAD//////AAAAAAAAAP/////8AAAAAAAAAf/////wAAAAAAAAB//////AAAAAAAAAH/////+AAAAAAAAAP/////4AAAAAAAAA//////iAAAAAAAAB//////wAAAAAAAAD/////8AAAAAAAAAD/////8AAAAAAAAAD/////wAAAAAAAAAH///7wAAAAAAAAAAH//wAAAAAAAAAAAAH/gAAAAAAAAAAAAAf/wAAAAAAAAAAAAD/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAB//wAAAAAAAAAAAAD/+AAAAAAAAAAAAAP38AAAAAAAAAAAAAePwAAAAAAAAAAAAA4cAAAAAAAAAAAAAAAgAAA"},"mareca-strepera":{"w":93,"h":77,"bits":"AAB/AAAAAAAAAAAAAA/+AAAAAAAAAAAAAf/4AAAAAAAAAAAAH//gAAAAAAAAAAAA//+AAAAAAAAAAAAP//4AAAAAAAAAAAB///AAAAAAAAAAAAf//8AAAAAAAAAAAD///gAAAAAAAAAAAf//8AAAAAAAAAAAH///wAAAAAAAAAAD///+AAAAAAAAAAA////wAAAAAAAAAAf///+AAAAAAAAAAH/A//wAAAAAAAAAD/AH/8AAAAAAAAAA/AA//gAAAAAAAAAGAAP/4AAAAAAAAAAAAD//AAAAAAAAAAAAA//wA//AAAAAAAAAP/8D///4AAAAAAAH//j/////8AAAAAB//5///////AAAAAP//////////4AAAD///////////j+AA/////////////wAP////////////4AB/////////////gAf////////////+AD////////////4AAf/////////////4H//////////////A//////////////wH/////////////4A/////////////8AH////////////8AA////////////+AAH////////////gAA////////////4AAD///////////+AAAf///////////gAAD///////////4AAAP//////////+AAAA///////////AAAAH//////////wAAAAf/////////4AAAAB/////////+AAAAAH/////////gAAAAAP////////gAAAAAA////////wAAAAAAB///////8AAAAAAAB//////+AAAAAAAAA//////gAAAAAAAAB/////gAAAAAAAAAB////gAAAAAAAAAAAf/34AAAAAAAAAAAAP4PAAAAAAAAAAAAB/B4AAAAAAAAAAAAP4HAAAAAAAAAAAAD/g4AAAAAAAAAAAAf4GAAAAAAAAAAAAD8AwAAAAAAAAAAAATAHAAAAAAAAAAAAAYA4AAAAAAAAAAAABAHgAAAAAAAAAAAAAB8AAAAAAAAAAAAAAPAAAAAAAAAAAAAP/4AAAAAAAAAAAAA//AAAAAAAAAAAAAD/4AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/4AAAAAAAAAAAAB/+AAAAAAAAAAAAAIfgAAAAAAAAAAAAAA8AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAA="},"melanitta-nigra-2":{"w":77,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAAAAAAAAAAO4AAAAAAAAAAB/4AAAAAAAAAAP/gAAAAAAAAAA/+AAAAAAAAAAH/+AAAAAAAAAAf/4AAAAAAAAAB//gAAAAAAAAAP//AAAAAAAAAA//4AAAAAAAAAH//wAAAAAAAAAf//gAAAAAAAAB//8AAAAAAAAAH//4AAAAAAAAA///gAAAAAAAAD//+AAAAAAAAAP//4AAAAAAAAA///gAAAAAAAAD//+AAAAAAAAAP//4AAAAAAAAA///AAAAAAAAAB//8AAAAAAAAAD//4AAAAAAAAAH//wAAAAAAAAAP//gAAAAAAAAAP//AAAAAAAAAAf/+AAAAAAAAAB//8AAAAAAAAAD//4AAAAAAAAAP//wAAAAAAAAAf//gAAAHP+AAD///AAAAP//gAP//8AAAAf//5////4AAAA////////wAAAH////////AAAA/////////AAAD////////+AAAAAP//////8AAAAAAA/////wAAAAAAA/////wAAAAAAA/////wAAAAAAA/////4AAAAAAA/////4AAAAAAA/////4AAAAAAA//////AAAAAAAf/////AAAAAAAP////+AAAAAAAH/////AAAAAAAP////+AAAAAAA/////8AAAAAAD/////4AAAAAAP/////wAAAAAAf/////AAAAAAA///g/8AAAAAAB//+A/wAAAAAAD//8ADwAAAAAAH//wAAAAAAAAAH//AAAAAAAAAAP/8AAAAAAAAAAf/4AAAAAAAAAAf/wAAAAAAAAAA//wAAAAAAAAAB//gAAAAAAAAAD//AAAAAAAAAAD//AAAAAAAAAAH/+AAAAAAAAAAP/8AAAAAAAAAAP/8AAAAAAAAAAP/4AAAAAAAAAAf/wAAAAAAAAAA//gAAAAAAAAAA//AAAAAAAAAAB/+AAAAAAAAAAB/8AAAAAAAAAAD/wAAAAAAAAAAD/wAAAAAAAAAAH/gAAAAAAAAAAH/AAAAAAAAAAAP+AAAAAAAAAAAP4AAAAAAAAAAAPwAAAAAAAAAAAegAAAAAAAAAAAeAAAAAAAAAAAA0AAAAAAAAAAAAoAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"melanitta-nigra":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/AAAAAAAAAAAAAD/+AAAAAAAAAAAAA//4AAAAAAAAAAAAP//gAAAAAAAAAAAD//+AAAAAAAAAAAD///wAAAAAAAAAAA////AAAAAAAAAAAH///4AAAAAAAAAAB////AAAAAAAAAAAf///8AAAAAAAAAAf////gAAAAAAAAAH////8AAAAAAAAAB/g///gAAAAAAAAAAAB//8AAAAAAAAAAAAB//AAAAAAAAAAAAAP/4B//AAAAAAAAAB//D///gAAAAAAAAP/z////8AAAAAAAD///////8AAAAAAA////////4AAAAAAP/////////wAAAAD//////////4AAAA///////////wAAAP/////////8AAAAB///////////4AAAf//////////+AAAD///////////wAAAf///////////8AAD////////////wAAf////////////AAH////////////4AAf///////////+AAD////////////gAAf///////////4AAD//////////+AAAAP//////////AAAAB//////////gAAAAH/////////4AAAAAf////////8AAAAAB////////+AAAAAAH////////AAAAAAAP///////AAAAAAAAP//////gAAAAAAAAH/////4AAAAAAAAAAf//+OAAAAAAAAAAH/gABwAAAAAAAAAAv8AAcAAAAAAAAAAA/gADAAAAAAAAAAAHgAA4AAAAAAAAAAAQAAPAAAAAAAAAAACAAB8AAAAAAAAAAAABv+AAAAAAAAAAAAAf/gAAAAAAAAAAAAA/8AAAAAAAAAAAAAH/gAAAAAAAAAAAAA/8AAAAAAAAAAAAAH/AAAAAAAAAAAAAB/4AAAAAAAAAAAAAf+AAAAAAAAAAAAAEHgAAAAAAAAAAAAAAYAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"mergus-merganser-2":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAEgAAAAAAAAAAAAAAkAAAAAAAAAAAAAAFgAAAAAAAAAAAAAB9gAAAAAAAAAAAAAP4AAAAAIAAAAAAAB/AAAAADAAAAAAAAf6AAAAAxAAAAAAAD/wAAAAMwAAAAAAA/+AAAAHuAAAAAAAH/4AAAB/gAAAAAAB//AAAAf7AAAAAAAP/4AAAP/wAAAAAAD//AAAD/8AAAAAAAf/4AAA//AAAAAAAH//AAAf/+AAAAAAA//4AAH//gAAAAAAP//AAB//4AAAAAAB//4AA///AAAAAAAf//AAP//4AAAAAAD//4AD//+AAAAAAAf/+AB///gAAAAAAH//wAf//8AAAAAAA//+AH///gAAAAAAH//wB///4AAAAAAA//8A///+AAAAAAAP//gP///wAAAAAAD//4D///8AAAAAAAf//A////AAAAAAAD//wf///wAAAAAAAf/+H///8AAAAAAAH//5////AAAAAAAA///P///wAAAAAAAH//////8AAAAAAAA///////AAAAAAAAD//////wAAAAAAAAP/////4AAAAAAAAB/////+AAAAAAAAAH/////AAAAAAAAAA/////4AAAAAAAAAD/////AAAAAD/4AAf////wAAAAA//4AD////+AAAAAf//wAf////wAAAAf///gD////+AAAD////+A/////wAAA/////4H////8AAAAAP///j/////gAAAAAP////////4AAAAAAB////////AAAAAAAB///////wAAAAAAAD//////+AAAAAAAAP//////gAAAAAAAB//////4AAAAAAAAH//////gAAAAAAAA//////8AAAAAAAAD//////gAAAAAAAAP/////8AAAAAAAAB//////4AAAAAAAAD//////gAAAAAAAAP//////AAAAAAAAAP/////8AAAAAAAAAf/////wAAAAAAAAB//////AAAAAAAAAH/////8AAAAAAAAAP/////wAAAAAAAAAf/////gAAAAAAAAB/////+AAAAAAAAAD/////4AAAAAAAAAD/////gAAAAAAAAAH/////AAAAAAAAAAH/////AAAAAAAAAAD////+AAAAAAAAAAAH//f4AAAAAAAAAAAP/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAAf+AAA="},"mergus-merganser":{"w":62,"h":93,"bits":"AAAAAAHwAAAAAAAAP/gAAAAAAAP/+AAAAAAAH//wAAAAAAD//+AAAAAAD///wAAAAAH///+AAAAB/////wAAAD/////+AAABv/////gAAAAAA///8AAAAAAB///AAAAAAAD//4AAAAAAAP/+AAAAAAAD//gAAAAAAAf/4AAAAAAAH/8AAAAAAAD/+AAAAAAAA//AAAAAAAAf/wAAAAAAAP/8AAAAAAAD//AAAAAAAB//wAAAAAAAf/+AAAAAAAH//wAAAAAAD//8AAAAAAA///gAAAAAAP//8AAAAAAH///AAAAAAH///4AAAAAD////AAAAAD////wAAAAD////+AAAAB/////gAAAB/////4AAAA/////+AAAAf/////wAAAP/////8AAAH//////AAAD//////wAAA//////4AAAf/////+AAAP//////gAAH//////4AAB//////8AAA///////AAAP//////gAAH//////4AAB//////8AAA//////+AAAP//////gAAD//////wAAB//////8AAAf/////+AAAP//////gAAD//////wAAB//////8AAAf/////+AAAH//////AAAD//////wAAA//////4AAAP/////8AAAH/////+AAAD//////AAAB//////gAAA//////wAAAf/////8AAAM//////AAACf/////gAAAH/////wAAAD/////4AAAB////+OAAAB////8DgAAB////4A4AAA////gAOAAAP//A4ADgAAH//AGAA4AAA/4ABgAeAAAAAAAYAPwAAAAAAGAA/gAAAAABgAf/gAAAAA8AH//AAAAAHgB//4AAAAB+Af/wAAAAAf+H/wAAAAAP/9B4AAAAAD/+ACAAAAAA//AAAAAAAAH/gAAAAAAAB/8AAAAAAAAPBAAAAAAAADAAAAAAAAAAAAAAAAA=="},"milvus-milvus-2":{"w":55,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAJIAAAAAAAGWAAAAAAABtAAAAAAACbwAAAAAABn8AAAAAAAd+AAAAAAAH/wAAAAAAB/8AAAAAAA/+AAAAAAAf/gAAAAAAP/wAAAAAAH/8AAAAAAD/+AAAAAAA//AAAAAAAf/wAAAAAAP/4AAAAAAH/+AAAAAAD//AAAAAAA//wAAAAAAf/4AAAAAAP/8AAAAAAH//AAAAAAD//gAAAAAB//wAAAAAA//4AAAAAAf/8AAAAAAP/+AAAAAAH//AAAAAAD//gAAAAAB//wAAAAAA//wAAAAAAf/4AAAAAAP/+AAAAAAH//AAAAAAD//gAAAAAB//wAAAAAA//4AAAAAAf/+AAAMAAP//4AADwAH//+AAB/4D///gAAf/////wAAH/////wAAB/////gAAA/////wAAAP////8AAAH////+AAAB/////gAAA/////wAAAP/9//8AAAH/8f//AAAD/8P//wAAA/8D//4AAAf8B//+AAAP8Af//gAAH8AP//4AAD8AD//+AAA8AB///AAA8AAf//wAAeAAH//4AAOAAB//8AAGAAAf//AAAAAAP//gAAAAAD//wAAAAAB//8AAAAAAP/+AAAAAAD//AAAAAAB//wAAAAAAf/4AAAAAAP/8AAAAAAD//AAAAAAB//gAAAAAAf/wAAAAAAH/8AAAAAAD/+AAAAAAA/+AAAAAAAP/AAAAAAAH/gAAAAAAD/wAAAAAAA/4AAAAAAAP0AAAAAAAHoAAAAAAAD2AAAAAAABbAAAAAAAAlgAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"milvus-milvus":{"w":61,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAPgAAAAAAAAf+AAAAAAAA//gAAAAAAA//4AAAAAAA//+AAAAAAAf//gAAAAAAf//wAAAAAAP//4AAAAAAH//kAAAAAAH//wAAAAAAD//8AAAAAAB///AAAAAAA///4AAAAAAf//+AAAAAAP///gAAAAAH///8AAAAAH////gAAAAD////4AAAAD////+AAAAB/////gAAAA/////4AAAAf////+AAAAP/////gAAAH/////4AAAB/////8AAAA//////AAAAf/////gAAAH/////4AAAD/////8AAAB//////AAAAf/////gAAAP/////4AAAD/////+AAAB//////AAAA//////wAAAP/////4AAAD/////8AAAB/////+AAAAf/////gAAAD/////4AAAA/////8AAAAP/////AAAAD/////gAAAA/////wAAAAf////4AAAAP////8AAAAH/////AAAAB/////gAAAA/////wAAAAP////4AAAAH////8AAAAB////+AAAAA/////AAAAAP////gAAAAH////4AAAAH////+AAAAf/////AAAAf///z/wAAAP/f/4/8AAAH/n/8H/AAAB/zf/B/wAAAf7P/gf8AAAH8H/wD/AAAADj/4A/wAAAAB/8AP4AAAAAf+AD+AAAAAP/AA/AAAAAH/wAfwAAAAD/4AHYAAAAB/8ABgAAAAAf+AAQAAAAAP/AAIAAAAAH/wAAAAAAAD/4AAAAAAAB/8AAAAAAAAf+AAAAAAAAP/gAAAAAAAH/wAAAAAAAD/4AAAAAAAA/8AAAAAAAAf/AAAAAAAAP/gAAAAAAAH/wAAAAAAAB/4AAAAAAAAf+AAAAAAAAA/AAAAAAAAAPgAAAAAAAABwAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAA="},"mniotilta-varia-2":{"w":83,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAGEAAAAAAAAAAAAYYAAAAAAAAAAABxwAAAAAAAAAAADnAAAAAAAAAAACOeIAAAAAAAAAAE94wAAAAAAAAAAZz3AAAAAAAAAAB3/eAAAAAAAAAAD/94AAAAAAAAAAP//iAAAAAAAAAAf//cAAAAAAAAAB//9wAAAAAAAAAD///AAAAAAAAAAP//+AAAAAAAAAA///4AAAAAAAAAB///8AAAAAAAAAH///4AAAAAAAAAP///gAAAAAAAAA///+AAAAAAAAAD///4AAAAAAAAAH///4AAAAAAAAAf///wAAAAAAAAB////AAAAAAAAAH///8AAAAAAAAAP///4AAAAAAAAA////wAAAAAAAAD////gAAAAAAAAP///+AAAAAAAAAf///4AAAAAAAAB////wAAAAAAAAH////AAAAAAAAAP///8AAAAAAf8A////wAAAAAD//B////wAAAAAP//n////gAAAAA////////AAAAAD///////+AAAAAf///////8AAAAH////////4AAAAP////////wAAAAA////////gAAAAA////////AAAAAA///////+AAAAAA///////8AAAAAA///////4AAAAAA///////wAAAAAB///////gAAAAAB//////+AAAAAAB//////8AAAAAAD//////4AAAAAAD//////wAAAAAAP/////fAAAAAAA//////AAAAAAAD//////AAAAAAAP/////+AAAAAAAf/////+AAAAAAB//////+AAAAAAH//////+AAAAAAf//////8AAAAAA///////8AAAAAD///////8AAAAAH///////4AAAAAf///////4AAAAB////////8AAAAD////////8AAAAP////////8AAAA//////8P/8AAAB//////AP/+AAAH/////8AP/+AAAf/////4AP/+AAB//////gAP//AAH////+eAAf//AAP////gIAAf//gA/3//8AAAAf//gD/v//wAAAAf//gP/f/+AAAAA//+A/+//8AAAAA//wD////wAAAAA/4AH/3/+AAAAAA/gAd/v/8AAAAAB/ABz/f/wAAAAAB8AHPf/+AAAAAABwAY9/3cAAAAAABAABz3uwAAAAAAAAAHPOdAAAAAAAAAAce8wAAAAAAAAAAx5zAAAAAAAAAADDjGAAAAAAAAAAAGGAAAAAAAAAAAAYYAAAAAAAAAAAAAAAAAAAAAAAAA="},"mniotilta-varia":{"w":93,"h":55,"bits":"AAAAAAAAAAAAAAAAAB/8AAAAAAAAAAAAA//4AAAAAAAAAAAAP//gAAAAAAAAAAAH///AAAAAAAAAMAB///8AAAAAAAAfgP////wAAAAAAAfwD/////AAAAAAAP/8H/////wAAAAAP//wD/////4AAAAP//+AP/////wAAAH///AA//////gAAH//+AAH//////4AD///AAAf//////8P///AAAD///////////AAAAf//////////AAAAB//////////AAAAAP/////////AAAAAB/////////gAAAAAP////////8AAAAAA////////+AAAAAAH////////4AAAAAA/////////wAAAAAD/////////gAAAAAf///////wMAAAAAB////////gAAAAAAP///////+AAAAAAA////////+AAAAAAH////////8AAAAAAf////////wAAAAAB//////8AOAAAAAAH//////AAAAAAAAAf/////wAAAAAAAAB/////8AAAAAAAAAH/////AAAAAAAAAAH////gAAAAAAAAAAP///wAAAAAAAAAAAf//4AAAAAAAAAAAA///AAAAAAAAAAAAPfj4AAAAAAAAAAABwZ8AAAAAAAAAAAAYB8AAAAAAAAAAAADAeAAAAAAAAAAAAAYOgAAAAAAAAAAAACHAAAAAAAAAAAAAAP8AAAAAAAAAAAAAD4+AAAAAAAAAAAAAfAwAAAAAAAAAAAADwHAAAAAAAAAAAAAcAIAAAAAAAAAAAADgCAAAAAAAAAAAAAcAAAAAAAAAAAAAADAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"morus-bassanus-2":{"w":84,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAADAAAAAAAAAAAAAGYAAAAAAAAAAAAM4AAAAAAAAAAAAfwAAAAAAAAAAAB/sAAAAAAAAAAAD/4AAAAAAAAAAAH/wAAAAAAAAAAAP/gAAAAAAAAAAAf/gAAAAAAAAAAA//gAAAAAAAAAAB//gAAAAAAAAAAD//AAAAAAAAAAAH/+AAAAAAAAAAAP/+AEAAAAAAAAAf/+AGgAAAAAAAA//+ACwAAAAAAAB//8AD0AAAAAAAD//4AD+AAAAAAAH//wAD/AAAAAAAf//wAB/wAAAAAA///gAB/4AAAAAA///gAB/8AAAAAB///AAA/+AAAAAD//+AAA//AAAAAH//+AAA//gAAAAP//8AAAf/wAAAAf//4AAAf/4AAAA///wAAAP/8AAAA///gAAAP/+AAAB///AAAAH//AAAB//+AAAAD//gAAB//8AAAAD//gAAB//8AAAAD//wAAB//8AAAAD//4AAD//8AAAAB//+AAD//8AAAAA///gAD//8AAAAAf8P4AD//8AAAAAPwD8AD//8AAAAAHwA+AD//4AAAAADgAfAH//4AAAAABgAHgH//4AAAAAAIADwH//4AAAAAAAAB8H//wAAAAAABAAeP//wAAAAAAAgAfP//wAAAAAAAAAPf//wAAAAAAAAAH///gAAAAAAAEAH///gAAAAAAAAAP///AAAAAAAAAAf///AAAAAAAAAA///+AAAAAAAAAD///8AAAAAAAAAH///4AAAAAAAAB////4AAAAAAA/h////4AAAAAAD/9////8AAAAAAP//////8AAAAAAf//////8AAAAAA///////8AAAAAB///////8AAAAAB///////8AAAAAH///////8AAAAAP///////4AAAAAf///////8AAAAB/gD/////+AAAAD8AB//////AAAAHwAA//////wAAAOAAAP/////4AAAIAAAD/////8AAAAAAAAD////8AAAAAAAAAf///+AAAAAAAAAH////AAAAAAAAAA////AAAAAAAAAAH///gAAAAAAAAAAD//4AAAAAAAAAAAf/+AAAAAAAAAAAf//gAAAAAAAAAAH//4AAAAAAAAAAD3/EAAAAAAAAAABz/gAAAAAAAAAAAZ34AAAAAAAAAAAIz8AAAAAAAAAAAAQ+AAAAAAAAAAAAAbAAAAAAAAAAAAAMwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"morus-bassanus":{"w":93,"h":71,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAAAAAAAf/AAAAAAAAAAAAAP/8AAAAAAAAAAAAH//wAAAAAAAAAAAB///AAAAAAAAAAAAf//8AAAAAAAAAAAf///gAAAAAAAAAAP///+AAAAAAAAAAH////wAAAAAAAAAH////+AAAAAAAAAD/////wAAAAAAAAA/wAP/+AAAAAAAAAPAAB//wAAAAAAAAAAAAf/8AAAAAAAAAAAAF//gAAAAAAAAAAABD/8AAAAAAAAAAAAQf/4AAAAAAAAAAACD//wAAAAAAAAAAAAf//wAAAAAAAAAAED///4AAAAAAAAAAgf///4AAAAAAAAAEB////wAAAAAAAAAgP////gAAAAAAAAAB/////AAAAAAAAAAP////8AAAAAAAACB/////4AAAAAAAAAP/////gAAAAAAABA/////+AAAAAAAAAH/////8AAAAAAAAgf/////wAAAAAAACB//////gAAAAAAAIH/////+AAAAAAAAgf/////4AAAAAAACB//////gAAAAAAAID/////+AAAAAAAAgH/////4AAAAAAACAP/////gAAAAAAAIA/////8AAAAAAAAAB/////wAAAAAAAAAA////+AAAAAAAAIAA////4AAAAAAAAgAD////wAAAAAAAAAAH////AAAAAAAAEAAH///+AAAAAAAAAAAB///4AAAAAAAAAAAB///gAAAAAAAHAACH///AAAAAAAB/AAYf/88AAAAAAAf7AD///4wAAAAAAD/e4////jAAAAAAA//////4/AAAAAAAA///AP/g8AAAAAAAHP/wAH+AgAAAAAAAR/4AAf8AAAAAAAAAH/AAB/wAAAAAAAAA/wAAP/gAAAAAAAAE8AAA/+AAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAAf5gAAAAAAAAAAAAB/gAAAAAAAAAAAAAB+AAAAAAAAAAAAAAD4AAAAAAAAAAAAAADgAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"motacilla-alba-2":{"w":93,"h":84,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEQAAAAAAAAAAAAAAmAAAAAAAAAAAAAAMwAAAAAAAAAAAAABuAAAAAAAAAAAAAAdmAAAAAAAAAAAAAL9gAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/gAAAAAAAAAAAAD/9AAAAAAAAAAAAAf/4AAAAAHgAAAAAH//AAAAAH4AAAAAA//4AAAAD+AAAAAAH/+AAAAD/OAAAAAB//0AAAB/3gAAAAAP//gAAA//4AAAAAB//8AAAf/+AAAAAAP//gAAP//AAAAAAB//4AAD//yAAAAAAP//gAB///wAAAAAD//8AA///8AAAAAAf//gAP///AAAAAAD//8AH///gAAAAAAf//AB///8AAAAAAD//4A////gAAAAAAf//wP///4AAAAAAD//+H///+AAAAAAAf//5////AAAAAAAD///////4AAAAAAAf//////+AAAAAAAD///////gAAAAAAAf//////4AAAAAAAP//////+AAAAAAAH///////gAAAAAAD///////4AAAAAAA///////+AAAAAAD////////AAAAAAA////////wAAAAAAAH//////+AAAAAAAAf//////wAAAAAAAB//////+AAAAAAAAH//////wAAAAAAAAf/////+AAAAAAAAB//////wAAAAAAAAH/////+AAAAAAAAA//////wAAAAAAAAD/////+AAAAAAAAAf/////4AAAAAAAAD/////+AAAAAAAAAP/////wAAAAAAAAB/////+AAAAAAAAAH/////wAAAAAAAAAf/////AAAAAAAAAD/////4AAAAAAAAAP////+AAAAAAAAAA/////4AAAAAAAAAB/////wAAAAAAAAAH/////AAAAAAAAAAP////8AAAAAAAAAAf////wAAAAAAAAAA/////gAAAAAAAAAA////+AAAAAAAAAAB////4AAAAAAAAAD//8//wAAAAAAAAAf/AAf/gAAAAAAAADfAAAP+AAAAAAAAAJ+AAA/8AAAAAAAABuYAAD/4AAAAAAAAHwAAAH/gAAAAAAAAPgAAAf/AAAAAAAAAOAAAA/+AAAAAAAAAAAAAD/4AAAAAAAAAAAAAH/wAAAAAAAAAAAAAf/gAAAAAAAAAAAAA/+AAAAAAAAAAAAABx8AAAAAAAAAAAAAHD4AAAAAAAAAAAAAOHgAAAAAAAAAAAAAQPAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"motacilla-alba":{"w":93,"h":58,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAAAAAAD/gAAAAAAAAAAAAB//AAAAAAAAAAAAAf/4AAAAAAAAAAAAH//gAAAAAAAAAAAA///4AAAAAAAAAAAP///AAAAAAAAAAAB//4AAAAAAAAAAAAf//AAAAAAAAAAAAP//wAAAAAAAAAAAH//+AAAAAAAAAAAH///gAAAAAAAAAAD///+AAAAAAAAAAA////wAAAAAAAAAAf///+AAAAAAAAAAP////wAAAAAAAAAD////+AAAAAAAAAB/////wAAAAAAAAB/////+AAAAAAAAA//////wAAAAAAAAf/////+AAAAAAAAP//////gAAAAAAAH//////8AAAAAAAD///////AAAAAAAD///////4AAAAAAA/////3/+AAAAAAD/////gP/gAAAAAP////4AA/4AAAAA////wAAAD+AAAAB//4B+AAAAPgAAAD//gAAAAAAAwAAAD/+AAAAEAAAAAAAH/4AAAAAYAAAAAAA/wAAAAAAwAAAAAAAAAAAAAAAAiAAAAAAAAAAAAACEAAAAAAAAAAAAAAgAAAAAAAAAAAAAAEGAAAAAAAAAAAAAA4wAAAAAAAAAAAAACCAAAAAAAAAAAAAAYIAAAAAAAAAAAAABggAAAAAAAAAAAAAEGAAAAAAAAAAAAAAwYAAAAAAAAAAAAACBgAAAAAAAAAAAAAIEAAAAAAAAAAAAABv/AAAAAAAAAAAAAED8AAAAAAAAAAAAeyGQAAAAAAAAAAAAv8YAAAAAAAAAAAAANwgAAAAAAAAAAAAAQAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"motacilla-cinerea-2":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAB8AAAAAAAAAAAAAAH4AAAAAAAAAAAAAOfwAAAAAAAAAAAAA9/gAAAAAAAAAAAAD/+AAAAAAAAAAAAAP/8AAAAAAAAAAAAAf/4AAAAAAAAAAAAN//gAAAAAAAAAAAA///AAAAAAAAAAAAD//8AAAAAAAAAAAAP//4AAAAAAAAAAAAf//gAAAAAAAAAAAD///AAAAAAAAAAAAf//8AAAAAAAAAAAB///wAAAAAAAAAAAH///gAAAAAAAAAAAf//+AAAAAAAAAAAD///4AAAAAAAAAAAH///wAAAAAAAAAAAf///AAAAAAAAAAAD///8AAAAAAAAAAAP///wAAAAAAAAAAA////AAAAAAAAAAAD///4AAAAAAAAAAAP///gAAAAAAAAAAA///8AAAAAAAAAAAH///gA/gAAAAAAAA///+Af/AAAAAAAAH///wP/+AAAAAAAA////D//wAAAAAAAH///////AAAAAAAA///////+AAAAAAAH///////+AAAAAAA///////4AAAAAAAH//////8AAAAAAAA///////AAAAAAAAH//////wAAAAAAAA//////8AAAAAAAAH//////AAAAAAAAAf/////4AAAAAAAAD//////4AAAAAAAAP//////wAAAAAAABh//////AAAAAAAAAf/////8AAAAAAAAH//////wAAAAAAAA///////AAAAAAAAP//////8AAAAAAAD///////wAAAAAAAf//////+AAAAAAAH///////4AAAAAAB////////gAAAAAAf///////8AAAAAAH////////wAAAAAD/////////AAAAAA/////////8AAAAAP/////////wAAAAD/+G//////+AAAAA/+AP/Btf//4AAAAf/AH8YAA///gAAAH/wAAeAAD//8AAAB/8AAHgAAP//wAAAf/AAAAAAA///AAAH/wAAAAAAD//4AAB/8AAAAAAAH//gAAf/AAAAAAAAf/8AAP/wAAAAAAADf/wAD/8AAAAAAAAD/+AA//AAAAAAAAAN+4AP/wAAAAAAAAAm7AD/8AAAAAAAAAAbkA//AAAAAAAAAABMAP/wAAAAAAAAAAAgD/8AAAAAAAAAAAAA//AAAAAAAAAAAAAPHwAAAAAAAAAAAAAA8AAAAAAAAAAAAAAHAAAAAAAAAAAAAABwAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"motacilla-cinerea":{"w":93,"h":75,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAA7AAAAAAAAAAAAAAf4AAAAAAAAAAAAAH+AAAAAAAAAAAAAD/gAAAAAAAAAAAAA/4AAAAAAAAAAAAAP+AAAAAAAAAAAAAH/AAAAAAAAAAAAAB/wAAAAAAAAAAAAAf8AAAAAAAAAAAAAH+AAAAHwAAAAAAAB/gAAAH/wAAAAAAA/4AAAB//gAAAAAAP+AAAA//+AAAAAAD/AAAH///4AAAAAA/wAAAf///gAAAAAP8AAAAP//+AAAAAD/AAAAA///4AAAAA/gAAAAD///gAAAAf4AAAAAP///8AAAH+AAAAAB////+AAD/gAAAAAH/////8B/8AAAAAA/////////AAAAAAH////////wAAAAAAf///////8AAAAAAD////////gAAAAAAf///////4AAAAAAD///////+AAAAAAA////////gAAAAAAH///////4AAAAAAAf///////gAAAAAAD////////AAAAAAAf////////gAAAAAD/////////gAAAAAf////////8AAAAAB////////AAAAAAAP///////AAAAAAAA///////gAAAAAAAD//////4AAAAAAAAf/////+AAAAAAAAB//////wAAAAAAAAD/////8AAAAAAAAAP/////AAAAAAAAAA/////wAAAAAAAAAD////8AAAAAAAAAAH////AAAAAAAAAAAP///wAAAAAAAAAAAf//+AAAAAAAAAAAAB/BgAAAAAAAAAAAAMAIAAAAAAAAAAAADADAAAAAAAAAAAAAgAwAAAAAAAAAAAAc8MAAAAAAAAAAAAP+BAAAAAAAAAAAAfwAQAAAAAAAAAAAEUAGAAAAAAAAAAAANgBgAAAAAAAAAAAHIAZwAAAAAAAAAABjAH8AAAAAAAAAAAIQB4AAAAAAAAAAAAAD8AAAAAAAAAAAAAAigAAAAAAAAAAAAABsAAAAAAAAAAAAAAZAAAAAAAAAAAAAAMYAAAAAAAAAAAAADDAAAAAAAAAAAAAAgQAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"motacilla-flava-2":{"w":93,"h":67,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAHAAAAAAAAAAAAAADhgAAAAAAAAAAAAB54AAAAAAAAAAAAB/+AAAAAAAAAAAAA//CAAAAAAAAAAAAf/zwAAAAAAAAAAAP//8AAAAAAAAAAAH//+AAAAAAAAAAAD///AAAAAAAAAAAA////AAAAAAAAAAAf///wAAAAAAAAAAP///4AAAAAAAAAAH///+AAAAAAAAAAB////wAAAAAAAAAA////8AAAAAAAAAAP///+AAAAAAAAAAD////gAAAAAAAAAB////4AAAAAAABwAP///8AAAAAAAB/wD///+AAAAAAAA//g////gAAAAAAAP/+P///wAAAAAAAD//////8AAAAAAAH///////AAAAAAAAP//////4AAAAAAAAH//////AAAAAAAAAf/////4AAAAAAAAB//////AAAAAAAAAH/////4AAAAAAAAAf/////AAAAAAAAAP/////4AAAAAAAAH/////+AAAAAAAAD//////wAAAAAAAA//////+AAAAAAAAP//////gAAAAAAAD//////8AAAAAAAA///////AAAAAAAAP//////4AAAAAAAB///////gAAAAAAAf//////+AAAAAAAH///////4AAAAAAB////////gAAAAAAf///////+AAAAAAH////8///4AAAAAB/////hTH/gAAAAAf////wGYD/AAAAAH///8gAmAP8AAAAB///wAAIgA/wAAAAf//8AADIAB/gAAAD///AAASAAH+AAAA///wAAEgAAf8AAAP//8AABMAAB/wAAD//+AAAf8AAH/AAA///wAADOAAAP+AAP//sAAAIgAAA/4AD/3cAAABmAAAD/wA7+7AAAACYAAAPPAM7mQAAAASAAAA8eAOZgAAAAAAAAADw4BmIAAAAAAAAAAGAAYgAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"motacilla-flava":{"w":93,"h":61,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAA/+AAAAAAAAAAAAAP/4AAAAAAAAAAAAH//wAAAAAAAAAAAB///AAAAAAAAAAAAf///wAAAAAAAAAAD////gAAAAAAAAAA///4AAAAAAAAAAA///+AAAAAAAAAAAf///gAAAAAAAAAAf///4AAAAAAAAAAH////AAAAAAAAAAD////wAAAAAAAAAB////+AAAAAAAAAAf////wAAAAAAAAAH////+AAAAAAAAAD/////wAAAAAAAAA/////+AAAAAAAAAP/////gAAAAAAAAH/////8AAAAAAAAB//////gAAAAAAAA//////8AAAAAAAAP//////AAAAAAAAH//////4AAAAAAAB//////+AAAAAAAAf//////gAAAAAAAH//////8AAAAAAAD///////AAAAAAAA///////wAAAAAAAf//////8AAAAAAAH//////+AAAAAAABv//////gAAAAAAAR//////wAAAAAAAAf/////8AAAAAAAAP/////+AAAAAAAAB/////+AAAAAAAAAf/wf/+AAAAAAAAAP/AAD+AAAAAAAAAD4AAAfgAAAAAAAAB+AAAD4AAAAAAAAA/AAAAfAAAAAAAAAPgAAABsAAAAAAAAH4AAAAGwAAAAAAAD8AAAAAZAAAAAAAA+AAAAABkAAAAAAAfgAAAAAGQAAAAAAHwAAAAAAZAAAAAAD4AAAAAABkAAAAAA+AAAAAAAEQGAAAAPAAAAAAAAT/gAAAHwAAAAAAAf/+AAAAYAAAAAAAcv4AAAAAAAAAAAAA//8AAAAAAAAAAAAABwAAAAAAAAAAAAAABwAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"muscicapa-striata-2":{"w":86,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAABwAAYgAAAAAAAAA4wADMAAAAAAAAA88AAzAAAAAAAAA/eAAO7AAAAAAAA//IADuwAAAAAAA//sAAfuAAAAAAAf//AAH/gAAAAAAf//gAB/7AAAAAAf//wAAf/4AAAAAP//wAAD/+AAAAAP///AAA//oAAAAH///gAAP/+AAAAD///4AAD//wAAAD///4AAAf/8AAAB///8AAAH//wAAA////AAAB//8AAAf///wAAAf//AAAf///4AAAD//wAAP///8AAAA//+AAH///+AAAAP//gAD////gAAAB//4AD////wAAAAf//AB////4AAAAH//wA////8AAAAB///Af///+AAAAAf//8P////gAAAAH///z////gAAAAA////////wAAAAAP///////4AAAAAD///////8AAAAAAf//////+AAAAAAD///////gAAAAAAf//////4AAAAAAB//////8AAAAAAB///////gAAAAAB///////4AAAAAB///////+AAAAAA////////gAAAAAP///////4AAAAAf///////8AAAAAf////////gAAAAD////////4AAAAAD///////8AAAAAAf///////AAAAAAD///////wAAAAAAf//////8AAAAAAD//////+AAAAAAAf//////gAAAAAAD//////gAAAAAAAf/////gAAAAAAAD/////4AAAAAAAAf/////AAAAAAAAD/////4AAAAAAAAf/////AAAAAAAAD/////4AAAAAAAAP/////AAAAAAAAB/////wAAAAAAAAH////+AAAAAAAAAf////wAAAAAAAAB////+AAAAAAAAAD////gAAAAAAAAA////+AAAAAAAAAJ8f//wAAAAAAAACawD/+AAAAAAAAA8GAP/wAAAAAAAAHwAD//AAAAAAAAAeAAf/4AAAAAAAAAwAD//AAAAAAAAAAAAf/8AAAAAAAAAAAD//gAAAAAAAAAAAf/+AAAAAAAAAAAD//wAAAAAAAAAAAf3+AAAAAAAAAAAD8P4AAAAAAAAAAAfA/AAAAAAAAAAADwEAAAAAAAAAAAAcAgAAAAAAAAAAAHgEAAAAAAAAAAAAYAgAAAAAAAAAAAGAGAAAAAAAAAAAAwAQAAAAAAAAAAAGACAAAAAAAAAAAAgAQAAAAAAAAAAAEACAAAAAAAAAAAAgAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"muscicapa-striata":{"w":87,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAAAAAAAAAAP/wAAAAAAAAAAAH//gAAAAAAAAAAD//+AAAAAAAAAAA///4AAAAAAAAAAP///4AAAAAAAAAD/////AAAAAAAAA/////4AAAAAAAAP////4AAAAAAAAD////4AAAAAAAAAf///+AAAAAAAAAH////gAAAAAAAAA////4AAAAAAAAAP////AAAAAAAAAD////wAAAAAAAAAf///+AAAAAAAAAH////gAAAAAAAAD////8AAAAAAAAA/////AAAAAAAAAP////4AAAAAAAAD/////AAAAAAAAA/////4AAAAAAAAf/////AAAAAAAAH/////4AAAAAAAA//////AAAAAAAAP/////4AAAAAAAD//////AAAAAAAA//////4AAAAAAAP//////AAAAAAAD//////4AAAAAAAf//////AAAAAAAH//////4AAAAAAB///////AAAAAAAf//////wAAAAAAH//////+AAAAAAB///////wAAAAAAP//////8AAAAAAD///////gAAAAAA///////4AAAAAAH///////AAAAAAB///////wAAAAAAP//////8AAAAAAD///////gAAAAAAf//////4AAAAAAH//////+AAAAAAA///////gAAAAAAP//////4AAAAAAB//////+AAAAAAAP//////gAAAAAAB//////4AAAAAAAP/////+AAAAAAAD//////gAAAAAAA//////wAAAAAAAH/////8AAAAAAAB///////gAAAAAAf////+B/gAAAAAH////+AB8AAAAAA////+AAXwAAAAAP///uAAE+AAAAABz//A4ADHwAAAAAc//gBwAY4AAAAAHP/4ADgC+AAAAABx/+AAfASQAAAAAMf/AAD8BGAAAAABD/4AA2wAgAAAAAA/+AAN0AMAAAAAAP/wADPgAAAAAAAB/8AAZwAAAAAAAAf/gAC8AAAAAAAAH/4AAQgAAAAAAAA/+AAAMAAAAAAAAP/wAABAAAAAAAAD/8AAAYAAAAAAAAf/gAAAAAAAAAAAH/4AAAAAAAAAAAA/+AAAAAAAAAAAAP/wAAAAAAAAAAAD/8AAAAAAAAAAAAf/gAAAAAAAAAAAH/4AAAAAAAAAAAB/+AAAAAAAAAAAAP/wAAAAAAAAAAAD/8AAAAAAAAAAAAf/gAAAAAAAAAAAH/4AAAAAAAAAAAA/+AAAAAAAAAAAAH/gAAAAAAAAAAAB+4AAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"numenius-arquata-2":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAHMAAAAAAAAAAAAAD/AAAAAAAAAAAAAB/4AAAAAAAAAAAAA//AAAAAAAAAAAAAf/gAAAAAAAAAAAAP/8AAAAAAAAAAAAH//gAAAAAAAAAAAD//4AAAAAAAAAAAA//+AAAAAAAAAAAAf//wAAAAAAAAAAAH//8AAAAAAAAAAAD///AAAAAAAAAAAA///4AAAAAAAAAAAP///AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAP///AAAAAAAAAAAD///wAAAAAAAAAAAf//8AAAAAAAAAAAH//+AAAAAAAAAAAA///gAAAAAAAAAAAP//wAAAAAAAAAAAB//+AAAAAAAAAAAAf//wAAAAAAAAAAAD//8AAAAAAAAAAAA///gAAAAAAAAAAAH//8AAAAAAAAB+AB///gAAAAAAAAf4Af//8AAAAAAAAH/gD///gAAAAAAAH//D///8AAAAAAAP///////AAAAAAAHgP/////4AAAAAADgAf/////AAAAAABgAB/////4AAAAAAYAAH////+AAAAAAEAAH/////gAAAAAAAB//////8AAAAAAAA///////gAAAAAAAP//////8AAAAAAAH///////wAAAAAAA///////+AAAAAAAf///////gAAAAAAH////////+AAAAAB//////////AAAAAf/////////wAAAAH//////////AAAAB//////////wAAAA//////P///+AAAAP////4Af///wAAAD///wAAB///8AAAA///4AAAH///gAAAP///AAAAH7/4AAAD///wAAAADv/AAAAf//8AAAAAN/gAAAH///AAAAAA2gAAAB///gAAAAACGAAAAf//gAAAAAAYYAAAH//4AAAAAABh4AAAfvwAAAAAAAEHAAACbgAAAAAAAA8eAAAAAAAAAAAAADw4AAAAAAAAAAAAAPBwAAAAAAAAAAAAAcCAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"numenius-arquata":{"w":81,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAA/wAAAAAAAAAAAP/AAAAAAAAAAAB/8AAAAAAAAAAAf/gAAAAAAAAAAP/+AAAAAAAAAAP//wAAAAAAAAAP//+AAAAAAAAAHwH/wAAAAAAAADwAf+AAAAAAAABwAD/wAAAAAAAA4AAf8AAAAAAAAMAAD/gAAAAAAADAAA/8AAAAAAABgAAH/AAAAAAAAYAAB/8AAAAAAACAAAP/gAAAAAAAgAAD/+AAAAAAAIAAAf/+AAAAAAAAAAD//8AAAAAAAAAAf//4AAAAAAAAAD///4AAAAAAAAAf///wAAAAAAAAD////gAAAAAAAAf////AAAAAAAAD////8AAAAAAAAP////wAAAAAAAB/////gAAAAAAAP////+AAAAAAAB/////4AAAAAAAP/////gAAAAAAA/////8AAAAAAAH/////wAAAAAAA//////AAAAAAAH/////8AAAAAAAf/////wAAAAAAD//////AAAAAAAP/////8AAAAAAA//////wAAAAAAD//////AAAAAAAP/////8AAAAAAA//////gAAAAAAD/////+AAAAAAAH/////wAAAAAAAf/////AAAAAAAB/////+AAAAAAAH/////8AAAAAAA//////4AAAAAAD//////AAAAAAAf//D//4AAAAAAB/4AD/wAAAAAAAH/AAD/AAAAAAAAfwAAH8AAAAAAAD+AAAfgAAAAAAAbgAAA8AAAAAAABMAAAAAAAAAAAANgAAAAAAAAAAABkAAAAAAAAAAAAMgAAAAAAAAAAABmAAAAAAAAAAAAIwAAAAAAAAAAABGAAAAAAAAAAAAYwAAAAAAAAAAADGAAAAAAAAAAAAQwAAAAAAAAAAACGAAAAAAAAAAAAQwAAAAAAAAAAAGEAAAAAAAAAAAAwgAAAAAAAAAAAEEAAAAAAAAAAAAggAAAAAAAAAAAEEAAAAAAAAAAABggAAAAAAAAAAAMEAAAAAAAAAAABggAAAAAAAAAAw/EAAAAAAAAAAB/BgAAAAAAAAAADYMAAAAAAAAAABiB4AAAAAAAAABxgMAAAAAAAAAAY//gAAAAAAAAAAAA8AAAAAAAAAAAAZAAAAAAAAAAAAGIAAAAAAAAAAAHDAAAAAAAAAAADgQAAAAAAAAAAAAEAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"numenius-phaeopus-2":{"w":81,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAf4AAAAAAAAAAAf/AAAAAAAAAAA//wAAAAAAAAAAf/8AAAAAAAAAAf//AAAAAAAAAAP//4AAAAAAAAAP//+AAAAAAAAAH///gAAAAAAAAD///4AAAAAAAAA///+AAAAAAAAAf///gAAAAAAAAH///4AAAAAAAAD///+AAAAAAAAA////gAAAAAAAAP///wAAAAAAAAD///+AAAAAAAAA////AAAAAAAAAH///wAAAAAAAAA///wAAAAAAAAAH//8AAAAAAAAAA///gAAAAAAAAAD//8AAAAAAAAAAf//gAAAAAAH4AD//8AAAAAAB/gAf//gAAAAAAf+AD//8AAAAAAH/4A///gAAAAAA//gP//8AAAAAAf//P///gAAAAAP//////4AAAAAHx//////AAAAADwB/////4AAAABwAH/////AAAAA4AA/////4AAAAMAAH/////AAAACAAA/////4AAAAgAAD/////wAAAIAAAf/////wAAAAAAB//////+AAAAAAP//////4AAAAAA///////gAAAAAB//////8AAAAAAD//////gAAAAAAH/////8AAAAAAAP/////gAAAAAAAP////4AAAAAAAB////+AAAAAAAAP////gAAAAAAAD//8H/gAAAAAAAf//gP/AAAAAAAH//8Af/AAAAAAA///gAggAAAAAAP//8AAAAAAAAAB///AAAAAAAAAAP//4AAAAAAAAAB//+AAAAAAAAAAP//wAAAAAAAAAB//8AAAAAAAAAAH//wAAAAAAAAAA//+AAAAAAAAAAD//wAAAAAAAAAAf//AAAAAAAAAAB//4AAAAAAAAAAP//gAAAAAAAAAB//8AAAAAAAAAAH//wAAAAAAAAAA//+AAAAAAAAAAD//4AAAAAAAAAAP/+AAAAAAAAAAA//4AAAAAAAAAAH//AAAAAAAAAAAf/8AAAAAAAAAAB//gAAAAAAAAAAH/8AAAAAAAAAAA//gAAAAAAAAAAD/8AAAAAAAAAAAP/wAAAAAAAAAAA/8AAAAAAAAAAAD/gAAAAAAAAAAAP+AAAAAAAAAAAA/wAAAAAAAAAAAD/AAAAAAAAAAAAPwAAAAAAAAAAAA+AAAAAAAAAAAAD4AAAAAAAAAAAAOAAAAAAAAAAAAAYAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"numenius-phaeopus":{"w":93,"h":85,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAAAAAAB/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAH/8AAAAAAAAAAAAA//wAAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAB//+AAAAAAAAAAAA///wAAAAAAAAAAA/v/+AAAAAAAAAAAfAP/wAAAAAAAAAAPgA/+AAAAAAAAAADgAH/wAAAAAAAAABwAB/+AAAAAAAAAAcAAP/wAAAAAAAAAGAAD//AAAAAAAAABgAAf/8AAAAAAAAAYAAH//+AAAAAAAAGAAA///+AAAAAAAAgAAP///+AAAAAAAIAAB////+AAAAAAAAAAP////8AAAAAAAAAB/////4AAAAAAAAAP/////gAAAAAAAAB//////AAAAAAAAAP/////8AAAAAAAAB//////wAAAAAAAAP//////AAAAAAAAB//////+AAAAAAAAP//////4AAAAAAAA///////gAAAAAAAH//////+AAAAAAAA///////4AAAAAAAD///////gAAAAAAAf//////+AAAAAAAB///////4AAAAAAAP///////gAAAAAAA////////AAAAAAAH///////8AAAAAAAf///////4AAAAAAB////////gAAAAAAH///////+AAAAAAAf///////wAAAAAAA////////AAAAAAAD///////+AAAAAAAH///////4AAAAAAAf///////4AAAAAAA////////4AAAAAAB////////gAAAAAAD///////gAAAAAAAH//x///+AAAAAAAAf+AAAf/AAAAAAAAB+AAAAP8AAAAAAAAHkAAAAfwAAAAAAAAcwAAAA8AAAAAAAABiAAAAAAAAAAAAAAEYAAAAAAAAAAAAAAzAAAAAAAAAAAAAAGYAAAAAAAAAAAAAAzAAAAAAAAAAAAAAGQAAAAAAAAAAAAAAiAAAAAAAAAAAAAAEQAAAAAAAAAAAAAAiAAAAAAAAAAAAAAEQAAAAAAAAAAAAABiAAAAAAAAAAAAAAMQAAAAAAAAAAAAABGAAAAAAAAAAAAAAIwAAAAAAAAAAAAABGAAAAAAAAAAAAAAIwAAAAAAAAAAAAABGAAAAAAAAAAAAAAYwAAAAAAAAAAAAADGAAAAAAAAAAAAADYwAAAAAAAAAAAAMH/AAAAAAAAAAAAAf/gAAAAAAAAAAAP/+AAAAAAAAAAAAAwGAAAAAAAAAAAAAAHAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"nycticorax-nycticorax-2":{"w":79,"h":93,"bits":"AAAAAAAAAAAAAAAAAAIwAAAAAAAAAAAMwAAAABgAAAAAOYgAAABhAAAAAHcwAAADzgAAAAHe4AAAH3gAAAAD+8gAAP3nAAAAD/8wAAP/vAAAAB/+wAAf//AAAAB//4AAf//MAAAA//8AAf//8AAAA//9gA///8AAAAf//wA///8AAAAf//wA///9AAAAP//4B////gAAAH//+B////gAAAH//+B////gAAAD///B////gAAAB///B////4AAAA///x////8AAAA///x////4AAAAf//7////4AAAAP//7////8AAAAP///////+AAAAH///////+AAAAD///////+AAAAB///////+AAAAA///////+AAAAAf//////+AAAAAP//////+AAAAAH//////8AAAAAD//////4AAAAAB//////8AAAAAAf/////8AAAAAAH/////+AAAAAAA//////AAAAAAAP/////gAAAAAAD/////wAAAAAAA/////4AAAAAAAP////8AAAAAAAH////+AAAAAB/B/////AAAAAH///////gAAAAP///////wAAAAP///////4AAAAf///////8AAAD////////+AAAP/////////AAAf/////////AAAAA////////gAAAAD///////0AAAAAf//////wAAAAAP//////6AAAAAH//////wAAAAAD//////4AAAAAB//////8AAAAAAf/////+AAAAAAH//////AAAAAAB//////gAAAAAAf/////4AAAAAAH/////+AAAAAAA//////gAAAAAAB/////wAAAAAAAB////+AAAAAAAAH////wAAAAAAAAf///8AAAAAAAAH////gAAAAAAAB////gAAAAAAAAP/5/AAAAAAAAAA/8MAAAAAAAAAAB/AAAAAAAAAAAAP8AAAAAAAAAAABnAAAAAAAAAAAAZgAAAAAAAAAAAEYAAAAAAAAAAADMAAAAAAAAAAAAjAAAAAAAAAAAAYgAAAAAAAAAAAGYAAAAAAAAAAABGAAAAAAAAAAAAzAAAAAAAAAAAAIwAAAAAAAAAAAGfwAAAAAAAAAAB/gAAAAAAAAAAA5wAAAAAAAAAAAOeAAAAAAAAAAAD3gAAAAAAAAAAAs8AAAAAAAAAAAJvAAAAAAAAAAAGRgAAAAAAAAAAAwIAAAAAAAAAAAMAAAAAAAAAAAABAAA=="},"nycticorax-nycticorax":{"w":78,"h":93,"bits":"AAAABwAAAAAAAAAAA//gAAAAAAAAAD//8AAAAAAAAAP///gAAAAAAAAf///+AAAAAAAA/////AAAAAAAB////4hgAAAAAB////+EMAAAAAP/////whgAAAB//////8IIAAAH//////+CCAAA////////gggAD////////wAIAH////////4EAAfwB//////8BAAQAAD/////+AAAAAAD//////AAAAAAH//////gAAAAAH//////wAAAAAH//////4AAAAAH//////8AAAAAH//////8AAAAAH//////+AAAAAD///////AAAAAD///////gAAAAD///////gAAAAB///////wAAAAB///////wAAAAA///////4AAAAA///////8AAAAAf//////8AAAAAP//////+AAAAAP//////+AAAAAH///////AAAAAD///////AAAAAB///////gAAAAA///////gAAAAAf//////wAAAAAP//////wAAAAAH//////wAAAAAB//////4AAAAAA//////4AAAAAAf/////4AAAAAAP/////8AAAAAAH/////8AAAAAAD/////8AAAAAAB/////8AAAAAAA/////8AAAAAAA/////+AAAAAAAf////+AAAAAAAP////+AAAAAAAH////+AAAAAAAH////+AAAAAAAD////+AAAAAAAB/////AAAAAAAA5////AAAAAAAA5z///AAAAAAAAYwH//AAAAAAAAc4D//AAAAAAAAd4B//AAAAAAAAd4B//AAAAAAAAc4A/+AAAAAAAAcwAf+AAAAAAAAdwAP/AAAAAAAAdwAPnAAAAAAAAdgAHgAAAAAAAAZgADgAAAAAAAAZgAAAAAAAAAAAZgAAAAAAAAAAAZgAAAAAAAAAAAbgAAAAAAAAAAA7AAAAAAAAAAAA7AAAAAAAAAAAAzAAAAAAAAAAAAzAAAAAAAAAAAA3AAAAAAAAAAAA3AAAAAAAAAAAA/AAAAAAAAAAAP/gAAAAAAAAAA//8AAAAAAAAAB/4eAAAAAAAAAB/4HAAAAAAAAAP//hAAAAAAAAAc/hwAAAAAAAAAB7AoAAAAAAAAAHyAAAAAAAAAAAOWAAAAAAAAAAAcEAAAAAAAAAAA4EAAAAAAAAAAAwMAAAAAAAAAAAAMAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAA=="},"oenanthe-oenanthe-2":{"w":93,"h":75,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAHgIgAAAAAAAAAAAD4BmAAAAAAAAAAAB+MG7AAAAAAAAAAB/vA/sAAAAAAAAAA//wD/wAAAAAAAAAf/8Af/wAAAAAAAAP/+AB//AAAAAAAAH//8AP/8AAAAAAAD///AA//8AAAAAAA///wAH//wAAAAAAf//8AAf//AAAAAAP//+AAB//8AAAAAD///wAAP//4AAAAB///+AAA///gAAAA////gAAD//+AAAAf///4AAAP//4AAAH///+AAAA///gAAB////gAAAD///AAAf///4AAAAP///AAP////AAAAA///8AH////wAAAAD///4B////4AAAAAf///gf///+AAAAAB///+D////gAAAAAH///4////4AAAAAAP///v///8AAAAAAB////////AAAAAAD////////AAAAAAAP///////4AAAAAAAP//////+AAAAAAAA///////wAAAAAAAH//////+AAAAAAAAf//////wAAAAAAAD//////+AAAAAAAAP//////wAAAAAAAA//////+AAAAAAAAH//////wAAAAAAAAf/////+AAAAAAAAD//////wAAAAAAAAf/////8AAAAAAAAB//////gAAAAAAAAP/////8AAAAAAAAA//////gAAAAAAAAH/////8AAAAAAAAAf/////gAAAAAAAAB/////AAAAAAAAAAP////4AAAAAAAAAA/////gAAAAAAAAAD/////AAAAAAAAAAP////8AAAAAAAAAA/////wAAAAAAAAAB////+AAAAAAAAAAH////4AAAAAAAAAAP////gAAAAAAAAAA/////AAAAAAAAAAA////8AAAAAAAAAAB////4AAAAAAAAAA/////wAAAAAAAAA//+B//AAAAAAAAAH//gB/+AAAAAAAAAzwAAH/8AAAAAAAAHJgAAf/4AAAAAAAAZmAAB//wAAAAAAAD8AAAD//AAAAAAAAHwAAAP/+AAAAAAAAHAAAA//wAAAAAAAAYAAAD+AAAAAAAAAAAAAAPwAAAAAAAAAAAAAAcAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"oenanthe-oenanthe":{"w":80,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAA/8AAAAAAAAAAA//wAAAAAAAAAf//+AAAAAAAAAD///wAAAAAAAAAP//+AAAAAAAAAA///wAAAAAAAAAP//+AAAAAAAAAD///gAAAAAAAAAf//4AAAAAAAAAH///AAAAAAAAAB///wAAAAAAAAAf//8AAAAAAAAAH///AAAAAAAAAA///4AAAAAAAAAP//+AAAAAAAAAD///gAAAAAAAAB///8AAAAAAAAAf///gAAAAAAAAP///8AAAAAAAAD////gAAAAAAAA////8AAAAAAAAf////gAAAAAAAH////+AAAAAAAB/////wAAAAAAAf////+AAAAAAAH/////gAAAAAAB/////8AAAAAAAf/////gAAAAAAH/////8AAAAAAB//////gAAAAAAf/////8AAAAAAH//////gAAAAAA//////8AAAAAAP//////gAAAAAD//////4AAAAAAf//////AAAAAAH//////4AAAAAA///////AAAAAAP//////wAAAAAB//////+AAAAAAP//////wAAAAAD//////8AAAAAAf//////gAAAAAD//////8AAAAAAf//////gAAAAAD//////8AAAAAAf//////gAAAAAD//////+AAAAAAf//////wAAAAAB//////+AAAAAAP//////gAAAAAA//////4AAAAAAH//////AAAAAAA////H/8AAAAAAH//+AP/gAAAAAA4f8AAf+AAAAAAODwAAA/wAAAAADgcAAAH+AAAAAAYHgAAAf4AAAAAGA4AAAD/AAAAABAMAAAAP8AAAAAwDAAAAB/gAAAAIAwAAAAP8AAAAGAIAAAAA+AAAABACAAAAAAAAAAAwBgAAAAAAAAAAIAQAAAAAAAAAAGAEAAAAAAAAAABADAAAAAAAAAAAwAwAAAAAAAAAAIAIAAAAAAAAAAGAGAAAAAAAAAADABgAAAAAAAAAB/4QAAAAAAAAA/+4MAAAAAAAAAE+ADAAAAAAAAAAJAAwwAAAAAAAAcwAf4AAAAAAAA4YF+AAAAAAAAA8MHtAAAAAAAAAIEACQAAAAAAAAAAADIAAAAAAAAAAADGAAAAAAAAAAAHDAAAAAAAAAAADggAAAAAAAAAABAQAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"oenanthe-pleschanka-2":{"w":93,"h":46,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPgAAAAAAAAAAAAAH/gAAAAAAAAAAAAD/+AAAAAAAAAAAAA//8AAAAAAAAAAAA///wAAAAAAAAAAAP///8AAAAAAAAAAAD///8AAAAAAAAAAAP///4AAAAAAAAAAA////wAAAAAAAAAAD////AAAAAAAAAAAf/n/+AAAAAAAAAAP/8f/8AAAAAAAAAH//j//wAAAAAAAAB//8f//AAAAAAAAA///j//8AAAAAAAAP//8P//wAAAAAAAD///h///AAAAAAAB///4H//8AAAAAAAf//+A///4AAAAAAP//+AD///wAAAAAD///wAP/+fAAAAAA////gA//w8AAAAAf///+AH/+B8AAAAH////8Af/4H4AAAB/////8B//f/4AAAf/////4P/4D/4AAP//+gAAP//gH/wAD///gAAH7/+Af/wA///wAAH4P/wA//AP//4AAA/w/+AB/4D/+4AAAEjD/4AD4A+7sAAAAkAP/gACADu4AAAAGwA/8AAAATEAAAAAbAD/gAAAAAAAAAABIAP+AAAAAAAAAAAAAA/wAAAAAAAAAAAAAD+AAAAAAAAAAAAAAPwAAAAAAAAAAAAAA+AAAAAAAAAAAAAADoAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"oenanthe-pleschanka":{"w":73,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH4AAAAAAAAAA//gAAAAAAAAB//8AAAAAAAAB///gAAAAAAAP///4AAAAAAD////8AAAAAAAf////AAAAAAAB////wAAAAAAAH///8AAAAAAAB///+AAAAAAAAf///gAAAAAAAH///wAAAAAAAB///4AAAAAAAA///+AAAAAAAAf///AAAAAAAAH///gAAAAAAAD///wAAAAAAAD///4AAAAAAAD///+AAAAAAAD////AAAAAAAD////gAAAAAAD////4AAAAAAD////8AAAAAAD////+AAAAAAD/////gAAAAAD/////wAAAAAD/////4AAAAAD/////8AAAAAD/////+AAAAAD//////AAAAAD//////gAAAAB//////gAAAAB//////wAAAAB//////4AAAAB//////8AAAAB//////8AAAAA//////+AAAAA//////+AAAAA///////AAAAAf//////AAAAAf//////gAAAAP//////gAAAAP//////gAAAAP//////wAAAAH//////wAAAAH//////wAAAAD//////wAAAAB//////wAAAAB//////wAAAAA//////wAAAAA//////wAAAAAf/////wAAAAAP/////wAAAAAP/////wAAAAAH/////wAAAAAH/////gAAAAAD/////gAAAAAD/////gAAAAAB/////wAAAAAB////nwAAAAAA///8DIAAAAAAX//HDgAAAAAAD/+Bz8AAAAAAD/+Af/wAAAAAD/8AH44AAAAAB/8AH/uAAAAAB/4AeAzgAAAAB/8AOAEcCAAAB/8AIAAHGPAAA/8AEAAB/+AAA/+ABAAAf4AAA/+AAAAA//AAA/+AAAAD4FwAAf/AAAADwAIAAf/AAAADAAAAAf/AAAAAgAAAAf/gAAAAAAAAAf/gAAAAAAAAAP/wAAAAAAAAAP/wAAAAAAAAAP/wAAAAAAAAAH/4AAAAAAAAAH/4AAAAAAAAAD/8AAAAAAAAAD/8AAAAAAAAAB/8AAAAAAAAAAf+AAAAAAAAAAA+AAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"pandion-haliaetus-2":{"w":82,"h":93,"bits":"AAAAAAAAAAAAAAIAAAAAAAAAAAAAwAAAAAAAAAAAAREAAAAAAAAAAABmYAAAAAAAAAAADMgAAAAAAAAAAAGbAAAAAAAAAAAAd2AAAAAAAAAAAG74AAAAAAAAAAAN/wAAAAAAAAAAAf/gAAAAAAAAAAA//AAAAAAAAAAAJ/+AAAAAAAAAAAf/8AAAAAAAAAAA//4AAAAAAAAAAB//wAAAAAAAAAAD//gAAAAAAAAAAf//AAAAAAAAAAA///AAAAAAAAAAB//+AAAAAAAAAAD//8AAAAAAAAAAP//4AAAAAAAAAAf//wAAAAAAAAAB///gAAAAAAAAAB///AAAAAAAAAAH//+AAAAAAAAAAP//8AAAAAAAAAAf//wAAAAAAAAAA///AAAAAAAAAAB//+AAAAAAAAAAD//4AAAAAAAAAAP//gAAAAAAAAAAf//AAAAAAAAAAB//8AAAAAAAAAAH//4AAAAAAAAAAf//gAAAAAAAAAA///AAAAAAAAAAB//8AAAAAAAAAAH//4AAAAAAAAAAf//gAAAAAAAAAA///AAAAAAAAAAD//+AAAAAAAAAAH//8AAAAAAAAAAP//4AAAAAAAAAA////wAAAAAAAAB////wAAAAAAAAH////gAAAAAAAAP///+AAAAAAAAAf///8AAAAAAAAA////wAAAAAAAAA///4AAAAAAAAAD///AAAAAAAAAP///8AAAAAAAB/////4AAAAAAAD/////wAAAAAAAP/////gAAAAAAA//////gAAAAAAD//////AAAAAAAP//////AAAAAAA//+P//+AAAAAAB//wf//+AAAAAAH//B///+AAAAAAP/4D///+AAAAAAP/gH///8AAAAAA/8AP///wAAAAAB/wAf///gAAAAAD/AA///+AAAAAAB4AB///8AAAAAAAAAB///4AAAAAAAAAB///gAAAAAAAAAH///AAAAAAAAAAH//+AAAAAAAAAAP//4AAAAAAAAAAP//wAAAAAAAAAAf//AAAAAAAAAAA//+AAAAAAAAAAA//8AAAAAAAAAAD//wAAAAAAAAAAH//gAAAAAAAAAAP//AAAAAAAAAAAf/+AAAAAAAAAAA//8AAAAAAAAAAA//4AAAAAAAAAAD//wAAAAAAAAAAH//gAAAAAAAAAAH/zAAAAAAAAAAAP9gAAAAAAAAAAAf7AAAAAAAAAAAAtmAAAAAAAAAAAAbMAAAAAAAAAAAAmYAAAAAAAAAAAAMAAAAAAAAAAAAAAA"},"pandion-haliaetus":{"w":83,"h":93,"bits":"AAAAAAAAAAAAAAA/gAAAAAAAAAAAD/+AAAAAAAAAAAH/+AAAAAAAAAAA///AAAAAAAAAAB///AAAAAAAAAAD//+AAAAAAAAAAH//8AAAAAAAAAAP//8AAAAAAAAAAf//8AAAAAAAAAA///4AAAAAAAAAB///4AAAAAAAAAD///wAAAAAAAAAH///AAAAAAAAAAP//+AAAAAAAAAA///8AAAAAAAAAB///8AAAAAAAAAB///+AAAAAAAAAD///+AAAAAAAAAH////AAAAAAAAAf////wAAAAAAAB/////8AAAAAAAH/////+AAAAAAAP//////AAAAAAAf//////gAAAAAB///////gAAAAAD///////wAAAAAH///////wAAAAAH///////wAAAAAP///////4AAAAAf///////4AAAAA////////4AAAAA////////wAAAAB////////wAAAAD////////wAAAAD////////wAAAAH////////wAAAAH////////wAAAAP////////gAAAAf////////gAAAAf////////gAAAA/////////gAAAA/////////gAAAB/////////AAAAB////////+AAAAD////////8AAAAD////////4AAAAH////////wAAAAH////////wAAAAH////////wAAAAD////////wAAAAD////////gAAAAB////////gAAAAB////////gAAAAA////////AAAAAA///////+AAAAAB///////+AAAAAD///////8AAAAAD///////8AAAAAH///////4AAAAAP///////4AAAAAf///////wAAAAAf///////gAAAAA////////AAAAAA///////+AAAAAB///////8AAAAAB///////4AAAAAD///////wAAAAAH///////wAAAAAH//P////wAAAAAP/+D////wAAAAAf/8H////wAAAAA//4H////wAAAAD//gH////wAAAAH+eAH////4AAAAf4AAF////4AAAd/4AAA////4AAB//+AAAf/9/wAAH//8AAAf/4/wAAP//8AAA//4fgAAT//4AAA//wfgAAn//wAAA//wPAABn8/AAAB//gHAAAE8EAAAB//gGAAAN4AAAAB//gCAAABgAAAAB//AAAAAB4AAAAB//AAAAABAAAAAD/+AAAAAAAAAAAD/+AAAAAAAAAAAD/8AAAAAAAAAAAB/4AAAAAAAAAAAB7wAAAAAAAAAAAAAAA="},"parus-major-2":{"w":93,"h":84,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAABBAAAAAAAAAAAAAAYYAAAAAAAAAAAABHGAAAAAAAAAAAAAZzwAAAAAAAAAAAADe8QAAAAAAAAAAAAzvGAAAAAAAAAAAAG/7gAAAAAAAAAAAB/+8AAAAAAAAAAAAP//AAAAAAAAAAAAD//zAAAAAAAAAAAA//9wAAAAAAAAAAAH//+AAAAAAAAAAAB///gAAAAAAAAAAAf//4AAAAAAAAAAAD//+AAAAAAAAAAAA///uAAAAAAAAAAAP///gAAAAAAAAAAB///4AAAAAAAAAAAf//+AAAAAAAAAAAH///gAAAAAAAAAAB///+AAAAAAAAAAAP///wAAAAAAAAAAD///8AAAAAAAAAAA////AAAAAAAAAAAP///wAAAAAAAAAAB////AAAAAAAAAAAf///wAAAAAAAAAAH///8AAAAAAAAD8A////AAAAAAAAD/4P///gAAAAAAAA//x///+AAAAAAAAP//f///wAAAAAAAD//////+AAAAAAAAf//////wAAAAAAAH//////+AAAAAAAA///////wAAAAAAAP//////+AAAAAAAD///////wAAAAAAA///////+AAAAAAAAP//////wAAAAAAAA//////8AAAAAAAAD//////wAAAAAAAAf/////8AAAAAAAAD//////AAAAAAAAB//////4AAAAAAAB///////AAAAAAAA///////gAAAAAAAP/////8AAAAAAAAD//////gAAAAAAAB//////+AAAAAAAAf//////4AAAAAAAH///////gAAAAAAB///////+AAAAAAAf///////wAAAAAAP////////gAAAAAD////////+AAAAAB/////////8AAAAAf/////////wAAAAH//////////gAAAD////////j/+AAAA////////8P/8AAAf//////+fA//4AAH//////zvgH//gAD//////8cAAf//AB//////8BwAB//8A+/////oAHAAH//4AP////4AAQAAf//gD////8AAAAAB//8A////9AAAAAAH/+AP////AAAAAAAf8AHnv//QAAAAAAB/AAxz3uwAAAAAAAHwAAc97kAAAAAAAAeAAHPOcAAAAAAAAAgABhznAAAAAAAAAAAAAY4gAAAAAAAAAAAAEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"parus-major":{"w":93,"h":69,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAeAAAAAAAAAAAAAAPgAAB/8AAAAAAAAD8IAA//4AAAAAAAB//AAP//wAAAAAAA//4AD///AAAAAAAP//AA///8AAAAAAD//wAP///wAAAAAB//4AB////AAAAAAf/+AAf///8AAAAAP//AAf////8AAAAD//gAH/////+AAAA//wAA//////+AAAP/4AAA//////8AAH/+AAAB//////8AD//AAAAP///////A//gAAAA////////f/wAAAAH/////////4AAAAA/////////+AAAAAH/////////gAAAAAf////////kAAAAAD////////5AAAAAA/////////QAAAAAH////////+AAAAAA/////////8AAAAAH/////////wAAAAAf/////////AAAAAD/////////gAAAAAf////////+AAAAAD/////////8AAAAAP/////////4AAAAB//////////gAAAAH///////8AeAAAAAf///////AAAAAAAD///////wAAAAAAAP//////+AAAAAAAA///////AAAAAAAAD//////wAAAAAAAAH/////+AAAAAAAAAf/////gAAAAAAAAA/////4AAAAAAAAAB////8AAAAAAAAAAD///8AAAAAAAAAAAD///gAAAAAAAAAAAH/78AAAAAAAAAAADwAfAAAAAAAAAAAA4ADgAAAAAAAAAAAcAAwAAAAAAAAAAAP/gcAAAAAAAAAAAD8SHAAAAAAAAAAAB8ABwAAAAAAAAAAAfAAYAAAAAAAAAAADwAH/wAAAAAAAAAAcAD+SAAAAAAAAAADwB8AAAAAAAAAAAAcAfgAAAAAAAAAAACQF4AAAAAAAAAAAAIAuAAAAAAAAAAAAAADwAAAAAAAAAAAAAAeAAAAAAAAAAAAAACgAAAAAAAAAAAAAAiAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"passer-domesticus-2":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAABgwAAAABCAAAAAADhgAAAABGIAAAAAHDgAAAADGYAAAAAPPAAAAADOYAAAAA+eAAAAAHO4AAAAB9+OAAAAHcxAAAAD/8cAAAAPdzAAAAH/54AAAAO/3AAAAP/3wAAAAf/uAAAA///gAAAAf/+AAAB///gAAAA//+YAAD///EAAAA//8wAAH//8cAAAB//9wAAP//94AAAB///wAAf///wAAAD///gAA////gAAAD///kAD////AAAAD///8AH///+AAAAH///8AP///8wAAAH///4Af////wAAAH///wB/////gAAAH///4D/////AAAAP///8H////+AAAAP///4P////8AAAAf///+f////4AAAAf///+/////8AAAAf/////////8AAAAf/////////4AAAAf/////////wAAAAf/////////AAAAD/////////+AAAAH//////////AAAAf//////////AAAA//////////8AAAA//////////wAAAB//////////gAAAD//////////wAAAH//////////AAAAP/////////4AAAAf/////////8AAAAf/////////8AAAAB/////////8AAAAAf////////4AAAAAf////////8AAAAAf////////8AAAAAP////////8AAAAAH////////8AAAAAH////////8AAAAAD////////8AAAAAB////////8AAAAAB////////8AAAAAB////////8AAAAAA////////4AAAAAA////////4AAAAAAf///////4AAAAAAf///////4AAAAAAP///////wAAAAAAH///////gAAAAAAH//////gAAAAAAAD//////wAAAAAAAB//////4AAAAAAAA//////8AAAAAAAAf/////+AAAAAAAAH//////AAAAAAAAD//////gAAAAAAAB//////wAAAAAAAAf/////4AAAAAAAAH/////8AAAAAAAAA/////+AAAAAAAAAH////+AAAAAAAAAH/////AAAAAAAAB//////wAAAAAAAB///7//4AAAAAAAB/8Pw//+AAAAAAADj+AAH//gAAAAAADzzgAA//wAAAAAABz4wAAf/8AAAAAABz44AAP/+AAAAAAB54IAAH//gAAAAAA94AAAD//4AAAAAAc8AAAB//8AAAAAAPYAAAA///AAAAAAAGAAAAP//wAAAAAAAAAAAH//4AAAAAAAAAAAD/f8AAAAAAAAAAAB/n+AAAAAAAAAAAA/gAAAAAAAAAAAAAfAAAAAAAAAAAAAAPAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAA"},"passer-domesticus":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAB/4AAAAAAAAAAAAB//4AAAAAAAAAAAAf//gAAAAAAAAAAAP///AAAAAAAAAAAB///8AAAAAAAAAAAf///wAAAAAAAAAAH////AAAAAAAAAAB////8AAAAAAAAAA/////gAAAAAAAAAP////+AAAAAAAAAD/////8AAAAAAAAAf/////+AAAAAAAAAf/////8AAAAAAAAAf/////4AAAAAAAAB//////wAAAAAAAAP//////gAAAAAAAB//////+AAAAAAAAH//////8AAAAAAAA///////wAAAAAAAD///////AAAAAAAAf//////8AAAAAAAD///////wAAAAAAAf///////AAAAAAAD///////8AAAAAAAf///////wAAAAAAD////////AAAAAAAP///////+AAAAAAB////////4AAAAAAP////////gAAAAAA////////+AAAAAAH////////4AAAAAAf////////AAAAAAD////////8AAAAAAP////////wAAAAAB/////////AAAAAAH////////8AAAAAAf////////gAAAAAB////////+AAAAAAH////////wAAAAAAf///////+AAAAAAB////////4AAAAAAH////////gAAAAAAP///////+AAAAAAA////////4AAAAAAB////////gAAAAAAD///////8AAAAAAAH///////wAAAAAAAP//////6AAAAAAAAP//////AAAAAAAAD//////wAAAAAAAB//////+AAAAAAAAfn/////4AAAAAAAD////H//gAAAAAAA8/gfgP/+AAAAAAADj+AAAf/4AAAAAAAcc8AAA//gAAAAAAD3hwAAA/+AAAAAAAe+HAAAD/4AAAAAAB/wIAAAP/wAAAAAAOfBAAAA//AAAAAAAf+AAAAD/8AAAAAAAHkAAAAP/wAAAAAAAfAAAAA//AAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAA//AAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAA/+AAAAAAAAAAAAAD/gAAAAAAAAAAAAAP8AAAAAAAAAAAAAA/wAAAAAAAAAAAAAD+AAAAAAAAAAAAAAPgAAAAAAAAAAAAAAAA="},"periparus-ater-2":{"w":77,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAECAAAAAAAAAAAMEAAAAAAAAAAAcMAAAAAAAAAAAccAAAAAAAAAAA88AAAAAAAAIAA44AAAAAAAAQAx54AAAAAAABjAx54AAAAAABHMBz74AAAAAAGO4B7/wAAAAAAM5wD7/wAAAAAA53gD//wAAAAAB3uAH//wAAAAA3v8CH//wAAAADv/4DH//gAAAAHf/gHn//gAAAAP//AH3//gAAAG//+AP///gAAAP//4AP///gAAAf//wAP///AAAB///AAP///AAAP//+AAP///AAA///8AHv///AAB///wAP////AAD///gAP////AAP//+AAP///+AB///8AAP///+AD///wAAH///+AP///AAB////+A///+AAB////+D///4AAB////+P///wAAB////+////AAAB////////+AAAH////////4AAAH////////gAAAH////////gAAAD////////gAAAP////////AAAAf////////AAAAP///////+AAAAf///////8AAAB////////4AAAB////////8AAAD////////8AAAH///////+gAAAP///////4AAAAP///////gAAAA///////+AAAAA///////4AAAAB///////wAAAAD///////gAAAAD///////AAAAAD//////8AAAAAH/3////4AAAAAP+P////wAAAAAHA/////AAAAAAAB////8AAAAAAAH////4AAAAAAAP////gAAAAAAAf///+AAAAAAAA////4AAAAAAAB////gAAAAAAAH///+AAAAAAAAP///4AAAAAAAAf////AAAAAAAB////+AAAAAAAD////uAAAAAAAP///mcAAAAAAA////Y4AAAAAAD//+PhwAAAAAAH//I6DAAAAAAAf/4x0OAAAAAAB/+BDA4AAAAAAH/4BGAAAAAAAAf/wAIAAAAAAAB//AAAAAAAAAAH/+AAAAAAAAAAP/4AAAAAAAAAA//wAAAAAAAAAD//AAAAAAAAAAP/+AAAAAAAAAA//4AAAAAAAAAD//wAAAAAAAAAH//AAAAAAAAAAf/8AAAAAAAAAA+H4AAAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"periparus-ater":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+AAAAAAAAAAAAAf/8AAAAAAAAAAAAP//wAAAAAAAAAAAD///AAAAAAAAAAAA///8AAAAAAAAAAAP///wAAAAAAAAAAD///+AAAAAAAAAAA////4AAAAAAAAAAP////wAAAAAAAAAD/////AAAAAAAAAAf////wAAAAAAAAAf////wAAAAAAAAAP////+AAAAAAAAAD/////wAAAAAAAAB/////8AAAAAAAAAf/////gAAAAAAAAP/////8AAAAAAAAH//////AAAAAAAAD//////4AAAAAAAB///////AAAAAAAAf//////wAAAAAAAP//////+AAAAAAAD///////wAAAAAAB///////+AAAAAAAf///////wAAAAAAH///////+AAAAAAB////////wAAAAAA////////8AAAAAAP////////gAAAAAH////////8AAAAAB/////////gAAAAA/////////4AAAAAP/////////AAAAAD/////////wAAAAB/////////8AAAAA//////////AAAAA//////////wAAAA//////////8AAAAf/+f///////AAAAf/+AH//////wAAAP//AAD/////8AAAH//AAAH/////AAAB//gAAAf////gAAAD/gAAAB////4AAAAfwAAAAD///8AAAAH4AAAAAH//+AAAAAAAAAAAAB//4AAAAAAAAAAAAf7/gAAAAAAAAAAAB+YOAAAAAAAAAAAAA+BwAAAAAAAAAAAAD+cAAAAAAAAAAAAAh/AAAAAAAAAAAAAEB4AAAAAAAAAAAAAAPgAAAAAAAAAAAAAP+AAAAAAAAAAAAAPB4AAAAAAAAAAAADgHAAAAAAAAAAAAAwA4AAAAAAAAAAAAEEeAAAAAAAAAAAAAQfwAAAAAAAAAAAAAA8AAAAAAAAAAAAAAHAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"phalacrocorax-carbo-2":{"w":74,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIAAAAAAAAAAALQAAAAAAAAAAC0AAAAAAAAAAA9YAAAAAAAAAAP0AAAAAAAAAAD/YAAAAAAAAAA/8AAAAAAAAAAP/AAAAAAAAAAD/8AAAAAAAAAB//AAAAAAAAAAf/4AAAAAAAAAH/+AAAAAAAAAB//gAAAAAAAAAf/4AAAAAAAAAP/+AAAAAAAAAD//gAAAAAAAAA//4AAAAAAAAAP/+AAAAAAAAAD//gAAAAAAAAA//wAAAAAAAAAP/8AAAAAAAAAH//gAAAAAAAAB//8AAAAAAAAAf//gAAAAAAAAH//4AAAAAAAAB///AAAAAAAAAP//wAAAAAAAAB//+AAAAAAAAAP//gAAAAAAAAB//8AAAAAAAAAf//AAAAAAAAAD//wAAAAAAAAA//8AAAAAAAAAH//gAAAAAAAAB//4AAAAAAGAAf/+AAAAAA/wAP//AAAAAA//gD//wAAAAA//+A//+AAAAH///w///gAAAD///8f//8AAAAAH/////+AAAAAAAH////4AAAAAAA/////gAAAAAAP////8A8AAAAB/////4/wAAAAH//////+AAAAAD//////gAAAAAf//D//+AAAAAB//gf//gAAAAAB/4n//8AAAAAAf/////AAAAAAH//H//gAAAAAB//w//wAAAAAA//+Af8AAAAAAP//gB+AAAAAAD//4AMAAAAAAB//+AAAAAAAAA///AAAAAAAAAP//wAAAAAAAAD//8AAAAAAAAA///AAAAAAAAAP//gAAAAAAAAD//4AAAAAAAAA//+AAAAAAAAAH//AAAAAAAAAB//wAAAAAAAAAf/8AAAAAAAAAD//gAAAAAAAAA//4AAAAAAAAAP/+AAAAAAAAAD//wAAAAAAAAAf/8AAAAAAAAAH//AAAAAAAAAB//wAAAAAAAAAP/4AAAAAAAAAD//AAAAAAAAAA//wAAAAAAAAAH/4AAAAAAAAAB/+AAAAAAAAAAP/gAAAAAAAAAD/oAAAAAAAAAA/8AAAAAAAAAAN7AAAAAAAAAABaQAAAAAAAAAAWwAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"phalacrocorax-carbo":{"w":56,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAPwAAAAAAAf/gAAAAA////AAAAA////4AAAAP////AAAAAA///gAAAAAB//4AAAAAAP//AAAAAAA//wAAAAAAH/8AAAAAAAf/AAAAAAAB/wAAAAAAAf8AAAAAAAH/AAAAAAAB/wAAAAAAB/8AAAAAAA/+AAAAAAA//gAAAAAAf/wAAAAAAH/4AAAAAAD/+AAAAAAA//AAAAAAAf/wAAAAAAH//AAAAAAB//8AAAAAAf//wAAAAAH//+AAAAAB///4AAAAAf///AAAAAH///4AAAAA////AAAAAP///4AAAAB////AAAAAf///4AAAAH////AAAAB////4AAAAf////AAAAH////wAAAA////+AAAAP////wAAAD////8AAAAf////gAAAH////4AAAA/////AAAAP////wAAAB////+AAAAf////gAAAD////4AAAA////+AAAAH////wAAAB////8AAAAP////gAAAB/7//4AAAAP+f/+AAAAB/j//gAAAAf4f/8AAAAD8D//AAAAAfgf/wAAAAD4D/8AAAAA+B//AAAAAHgf/wAAAAB8H/8AAAAAPv//AAAAAB///4AAAAAf//+AAAAAOf//gAAAADn//4AAAAB5z/+AAAAP/8f/gAAAP+OB/YAAAH/DgfyAAAA/n8H+AAAAH/9B/gAAAB//Af4AAAAY/gH/AAAACP4B/wAAAAD+Af8AAAAA/wH/AAAAAP4B/4AAAAAYAf+AAAAACAD/gAAAAAAA/4AAAAAAAH+AAAAAAAB/wAAAAAAAP8AAAAAAAB/AAAAAAAAPwAAAAAAAA8AAAAAAAACAAAAAAAAAAAAAAAAAAA"},"phasianus-colchicus-2":{"w":72,"h":93,"bits":"AAAAAAAAAAAAAAAAAQAAAAAAAAAAEiAAAAAAAAAAJsAAAAAAAAAAfYAAAAAAAAAA/6AYwAAAAAAA/+AzgAAAAAAB/8D/cAAAAAAD/6H/4AAAAAAD/+P/iAAAAAAH/8//+AAAAAAH////4AAAAAAP////gAAAAAAP////4AAAAAAP////wAAAAAAf////gAAAAAA/////gAAAD4A/////AAAAD+A/////AAAAP/w////+AAAAf/w////8AAAAH/w////4AAAAD/wf///wAAAAD/4f///gAAAAA/+P//+AAAAAAP/P//8AAAAAAH////8AAAAAAH////8AAAAAAH////8AAAAAAH////8AAAAAAH////8AAAAAAD////8AAAAAAD////8AAAAAAB////4AAAAAAB////4AAAAAAA////4AAAAAAA////4AAAAAAAf///wAAAAAAAP///wAAAAAAAH///4AAAAAAAH///8AAAAAAAD///+AAAAAAAB////AAAAAAAAf///AAAAAAAAP///gAAAAAAAD///wAAAAAAAA///4AAAAAAAAP//8AAAAAAAAH//8AAAAAAAAD//+AAAAAAAAA//+AAAAAAAAAP/+AAAAAAAAAHf/AAAAAAAAAFP/gAAAAAAAAFn/gAAAAAAAAHj/wAAAAAAAAH5/4AAAAAAAAGw/8AAAAAAAAD4f+AAAAAAAADOf+AAAAAAAADmH/AAAAAAAABxD/gAAAAAAAAYB/wAAAAAAAAEA/wAAAAAAAAAAf4AAAAAAAAAAP8AAAAAAAAAAH8AAAAAAAAAAD+AAAAAAAAAAB/AAAAAAAAAAAfAAAAAAAAAAAPgAAAAAAAAAAHwAAAAAAAAAAHwAAAAAAAAAAD4AAAAAAAAAAB4AAAAAAAAAAB8AAAAAAAAAAA8AAAAAAAAAAA+AAAAAAAAAAAOAAAAAAAAAAAPAAAAAAAAAAAHgAAAAAAAAAACgAAAAAAAAAADwAAAAAAAAAABQAAAAAAAAAABIAAAAAAAAAABoAAAAAAAAAAAkAAAAAAAAAAAkAAAAAAAAAAASAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"phasianus-colchicus":{"w":54,"h":93,"bits":"AAAAAAAMAAAAAAAA/AAAAAAAB/gAAAAAAD/8AAAAAAH/4AAAAAAB/4AAAAAAA/4AAAAAAAf4AAAAAAAP4AAAAAAAf8AAAAAAAf8AAAAAAA/8AAAAAAB/8AAAAAAD/+AAAAAAH/+AAAAAAP/+AAAAAA//+AAAAAD//+AAAAAP///AAAAAf///AAAAA////AAAAB////AAAAD////AAAAD////AAAAH///+AAAAP///+AAAAf///+AAAAf///+AAAA////8AAAA////4AAAB////4AAAB////wAAAB////wAAAD////gAAAD////AAAAD///+AAAAH///8AAAAH///4AAAAH///4AAAAH///wAAAAH///gAAAAH///gAAAAH///AAAAAP/DPAAAAAf/DGAAAAA/+DGAAAAA/8DGAAAAB/8DGAAAAB/4DCAAAAD/wCGAAAAH/gH3AAAAH/gPzAAAAP/AIb3gAAP/AAH8AAAf+AAJ4AAAf8AAAPAAA/8AAAAAAA/4AAAAAAB/wAAAAAAB/gAAAAAAD/AAAAAAAD/AAAAAAAH+AAAAAAAH8AAAAAAAP8AAAAAAAP4AAAAAAAfwAAAAAAAfwAAAAAAA/gAAAAAAA/gAAAAAAA/AAAAAAAB+AAAAAAAB+AAAAAAAB8AAAAAAAD8AAAAAAAD4AAAAAAAHwAAAAAAAHwAAAAAAAHwAAAAAAAGgAAAAAAAOgAAAAAAAMgAAAAAAANAAAAAAAAZAAAAAAAAYAAAAAAAAQAAAAAAAAQAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"phoenicurus-ochruros-2":{"w":93,"h":78,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAyAAAAAAAAAAAAAAHYAAAAAAAAAAAAAA/kAAAAAAAAAAAAAD+wAAAAAAAAAAAAAf/AAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/sAAAAAAAAAAAAB//wAAAAAAAAAAAAH//AAAAAAAAAwAAA//+AAAAAAAAP4AAD//4AAAAAAAD+AAAf//4AAAAAAA/4AAB///AAAAAAAP/AAAP///AAAAAAD/wAAA///4AAAAAA/+AAAH///AAAAAAP/wAAAf//+AAAAAD/+AAAD///wAAAAA//gAAAP///4AAAAP/+AAAB////8AAAD//+AAAH////8AAA////AAA//+A/wAAP///+AAD//gAPgAD////4AAP/8gA+AAf////AAB///wA4AH////wAAH///wBgB////8AAA////h8A////8AAAH////Dj////+AAAAf////P////+AAAAB/////////+AAAAAH/////////AAAAAAf////////AAAAAAAH///////AAAAAAAP///////AAAAAAAH///////wAAAAAAD///////+AAAAAAA////////gAAAAAAH///////8AAAAAAB////////AAAAAAAf///////4AAAAAAP////////gAAAAAP////////+AAAAABP////////8AAAAAAP////////wAAAAAAf///////+AAAAAAB////////8AAAAAAH////////gAAAAAAf///////8AAAAAAB////////gAAAAAAH///////+AAAAAAAf///////wAAAAAAA////////AAAAAAAD///////4AAAAAAAP///////wAAAAAAAf///////gAAAAAAA///f///+AAAAAAAB/+B////wAAAAAAAAAgT////AAAAAAAAAPsH///8AAAAAAAADBAP///wAAAAAAAAYwAP//8AAAAAAAAHPwA///4AAAAAAAA5gAB///wAAAAAAAD8AAD///AAAAAAAAJgAAH//4AAAAAAAAcAAAP//AAAAAAAAB8AAAf/+AAAAAAAAAAAAAf/4AAAAAAAAAAAAA//gAAAAAAAAAAAAA/4AAAAAAAAAAAAAA/gAAAAAAAAAAAAAA+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"phoenicurus-ochruros":{"w":61,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAf/gAAAAAAA//4AAAAAAA///AAAAAAA///wAAAAAB///8AAAAAP////AAAAAP////gAAAAA////4AAAAAD///+AAAAAA////AAAAAAf///wAAAAAH///4AAAAAD///8AAAAAB////AAAAAAf///gAAAAAP///wAAAAAH///4AAAAAH///8AAAAAH////AAAAAP////gAAAAP////4AAAAP////8AAAAP////+AAAAP/////AAAAH/////gAAAH/////4AAAH/////8AAAD/////+AAAD//////AAAB//////gAAB//////wAAA//////wAAA//////4AAAf/////8AAAf/////+AAAf//////AAAP//////AAAP//////gAAH//////gAAH//////wAAD//////4AAB//////4AAB//////8AAA//////8AAAf/////8AAAf/////+AAAP/////+AAAH/////+AAAD/////+AAAB/////+AAAA/////+AAAAf////+AAAAf////+AAAAPf///+AAAAPv///8AAAAHv///+AAAAH3////+AAADz//8AD4AAB7//4AA/AAA5//OAPzwAA9//jwEBoAAc//g8EB0AAO//g/AA4AAGf/g2gAcAACf/AzYAMAAAP/gR4AGAAAP/gA4AHAAAH/wA4ABAAAH/4AcABAAAH/4AcAAAAAD/8ACAAAAAD/8ACAAAAAB/+AAAAAAAB//AAAAAAAA//AAAAAAAA//gAAAAAAAf/gAAAAAAAf/wAAAAAAAP/wAAAAAAAP/4AAAAAAAH/4AAAAAAAD/8AAAAAAAD/+AAAAAAAB/+AAAAAAAB//AAAAAAAA//AAAAAAAAfnAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"phoenicurus-phoenicurus-2":{"w":81,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAADgAAAAAAAAAAAEPAAAAAAAAAAAA48AAAAAAAAAAADz4AAAAAAAAAAAP/gAAAAAAAAAAA/+AAAAAAAAAAAz/8AAAAAAAAAAH//wAAAAAAAAAAf//AAAAAAAAAAB//8AAAAAAAAAAD//4AAAAAAAAAD///gAAAAAAAAAf//+AAAAAAAAAB///4AAAAAAAAAD///gAAAAAAAAAf//+AAAAAAAAAH///4AAAAAAAAA////gAAAAAAAAD///+AAAAAAAAAH///4AAAAAAAAA////gAAAAAAAAH///8AAAAAAAAAf///wAAAAAAAAB////AAAAAAAAAH///8AAAAAAAAA////wAHwAAAAAD///+AD/wAAAAAP///4B//gAAAAA////A//+AAAAAD///8P//wAAAAA////j///AAAAAH///8///8AAAAA////////8AAAAH////////wAAAA////////AAAAAH///////wAAAAA///////8AAAAAH///////AAAAAA///////wAAAAAH//////8AAAAAA///////gAAAAAH//////4AAAAAA///////AAAAAAD//////4AAAAAAf/////+AAAAAAD//////8AAAAAAP//////8AAAAAA///////4AAAAAA7//////gAAAAAAf/////8AAAAAAH//////wAAAAAA///////AAAAAAP//////4AAAAAB///////gAAAAAP//////8AAAAAD///////wAAAAAf//////+AAAAAH///////4AAAAA////////AAAAAP///////8AAAAB////////gAAAAP///////+AAAAD////////wAAAA/////////AAAAP////////4AAAD/////////gAAA/////////8AAAP////5////wAAD////fAf//+AAA//4+G4A///4AAP/+EDOAD///AAD//gAzwAP//4AA//4AIeAA///gAP//AAHgAD//8AD//wAAwAAf//gA//8AAIAAD//+AP//AAAAAAP//wD//4AAAAAAf/+A//+AAAAAAD//4P//gAAAAAAN//B//8AAAAAABv/YH//AAAAAAAB37AP/wAAAAAAAG7MAH+AAAAAAAAzcgA/gAAAAAAACZgAD4AAAAAAAADMAAeAAAAAAAAAIgAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"phoenicurus-phoenicurus":{"w":93,"h":92,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfgAAAAAAAAAAAAAf/gAAAAAAAAAAAAP//AAAAAAAAAAAAD//8AAAAAAAAAAAA///wAAAAAAAAAAAP///AAAAAAAAAAAB///8AAAAAAAAAAAf///wAAAAAAAAAAH////AAAAAAAAAAB////8AAAAAAAAAD/////gAAAAAAAAB/////+AAAAAAAAAB/////4AAAAAAAAAA/////AAAAAAAAAAH////8AAAAAAAAAAf////wAAAAAAAAAB/////AAAAAAAAAAP////+AAAAAAAAAB/////4AAAAAAAAAH/////wAAAAAAAAAf/////AAAAAAAAAD/////+AAAAAAAAAf/////4AAAAAAAAD//////gAAAAAAAAf/////+AAAAAAAAD//////4AAAAAAAA///////gAAAAAAAH//////8AAAAAAAA///////wAAAAAAAH///////AAAAAAAA///////8AAAAAAAH///////wAAAAAAA////////AAAAAAAH///////8AAAAAAAf///////wAAAAAAD///////+AAAAAAAf///////4AAAAAAB////////gAAAAAAP///////8AAAAAAB////////wAAAAAAH////////AAAAAAA////////4AAAAAAD////////gAAAAAAP///////+AAAAAAB////////wAAAAAAH////////AAAAAAAf///////4AAAAAAD////////AAAAAAAP///////8AAAAAAA////////gAAAAAAD///////+AAAAAAAH///////4AAAAAAAf///////gAAAAAAA///////+AAAAAAAD///////4AAAAAAAH///////gAAAAAAAP//////sAAAAAAAAf/////+wAAAAAAAAf//w//wAAAAAAAAAB/gB//AAAAAAAAAAO8AB/8AAAAAAAAADHAAD/wAAAAAAAAAwwAAf/AAAAAAAAAMMAAB/8AAAAAAAADDAAAH/wAAAAAAAAwwAAAf/AAAAAAAAMEAAAB/8AAAAAAADBgAAAH/wAAAAAAAwYAAAAf/AAAAAAAP+AAAAB/8AAAAAADxoAAAAH/wAAAAAAwYAAAAAf/AAAAAAOHHgAAAD/8AAAAAHx/6AAAAP/wAAAAB0cAAAAAA/+AAAAAOjgAAAAAD/4AAAABX4AAAAAAP/gAAAACfAAAAAAA/8AAAAAToAAAAAAD/gAAAACFAAAAAAAHIAAAAABMAAAAAAAAAAAAAAYwAAAAAAAAAAAAABAAAAAAAAAAAAAAAIAAAAAAAAAAAAAABAAAAAAAAAAAAAAAIAAAAAAAAAAAAAABAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"phylloscopus-collybita-2":{"w":93,"h":64,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAx4AAAAAAAAAAAAAD3wAAAAAAAAAAAAAP/gAAAAAAAAAAAAAf/AAAAAAAAAAAAA5/8AAAAAAAAAAAAD//4AAAAAAAAAAAAH//wAAAAAAAAAAAAP//gAAAAAAAAAAAc//+AAAAAAAAAAAB///+AAAAAAAAAAAD///4AAAAAAAAAAAH///wAAAAAAAAAAD////gAAAAAAAAAAP///+AAAAAAAAAAAf///4AD+AAAAAAAB////gB/8AAAAAAAP///+A//wAAAAAAAf///4P//AAAAAAAB////j//+AAAAAAAD///////8AAAAAAAP//////8AAAAAAAB///////AAAAAAAAH//////wAAAAAAAA//////8fAAAfAAAH///////////wAAA///////////wAAAD///////////8AAAf//////////+AAAD//////////8AAAAP//////////gAAAA///////////AAAAD/f////////AAAAAHn////////AAAAAAB///////58AAAAAAP///////gAAAAAAD///////GAAAAAAAf/////ucAAAAAAAH/////gAAAAAAAAA/////8AAAAAAAAAP////8AAAAAAAAAD////8AAAAAAAAAA///8AAAAAAAAAAAP//+AAAAAAAAAAAD//+AAAAAAAAAAAB/+xgAAAAAAAAAAAf/BjAAAAAAAAAAAH/wGDAAAAAAAAAAB/8A4OAAAAAAAAAA//ATGwAAAAAAAAAP/wEZGAAAAAAAAAD/8AHAwAAAAAAAAA//AAwOAAAAAAAAADnwAEBgAAAAAAAAAA8AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"phylloscopus-collybita":{"w":93,"h":78,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/gAAAAAAAAAAAAH//AAAAAAAAAAAAB//8AAAAAAAAAAAA///4AAAAAAAAAAAP///AAAAAAAAAAAD///8AAAAAAAAAAA////4AAAAAAAAAAP////wAAAAAAAAAB/////4AAAAAAAAAf/////AAAAAAAAAH////8AAAAAAAAAB/////AAAAAAAAAAf////wAAAAAAAAAP////8AAAAAAAAAH/////gAAAAAAAAB/////4AAAAAAAAA//////AAAAAAAAAP/////wAAAAAAAAD/////+AAAAAAAAA//////wAAAAAAAAP/////8AAAAAAAAD//////gAAAAAAAB//////8AAAAAAAAf//////gAAAAAAAP//////8AAAAAAAD///////gAAAAAAA///////8AAAAAAAP///////gAAAAAAD///////4AAAAAAA////////AAAAAAAP///////4AAAAAAD///////+AAAAAAAf///////wAAAAAAH///////+AAAAAAB////////gAAAAAAP///////4AAAAAAH////////AAAAAAB////////wAAAAAAP///////8AAAAAADP///////AAAAAAAD///////wAAAAAAB///////8AAAAAAAP///////AAAAAAAD///////wAAAAAAA///////8AAAAAAAP//////+AAAAAAAH///////AAAAAAAB//AP///wAAAAAAAf/AAP///+AAAAAAH+AAD//wD/AAAAAD/gAAfHAH/8AAAAA/4AABwAD4dgAAAAP+AAADAASB8AAAAD/gAAAcAAAHgAAAA/4AAABgAAA4AAAAP+AAAAGAAAGAAAAH/gAAAAYAADwAAAB/4AAAABgAACAAAAf+AAAAAEAAAAAAAD/gAAAAAwAAAAAAA/4AAAAADAAAAAAAH+AAAAAAcAAAAAAAdgAAAAD/4AAAAAADAAAAAA/vwAAAAAAAAAAAAAA7AAAAAAAAAAAAAAD4AAAAAAAAAAAAAAfAAAAAAAAAAAAAARwAAAAAAAAAAAAAD8AAAAAAAAAAAAAAfgAAAAAAAAAAAAAB4AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"phylloscopus-trochilus-2":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAHAAAAAAAAAAAAAA4eAAAAAAAAAAAAAD58AAAAAAAAAAAAAPvwAAAAAAAAAAAAA//gAAAAAAAAAAAA7/+AAAAAAAAAAAAD//8AAAAAAAAAAAAf//wAAAAAAAAAAAA///gAAAAAAAAAAAT//+AAAAAAAAAAAD///4AAAAAAAAAAAP///gAAAAAAAAAAA////AAAAAAAAAAAB///8AAAAAAAAAAA////wAAAAAAAAAAD////gAAAAAAAAAAP///+AAAAAAAAAAA////8AAAAAAAAAAH////wAAAAAAAAAAf////AAfgAAAAAAB////4Af/gAAAAAAH////gP/+AAAAAAAf///8D//4AAAAAAA////x////AAAAAAH////////4AAAAAAP///////wAAAAAAB///////8AAAAAAAf///////AAAAAAAB///////4AAAAAAAP//////+AAAAAAAB///////wAAAAAAAP//////8AAAAAAAB///////AAAAAAAAP//////wAAAAAAAA///////+AAAAAAAP///////8AAAAAAA////////wAAAAAAH////////gAAAAAA////////+AAAAAAD////////4AAAAAAP////////gAAAAAB////////+AAAAAAHz///////8AAAAAAA////////wAAAAAAH////////AAAAAAB////////8AAAAAAP////////wAAAAAB/////////AAAAAAP////////8AAAAAD/////////wAAAAAf/////////AAAAAH/////////+AAAAA//////////4AAAAP//////////gAAAB/////03///+AAAAf//PgAAf//94AAAH/8DcAADf//zgAAB//AXAAAD//vAAAAf/gAQAAAN/e8AAAH/4AAAAAAG9xwAAB/+AAAAAAAbnAAAAf/wAAAAAAAGMAAAH/8AAAAAAAAAAAAB//AAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH//AAAAAAAAAAAAA//wAAAAAAAAAAAAAP8AAAAAAAAAAAAAAfAAAAAAAAAAAAAAD4AAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"phylloscopus-trochilus":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/8AAAAAAAAAAAAf/+AAAAAAAAAAAH//8AAAAAAAAAA5///8AAAAAAAAAf////4AAAAAAAAAD////wAAAAAAAAAB////gAAAAAAAAAD///+AAAAAAAAAA////8AAAAAAAAAB////4AAAAAAAAf/////wAAAAAAAAB/////AAAAAAAAAD////+AAAAAAAAAP////4AAAAAAAAAf////wAAAAAAAAB/////gAAAAAAAAH/////gAAAAAAAAf/////AAAAAAAAB//////AAAAAAAAD/////+AAAAAAAAP/////8AAAAAAAA//////4AAAAAAAB//////4AAAAAAAH//////wAAAAAAAf//////gAAAAAAB//////+AAAAAAAH//////8AAAAAAAf//////4AAAAAAB///////wAAAAAAH///////gAAAAAAf///////AAAAAAA///////+AAAAAAD///////8AAAAAAP///////wAAAAAA////////gAAAAAD////////AAAAAAH///////+AAAAAAf///////4AAAAAB////////wAAAAAD////////AAAAAAP///////+AAAAAAf///////4AAAAAA////////wAAAAAD////////AAAAAAH///////+AAAAAAP///////4AAAAAA////////gAAAAAB///////+AAAAAAD///////4AAAAAAH///////wAAAAAAP///////AAAAAAAP//////+AAAAAAAP//////8AAAAAAAf//////4AAAAAAAf//////gAAAAAAA///////AAAAAAAA//////+AAAAAAAP/////44AAAAAAHwP////wwAAAAAB8AAB///gAAAAAAf4AAHH/+AAAAAAP5+AAYP/8AAAAAB/AeADAf/wAAAAAF4AIAYA//gAAAAAXAAADAB//AAAAAAcAAAcAD/8AAAAADwAABgAH/4AAAAAPAAAMAAf/gAAAAA2AABgAA//AAAAACAAAMAAD/+AAAAAEAABwAAH/4AAAAAQAAPvwAf/wAAAAAgAB/+gA//gAAAAAAAPAAAD/+AAAAAAAD8AAAH/8AAAAAAA7gAAAf/4AAAAAADKAAAA//gAAAAAARoAAAD//AAAAAABHgAAAH/8AAAAAAAUAAAAP/4AAAAAADYAAAA//wAAAAAANgAAAB//AAAAAAA0AAAAH/+AAAAAACIAAAAP/4AAAAAAIAAAAAf/gAAAAAAwAAAAB9/AAAAAABAAAAADh4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"pica-pica-2":{"w":89,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAx8EAAAAAAAAAAAHPh4AAAAAAAAAAAfifgAAAAAAAAAADcfcAAAAAAAAAAAfjhgAAAAAAAAAAB84EPgAAAAAAAAAH+A/+AAAAAAAAAA/5/BwAAAAAAAAAH/8AEAAAAAAAAAAf/gBgAAAAAP4AAB/////AAAAB/8AAf//AA8AAAB//8AB////3AAAAP//8AH//8AeAAAAf//8Af//34cAAAAB//+B///wPgAAAAA///gP//cGAAAAAA///4P//D4AAAAAA///4O/9zgAAAAAA///4M/88AAAAAAA///4I/+wAAAAAAB///4B//AAAAAAAD///4D/8AAAAAAADwf/wD/wAAAAAAAHAP/wP/gAAAAAAD/AP/wf/AAAAAAAP/AP/h/+AAAAAAA//AH/n/8AAAAAAB//AH/f/wAAAAAAH//AD///gAAAAAAf//gB///AAAAAAA//+AA//8AAAAAAD//gAB//wAAAAAAH//gA5//gAAAAAAf//gD7/+AAAAAAB///3///4AAAAAAD//////+AAAAAAAP//////8AAAAAAAf//////8AAAAAAB///////4AAAAAAD//3////4AAAAAAP//X////wAAAAAA/39X////gAAAAABqtS/////gAAAAAE9Sq/////AAAAAAVSlL///P/AAAAAAqlJX/wO//AAAAACpSSfQAff+AAAAAFSkk4AA0f+AAAAAUpJlgABY/+AAAAAqSROAAF4/+AAAAC0kiYAAbZ/8AAAAHJJkgABmD/8AAAAaiTOAACMD/8AAABpImcAAPMH/8AAAAWRNwAAbYH/8AAABsiaAAAwYP/4AAACzM4AABgAP/4AAAOmZwAADgAf/4AAAZUVAAADgAf/4AABlawAAADAAf/4AADO5gAAAAAA//wAAMZ2AAAAAAAf/wAABjMAAAAAAAf/gAADEAAAAAAAA//gAAMYAAAAAAAA//gAAAgAAAAAAAA//AAAAAAAAAAAAAv/AAAAAAAAAAAAAP/AAAAAAAAAAAAAf/AAAAAAAAAAAAAf+AAAAAAAAAAAAAf8AAAAAAAAAAAAA/4AAAAAAAAAAAAA/4AAAAAAAAAAAAATwAAAAAAAAAAAAAHwAAAAAAAAAAAAAHwAAAAAAAAAAAAAHgAAAAAAAAAAAAAHgAAAAAAAAAAAAAPgAAAAAAAAAAAAAPgAAAAAAAAAAAAAfAAAAAAAAAAAAAAfAAAAAAAAAAAAAAeAAAAAAAAAAAAAAeAAAAAAAAAAAAAA8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"pica-pica":{"w":60,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAB/wAAAAAAAH/4AAAAAAB//8AAAAAAH//+AAAAAAP///AAAAAAA///AAAAAAAP//gAAAAAAH//gAAAAAAD//wAAAAAAD//wAAAAAAD//8AAAAAAD//+AAAAAAD///AAAAAAH///gAAAAAH///wAAAAAH/h/4AAAAAH/A/8AAAAAH+Af+AAAAAH/gP+AAAAAH/wH/AAAAAH/4D/gAAAAH/+B/gAAAAH//A/wAAAAD9/gPwAAAAD9/8D4AAAAD8//x8AAAAB4f//+AAAABwf//+AAAAAwP///AAAAAAD///AAAAAAB///gAAAAAA///wAAAAAAP//wAAAAAAH//wAAAAAAB//4AAAAAAA//4AAAAAAAP/4AAAAAAAH/4AAAAAAAH/8AAAAAAAP/+AAAAAH4//+AAAAAP////AAAAAMfj//AAAAAIfh//gAAAAILAf3AAAAAAGAPxAAAAAAMAPwAAAAAAYAP4AAAAAAgAH4AAAAADAAH4AAAAAGAAH8AAAAAPwAH8AAAAAcYAD8AAAAAYIAD+AAAAAQAAD+AAAAAwAAD+AAAAAAAAB/AAAAAAAAB/AAAAAAAAB/AAAAAAAAB/gAAAAAAAA/gAAAAAAAA/gAAAAAAAA/wAAAAAAAA/wAAAAAAAAfwAAAAAAAAf4AAAAAAAAf4AAAAAAAAP4AAAAAAAAP8AAAAAAAAH8AAAAAAAAD8AAAAAAAAD+AAAAAAAAB+AAAAAAAAB+AAAAAAAAB/AAAAAAAAA/AAAAAAAAA/AAAAAAAAAfgAAAAAAAAHgAAAAAAAAHgAAAAAAAADwAAAAAAAADwAAAAAAAADwAAAAAAAAB4AAAAAAAAB4AAAAAAAAA4AAAAAAAAAcAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAA="},"picus-viridis-2":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAADGAAAAAAAAAAAAAZwAAAAAAAAAAAADPAAAAAAAAAAAAA94gCAAAAAAAAAAH/OAMAAAAAAAAAA/7wEYAAAAAAAAAH/+AdwAAAAAAAAA//xA7gAAAAAAAAH/+YB/gAAAAAAAA///A3/AAAAAAAAH//8Bv+AAAAAAAA///gDf+AAAAAAAH//5AP/8AAAAAAA///8Af/4AAAAAAH///gA//wAAAAAA///8AN//wAAAAAH///gAf//gAAAAA///8AA///AAAAAH///8AB//+AAAAA////gAB//8AAAAH///8AAf//8AAAA////gAA///4AAAH///+AAB///4AAA////4AAB///4AAH///+AAAH///wAA////4AAAf///4AH////AAAA////4Af///4AAAA////4B////AAAAD////4H///4AAAAH////g///+AAAAAH///8D///wAAAAAP///4P///AAAAAAf///////4AAAAAAD///////wAAAAAAf///////AAAAAAA///////8AAAAAAD///////wAAAAAAP///////AAAAAAAf//////8AAAAAAB///////wAAAAAAH///////AAAAAAAP//////8AAAAAAA///////gAAAAAAB//////+AAAAAAAD//////4AAAAAAAP//////gAAAAAAAP/////4AAAAAAAAf/////gAAAAAAAAf////4AAAAAAAAA////+AAAAAAAAAAP///wAAAAAAAAAAf///gAAAAAAAAAA///+AAAAAAAAAAB///4AAAAAAAAAAD///wAAAAAAAAAAP///AAAAAAAAAAAf//8AAAAAAAAAAI///wAAAAAAAAAB////gAAAAAAAAAP///+AAAAAAAAAAyf//4AAAAAAAAADnt//gAAAAAAAAAOOZ//AAAAAAAAAAY4j/8AAAAAAAAAABgP/wAAAAAAAAAABA//AAAAAAAAAAAAD/8AAAAAAAAAAAAP/wAAAAAAAAAAAA//AAAAAAAAAAAAD/8AAAAAAAAAAAAP/4AAAAAAAAAAAAf/gAAAAAAAAAAAB//AAAAAAAAAAAAB/8AAAAAAAAAAAAH/wAAAAAAAAAAAAH/gAAAAAAAAAAAAf+AAAAAAAAAAAAA/8AAAAAAAAAAAAAdwAAAAAAAAAAAAB3AAAAAAAAAAAAAHOAAAAAAAAAAAAAMYAAAAAAAAAAAAAwwAAAAAAAAAAAABjAAAAAAAAAAAAACGAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"picus-viridis":{"w":55,"h":93,"bits":"AAAAAAAAAAAAAAAAAABgAAAAAAAA/AAAAAAAAH4AAAAAAAA/38AAAAAAP//wAAAAAB//+AAAAAAf//gAAAAAP//4AAAAAD//8AAAAAA///AAAAAAP//gAAAAAD//wAAAAAA//8AAAAAAf/+AAAAAAP//AAAAAAD//gAAAAAB//gAAAAAA//4AAAAAAf/8AAAAAAf//AAAAAAP//gAAAAAP//8AAAAAH///AAAAAH///wAAAAD///8AAAAD////AAAAB////wAAAA////4AAAAf///+AAAAP////gAAAH////wAAAD////8AAAB////+AAAAf////AAAAP////wAAAH////4AAAB////8AAAA/////AAAAP////gAAAH////wAAAB////8AAAA////+AAAAP////gAAAD////wAAAA////4AAAAP///+AAAAH////AAAAB////gAADgf///wAAP+P///8AAP/////+AAAA/////AAAAO////gAAAHv///wAAABz///4AAAA4///+AAAAIO///AAAAEAH//gAAAAAA//4AAAAAAP/8AAAAAAH/7AAAAAAB/9gAAAAAA//QAAAAAAf/kAAAAAAP+YAAAAAAH/kAAAAAAD/gAAAAAAB/wAAAAAAA/4AAAAAAAf8AAAAAAAP+AAAAAAAH/AAAAAAAD/gAAAAAAB/4AAAAAAAf8AAAAAAAP+AAAAAAAH/AAAAAAAB/gAAAAAAAfwAAAAAAAH8AAAAAAAD+AAAAAAAAdAAAAAAAAGQAAAAAAABIAAAAAAAAiAAAAAAAAJAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"pluvialis-apricaria-2":{"w":93,"h":90,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAAAAAABgAAAAAAAAAAAAAAPAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAPAAAAAAAAAAAB4AB+AAAAAAAAAAB8AAPwAAAAAAAAAA/gAB/gAAAAAAAAA/8AAP+AAAAAAAAAf+AAB/wAAAAAAAAP/gAAP+AAAAAAAAP/8AAB/8AAAAAAAH//AAAP/wAAAAAAD//wAAB/+AAAAAAB//8AAAP/4AAAAAA///AAAB//gAAAAAP//4AAAP/8AAAAAH//+AAAB//gAAAAD///AAAAP/+AAAAA///4AAAB//4AAAA///+AAAAP//AAAAP///gAAAB//4AAAH///4AAAAH//gAAB///+AAAAA//8AAA////gAAAAH//gAAP///4AAAAAf/+AAH///+AAAAAD//4AB////gAAAAAf//wA////4AAAAAD///AP///+AAAAAAf//8D////gAAAAAD///wf///4AAAAAAP///H///8AAAAAAB////////AAAAAAAH///////gAAAAAAAP//////wAAAAAAAAf/////+AAAAAAAAB//////wAAAAAAAAD/////+AAAAAAAAAP/////wAAAAAAA/A/////+AAAAAAAf+H/////wAAAAAAH/8/////+AAAAAAB////////wAAAAAAf///////+AAAAAAD////////wAAAAAAf///////8AAAAAAP////////gAAAAAH////////8AAAAAA/////////AAAAAAAH///////4AAAAAAAf///////AAAAAAAA///////4AAAAAAAD///////AAAAAAAAP//////wAAAAAAAB///////AAAAAAAAH//////8AAAAAAAA///////4AAAAAAAD///////wAAAAAAAP///////AAAAAAAB///////+AAAAAAAH///////4AAAAAAAf///////wAAAAAAB////////gAAAAAAD////////gAAAAAAH////////wAAAAAAP////////wAAAAAAf////////gAAAAAA////////4AAAAAAB////////AAAAAAAB////8ABwAAAAAAAA///+AAAAAAAAAAAAB//4AAAAAAAAAAAAAHjgAAAAAAAAAAAAAMMAAAAAAAAAAAAAAwwAAAAAAAAAAAAADDAAAAAAAAAAAAAAIMAAAAAAAAAAAAAAgwAAAAAAAAAAAAADzwAAAAAAAAAAAAAePAAAAAAAAAAAAAB8/AAAAAAAAAAAAAD4+AAAAAAAAAAAAAHx8AAAAAAAAAAAAAPzwAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"pluvialis-apricaria":{"w":85,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAAAAAAAAAAAAB/4AAAAAAAAAAAD/+AAAAAAAAAAAD//gAAAAAAAAAAB//4AAAAAAAAAAB//+AAAAAAAAAAA///AAAAAAAAAAAf//wAAAAAAAAAAf//4AAAAAAAAAAf//8AAAAAAAAAA////AAAAAAAAAB////gAAAAAAAAD4///wAAAAAAAAAAP//8AAAAAAAAAAD///AAAAAAAAAAA///wAAAAAAAAAAf///AAAAAAAAAAP///4AAAAAAAAAH////AAAAAAAAAD////4AAAAAAAAD/////AAAAAAAAB/////4AAAAAAAA/////+AAAAAAAAf/////wAAAAAAAf/////8AAAAAAAP//////AAAAAAAH//////wAAAAAAD//////8AAAAAAB///////AAAAAAA///////wAAAAAAf//////8AAAAAAP///////AAAAAAD///////wAAAAAB///////4AAAAAA///////+AAAAAAf///////gAAAAAH///////4AAAAAD///////+AAAAAA////////gAAAAAf///////4AAAAAH///////+AAAAAB////////wAAAAA////////8AAAAAP////////AAAAAD////////4AAAAA/////////AAAAAP///g////4AAAAB//8AD////gAAAAf/4AAH///8AAAAH/wAAAP//zAAAAA/gAAAA//8AAAAAHgAABj///gAAAAAwAABhx/+QAAAAACAAHIAB/gAAAAAAYA+4AAP4AAAAAAHA/gAAB/AAAAAABwwAAAAPwAAAAAAcYAAAAB8AAAAAAHIAAAAAAAAAAAAD0AAAAAAAAAAAAB+AAAAAAAAAAAAA7AAAAAAAAAAAAAZwAAAAAAAAAAAAM4AAAAAAAAAAAAGYAAAAAAAAAAAADMAAAAAAAAAAAABGAAAAAAAAAAAAAjAAAAAAAAAAAAAxAAAAAAAAAAAAAYgAAAAAAAAAAAAMwAAAAAAAAAAAAGYAAAAAAAAAAAACMAAAAAAAAAAAADGAAAAAAAAAAAABiAAAAAAAAAAAAAzAAAAAAAAAAAAAdgAAAAAAAAAABx/wAAAAAAAAAAAf84AAAAAAAAAAP/8eAAAAAAAAAAH54e4AAAAAAAAAABz+AAAAAAAAAAAHD+AAAAAAAAAAAADiAAAAAAAAAAAA+CAAAAAAAAAAAB4CAAAAAAAAAAAAAGAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"pluvialis-squatarola-2":{"w":83,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAoAAAAAAAAAAAACwAAAAAAAAAAAAPAAAAAAAAAAAAAfAAAAAAAAAAAAB+AAAAAAAAAAAAH4AAAAAAAAAAAAP4AAAAAAAAAAAA/wAAAAAAAAAAAB/gAAAAAD4AAAAH+AAAAAA/AAAAAf+AAAAAP/AAAAA/8AAAAD/8AAAAD/4AAAAf/gAAAAH/wAAAH/8AAAAAf/gAAA//4AAAAA//AAAH//wAAAAD/+AAAf/+AAAAAH/8AAD//4AAAAAP/4AAf//gAAAAA//wAD///AAAAAB//gAf//4AAAAAH//AB///gAAAAAP/+AH//+AAAAAA//4A///4AAAAAB//wD///gAAAAAD//gf///AAAAAAP//h///4AAAAAAf//H///gAAAAAA//+f//+AAAAAAB//////4AAAAAAD//////gAAAAAAH/////8AAAAAAAP/////gAAAAAAAf/////gAAAAAAAf/////AAAAAAAAf////+AAAAAAAAf////8AAAAAAAAf////4AAAAAAAAf////wAAAAAA/A/////gAAAAAH/g/////AAAAAAf/x////8AAAAAA//z////4AAAAAD///////wAAAAAD///////gAAAAAP///////AAAAAB///////8AAAAAP///////4AAAAA8///////wAAAAAAf//////gAAAAAAP//////AAAAAAAP/////+AAAAAAAP/////+AAAAAAAP/////+AAAAAAAf//////AAAAAAAf//////gAAAAAA///////wAAAAAA///////4AAAAAA////////AAAAAA////////8AAAAA/////////wAAAAf////+f//gAAAAP////4P/+AAAAAH////wP/8AAAAAD/////+f8AAAAAA////gAB8AAAAAAH//4AAAAAAAAAAAB/4AAAAAAAAAAAA/4AAAAAAAAAAAAH8AAAAAAAAAAAAD8AAAAAAAAAAAADsAAAAAAAAAAAADIAAAAAAAAAAAADYAAAAAAAAAAAADYAAAAAAAAAAAACYAAAAAAAAAAAAGYAAAAAAAAAAAAGQAAAAAAAAAAAAGQAAAAAAAAAAAAEeAAAAAAAAAAAAO+AAAAAAAAAAAAP8AAAAAAAAAAAAOeAAAAAAAAAAAAPPAAAAAAAAAAAAHngAAAAAAAAAAADhgAAAAAAAAAAABwAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"pluvialis-squatarola":{"w":93,"h":88,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/wAAAAAAAAAAAAAf/gAAAAAAAAAAAAH/+AAAAAAAAAAAAB//4AAAAAAAAAAAAP//gAAAAAAAAAAAB//+AAAAAAAAAAAAf//wAAAAAAAAAAAD//+AAAAAAAAAAAA///4AAAAAAAAAAAf///AAAAAAAAAAAP///+AAAAAAAAAAH5////wAAAAAAAAAwH////8AAAAAAAAAAf////8AAAAAAAAAB/////8AAAAAAAAAH/////4AAAAAAAAA//////wAAAAAAAAH//////gAAAAAAAA///////AAAAAAAAH//////8AAAAAAAA///////4AAAAAAAH///////gAAAAAAA////////AAAAAAAH///////8AAAAAAA////////wAAAAAAH////////gAAAAAA/////////AAAAAAH////////+AAAAAAf////////+AAAAAD/////////8AAAAAP/////////8AAAAB//////////4AAAAH//////////+AAAA///////////8AAAD//////////8AAAAP/////////4AAAAA//////////AAAAAD//////////AAAAAP//////////AAAAAf/////////+AAAAB//////////4AAAAD//////gB//AAAAAP/////gAD/4AAAAAf///+AAAD+AAAAAA///+AAAABgAAAAAB///gAAAAAAAAAAAD//wAAAAAAAAAAAAP/wAAAAAAAAAAAAA/wAAAAAAAAAAAAAD+AAAAAAAAAAAAAAPgAAAAAAAAAAAAAAmAAAAAAAAAAAAAAG4AAAAAAAAAAAAAAzAAAAAAAAAAAAAAGYAAAAAAAAAAAAAAzAAAAAAAAAAAAAAGYAAAAAAAAAAAAAAzAAAAAAAAAAAAAAGYAAAAAAAAAAAAAAyAAAAAAAAAAAAAAGQAAAAAAAAAAAAAAyAAAAAAAAAAAAAAGwAAAAAAAAAAAAAAmAAAAAAAAAAAAAAEwAAAAAAAAAAAAAAmAAAAAAAAAAAAAAEwAAAAAAAAAAAAAAkAAAAAAAAAAAAAAEgAAAAAAAAAAAAABkAAAAAAAAAAAAAANgAAAAAAAAAAAAAB/AAAAAAAAAAAAA//sAAAAAAAAAAAABP8AAAAAAAAAAAAAD/gAAAAAAAAAAAAB5sAAAAAAAAAAAAA8ZgAAAAAAAAAAAAMGEAAAAAAAAAAAAABhgAAAAAAAAAAAAAYMAAAAAAAAAAAAAEBAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"podiceps-cristatus-2":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASAAAAAAAAAAAAAADYAAAAAAAAAAAAAAfYAAAAAAAAgAAAAD/AAAAAAAAMAAAAAf6AAAAAAAHAAAAAD/4AAAAAADzAAAAAf/QAAAAAB/4AAAAB/+AAAAAA/+AAAAAP/4AAAAAf/gAAAAB//AAAAAP//AAAAAP/8AAAAH//wAAAAB//wAAAB//8AAAAAP/+AAAA///wAAAAB//wAAAf//8AAAAAP//AAAH///AAAAAB//4AAD///wAAAAAP//AAA///+AAAAAB//8AAf///wAAAAAP//gAH///8AAAAAB//4AD////AAAAAAP//AA////4AAAAAB//4Af///+AAAAAAP//AH////gAAAAB5//4B////4AAAAA/v//wf///+AAAAAf8///H////AAAAAf/H//8////wAAAAP/4///n///8AAAAD//z//////+AAAAA///P//////AAAAAP//4//////AAAAAD///j/////8AAAAD///8P/////AAAAB////g/////4AAAA/AD/8H/////AAAAEAAf/g/////4AAAAAAB/8H/////AAAAAAAH/g/////4AAAAAAAH8H////+AAAAAAAA/h/////wAAAAAAAP8/////+AAAAAAAB///////gAAAAAAAf//////8AAAAAAAD///////gAAAAAAAf//////4AAAAAAAD//////+AAAAAAAAf//////gAAAAAAAD//////8AAAAAAAAf//////wAAAAAAAB//////+AAAAAAAAH//////wAAAAAAAA//////4AAAAAAAAD//////AAAAAAAAAP/////+AAAAAAAAAf/////4AAAAAAAAAf/////AAAAAAAAAA/////8AAAAAAAAAB/////wAAAAAAAAAD/////AAAAAAAAAAH////8AAAAAAAAAAP/////gAAAAAAAAA/////4AAAAAAAAAB/////gAAAAAAAAAD////4AAAAAAAAAAD////AAAAAAAAAAAA///4AAAAAAAAAAAAP/+AAAAAAAAAAAAA/7AAAAAAAAAAAAAH/AAAAAAAAAAAAAAf/wAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAA//AAAAAAAAAAAAAB//wAAAAAAAAAAAAH/+AAAAAAAAAAAAAP/4AAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"podiceps-cristatus":{"w":82,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAHmAAAAAAAAAAAB/wAAAAAAAAAAAP/8AAAAAAAAAAD//AAAAAAAAAAAf//AAAAAAAAAAH//4AAAAAAAAAB//+AAAAAAAAAAP//gAAAAAAAAAB///AAAAAAAAAAH//+AAAAAAAAAA///8AAAAAAAAAD///4AAAAAAAAAf///gAAAAAAAAB////AAAAAAAAAP///8AAAAAAAAB////4AAAAAAAAP////gAAAAAAAD////+AAAAAAAAf9///4AAAAAAAD+D///gAAAAAAA/AP//+AAAAAAAHwA///wAAAAAAA8AD///AAAAAAAHAAP//4AAAAAAAAAA///gAAAAAAAAAB//4AAAAAAAAAAGf/AAAAAAAAAAAB/wAAAAAAAAAAAH/AAAAAAAAAAAAf8AAAAAAAAAAAB/wAAAAAAAAAAAH/AAAAAAAAAAAAP8AAAAAAAAAAAA/wAAAAAAAAAAAD/AAAAAAAAAA/AP8AAAAAAAAH//5/wAAAAAAAH/////AAAAAAAB/////8AAAAAAAf/////wAAAAAAH//////AAAAAAB//////8AAAAAAf//////gAAAAAH//////+AAAAAA///////8AAAAAH///////4AAAAA////////AAAAAP///////4AAAAB////////gAAAAP///////8AAAAB////////wAAAAP///////+AAAAB////////wAAAAP///////+AAAAB////////wAAAAP///////8AAAAD////////AAAAAf///////4AAIAH////////AAAAA3///////4AAEAA///////8AAAgAP///////AAAEAB///////4AAAAAOf/////8AAAAAAB/////8AAAAAAAf/////AAAAQAAD/////gAAAEAAA/////8AAAAAAAD/////gAAAfAAAf////wAAAf/gAB////8AAAP//AAH/f//3/gAj//AAPwf////wCH/+AAAAJ////4Af/8AAAAH/B//4A/+QAAAAHgNf/4D/wAAAAAAAA//gP/AAAAAAAAB/4A48AAAAAAAAD/gBBwAAAAAAAAH+AEBAAAAAAAAAf8AACAAAAAAAAB/4AAAAAAAAAAAD7gAAAAAAAAAAAOCAAAAAAAAAAAAIIAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"podiceps-nigricollis-2":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAAEgAAAAAAAAAAAAAAoAAAAAAAAAAAAAAFQAAAAAAAAAAAAAB+AAAAAAAAAAAAAAPwAAAAAAAAAAAAAD9AAAAAAAAAAAAAAf4AAAAAAAAAAAAAD/AAAAAAAAAAAAAA/8AAAAAAAAAAAAAH/gAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/gAAAAABAAAAAAB/+AAAAAAwAAAAAAf/gAAAAAcwAAAAAD/8AAAAAP4AAAAAAf/gAAAAH+AAAAAAH/+AAAAD/8AAAAAA//gAAAB//AAAAAAH/8AAAA//wAAAAAB//gAAAP//AAAAAAP/8AAAH//wAAAAAB//gAAD//4AAAAAAP/8AAB//+AAAAAAD//AAAf//wAAAAAAf/4AAP//8AAAAAAH//AAH///AAAAAAA//4AB///wAAAAAAH/+AA///+AAAAAAA//wAf///gAAAAAAP/8AH///wAAAAAAB//wD///8AAAAAAAP//A////AAAAAAAB//4P///4AAAAAAAP//j///8AAAAAAAB//+///+AAAAAAAAP//////gAAAAAAAB//////wAAAAAAAAH/////4AAAAAA/Pgf////8AAAAAA///h/////gAAAAAf//4H////+AAAAAH///g/////wAAAAB///8H////+AAAAB///+A/////wAAAD////wH////+AAAAf////A/////wAAAAAP//8P////+AAAAAAP////////gAAAAAAD///////8AAAAAAAD///////gAAAAAAAP//////8AAAAAAAB///////AAAAAAAAH//////4AAAAAAAA///////AAAAAAAAD//////4AAAAAAAAf//////gAAAAAAAB//////4AAAAAAAAH//////AAAAAAAAAf/////+AAAAAAAAB//////4AAAAAAAAB//////gAAAAAAAAD/////+AAAAAAAAAH/////4AAAAAAAAAP/////AAAAAAAAAA/////+AAAAAAAAAB/////8AAAAAAAAAD/////8AAAAAAAAAH/////wAAAAAAAAAP/////AAAAAAAAAAf////4AAAAAAAAAAf///+AAAAAAAAAAAH///wAAAAAAAAAAAAP/4AAAAAAAAAAAAA//AAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAAf/gAAAAAAAAAAAAAf/AAAAAAAAAAAAAA/+AAAAAAAAAAAAAAAAA"},"podiceps-nigricollis":{"w":93,"h":92,"bits":"AAAAAAAAAAAAAAAAAAA/4AAAAAAAAAAAAA//8AAAAAAAAAAAAP//8AAAAAAAAAAAH///8AAAAAAAAAAB////wAAAAAAAAAAP///+AAAAAAAAAAD////wAAAAAAAAAAf///+AAAAAAAAAAH////+AAAAAAAAAA////+IAAAAAAAAAf////4AAAAAAAAAH/////gAAAAAAAAD/////2AAAAAAAAD/////+IAAAAAAAA//////8AAAAAAAAfwA////wAAAAAAADwAA///5AAAAAAAAAAAD///gAAAAAAAAAAAP//+AAAAAAAAAAAD///AAAAAAAAAAAA///0AAAAAAAAAAAf///QAAAAAAAAAAH///4AAAAAAAAAAB////uAAAAAAAAAAf/////8AAAAAAAAD//////8AAAAAAAA///////8AAAAAAAP///////4AAAAAAB////////gAAAAAAP////////AAAAAAD////////8AAAAAAf////////4AAAAAD/////////gAAAAAf////////+AAAAAD/////////4AAAAAf/////////gAAAAD//////////AAAAAf/////////8AAAAD//////////wAAAAf//////////AAAAB//////////4AAAAP//////////gAAAA//////////8AAAAH//////////wAAAAf//////////AAAAD//////////8AAAAP//////////gAAAA//////////+AAAAD//////////wAAAAP//////////AAAAA//////////8AAAAB//////////gAAAAH/////////+AAAAAP/////////4AAAAA//////////gAAAAB/////////8AAAAAD/////////wAAAAAH/////////AAAAAAP///////84AAAAAD////////zgAAAAA////////+MAAAAAf////////8wAAAAD/////////wAAAAAD/////////AAAAAAf7///////8AAAAAD+P///////gAAAAAfwH//////+AAAAAD8AP//////wAAAAAwwA//////+AAAAACCAB//////wAAAAAQAAD/////+AAAAAAAAAD//+A/wAAAAAAAAAA/gAAAAAAAAAAAAAD8AAAAAAAAAAAAAB/AAAAAAAAAAAAAA/AAAAAAAAAAAB8A/gAAAAAAAAAAAH/P4AAAAAAAAAAAAf/+AAAAAAAAAAAAH//8AAAAAAAAAAAA//+gAAAAAAAAAAAP/8AAAAAAAAAAAAH//AAAAAAAAAAAAB//wAAAAAAAAAAAAQ/8AAAAAAAAAAAAAB/AAAAAAAAAAAAAAPwAAAAAAAAAAAAAA8AAAAAAAAAAAAAAGAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAA="},"poecile-palustris-2":{"w":93,"h":79,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAAAgAAAAAAABgQAAAGGAAAAAAAA4OAAAA4wAAAAAAAPHgAAAHHMAAAAAAHz4AAAA85gAAAAAB8+CAAAHnOAAAAAAf/jgAAA+9yAAAAAP/54AAAH3+QAAAAD//+AAAA//3AAAAA///gAAAH//7AAAAf//4QAAA///4AAAH//+eAAAH///AAAB////gAAA///4AAAf///4AAAH///wAAH///8AAAA///+AAB////AAAAH///wAAf///xAAAA///+AAH////4AAAH///8AB////+AAAAf///gAf////gAAAD///4AH////wAAAAf///AB////8AAAAD///+A/////AAAAAf///8P////+AAAAB////7/////gAAAAP/////////wAAAAA/////////4AAAAAH/////////AAAAAA/////////4AAAAAH////////+AAAAAA/////////AAAAAAH////////wAAAAAAf///////8AAAAAAD////////AAAAAAAP///////4AAAAAAB////////gAAAAAAf///////8AAAAAAH////////gAAAAAB////////8AAAAAAf////////gAAAAAD////////+AAAAAA/////////wAAAAAH////////+AAAAAA/////////wAAAAAP////////+AAAAAB/////////wAAAAAP////////+AAAAAB/////////gAAAAAf////////8AAAAAH/////////gAAAAA/////////4AAAAAOP///////+AAAAAAAP///////wAAAAAAAf///////AAAAAAAB///////+AAAAAAAH///////+AAAAAAAf///////+AAAAAAB////////+AAAAAAH////////8AAAAAAf////////8AAAAAB/////////8AAAAAH//////n//8AAAAAP/////Af//4AAAAAf///8AA///4AAAAAP///gAB///wAAAAA///4AAH///gAAAAO/+GAAAP//wAAAABx8YAAAAf/4AAAAAOHhgAAAA//AAAAAA44MAAAAD/4AAAAADjgAAAAAH8AAAAAAMOAAAAAAMAAAAAAAwwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"poecile-palustris":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAHgAAAAAAAAAAAAAB9wAAAAAAAAAAAAA//AAAAAAAAAAAAAP/4AAAAAAAAAAAAD//AAAAAAAAAAAAA//wAAAAAAAAAAAAP/8AAAAAAAAAAAAD//AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+AAAAAAAAAAAAB//AAAAB/wAAAAAAf/wAAAA//wAAAAAH/8AAAAf//wAAAAB/+AAAAH///gAAAAf/gAAAD/////gdv//wAAAAf/////////8AAAAH//////////AAAAB//////////gAAAAP/////////4AAAAD//////////AAAAAf/////////4AAAAP/////////+AAAAD//////////wAAAA//////////8AAAAD//////////wAAAAB//////////wAAAAH//////////wAAAAf//////////AAAAB//////////wAAAAH/////////AAAAAA////////+AAAAAAD////////wAAAAAAf///////8AAAAAAD////////gAAAAAAP///////4AAAAAAB///////+AAAAAAAP///////wAAAAAAA///////+AAAAAAAD///////gAAAAAAAf//////8AAAAAAAB///////AAAAAAAAH//////wAAAAAAAAP/////8AAAAAAAAA//////AAAAAAAAAB/////wAAAAAAAAAD////8AAAAAAAAAAH////gAAAAAAAAAAH///4AAAAAAAAAAA4/weAAAAAAAAAAAeIAGAAAAAAAAAAAP/wBwAAAAAAAAAAPwIAMAAAAAAAAAAD8AADAAAAAAAAAAAnAAAwAAAAAAAAAAAwAAMAAAAAAAAAAAPAADHwAAAAAAAAABwAA/5AAAAAAAAAAKAAPgAAAAAAAAAABMAHgAAAAAAAAAAAIAD8AAAAAAAAAAAAAAzgAAAAAAAAAAAAAE4AAAAAAAAAAAAAAvAAAAAAAAAAAAAABYAAAAAAAAAAAAAAbAAAAAAAAAAAAAADYAAAAAAAAAAAAAARgAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"prunella-modularis-2":{"w":93,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAZgAAAAAAAAAAAAAGYAAAAAAAAAAAAABnAAAAAAAAAAAAAAdxAAAAAAAAAAAAAHcQAAAAAAAAAAAAB/uAAAAAAAAAAAAAf7gAAAAAAAAAAAAH/4AAAAAAAAAAAAB//AAAAAAAAAAAAAf/yAAAAAAAAAAAAH/9wAAAAAAAAAAAB//8AAAAAAAAAAAAf//gAAAAAAAAAAAD//4AAAAAAAAAAAA//+AAAAAAAAAAAAP//gAAAAAAAAAAAD///AAAAAAAAAAAAf//wAAAAAAAAAAAH//+AAAAAAAAAAAB///gAAAAAAAAAAAf//4AAAAAAAAAAAH//+AAAAAAAAAAAB///4AAAAAAAAAAAP///AAAAAAAAAAAD///wAAAAAAAAAAA///8AAAAAAAAAAAH///gAAAAAAAAAAB///4AAAAAAAAAAAf///AAAAAAAAAAAD///wAAAAAAAAAAA///8AAAAAAAAAAAP///AAAAAAAAAAAB///4AAAAAAAAAAAP///AAAAAAAAAAAD///4AAAAAAAAAAAf///gAAAAAAAAAAD///8AAAAAAAAD4A////gAAAAAAAD/8f///+AAAAAAAB///////wAAAAAAAf//////+AAAAAAAH///////wAAAAAAA///////+AAAAAAAf///////wAAAAAAP///////+AAAAAAB////////wAAAAAAAf//////+AAAAAAAB///////wAAAAAAAH//////+AAAAAAAAf//////wAAAAAAAB//////8AAAAAAAAD/////3gAAAAAAAAP/////AAAAAAAAAA/////8AAAAAAAAAH/////wAAAAAAAAD/////+AAAAAAAAA//////8AAAAAAAAf//////wAAAAAAAH//////+AAAAAAAB///////4AAAAAAAf///////gAAAAAAD////////AAAAAAA////////+AAAAAAf////////4AAAAAH/////////wAAAAA//////////gAAAAP//////A///AAAAD/////+AD//+AAAA/////++AP//8AAAP////8zgA///4AAD////+DkAD///gAA////mAOAAP//4AAP///AAAAAA//+AAD///4AAAAAD//AAB///+AAAAAAP+AAAf///AAAAAAB/wAAH///4AAAAAAH8AAB///2AAAAAAAfgAAf//8gAAAAAAB4AAPff7gAAAAAAAHAADz3uYAAAAAAAAAAA455yAAAAAAAAAAAAOOcAAAAAAAAAAAADjzAAAAAAAAAAAAAwYwAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"prunella-modularis":{"w":93,"h":66,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAAAAAAAAAAAAAAPwAAA/wAAAAAAAAH8AAA//wAAAAAAAD//AAP//gAAAAAAA//8AD///AAAAAAAf//AB///8AAAAAAP//wA////4AAAAAD//4Af//////gAAB//8AH////////+A//+AAP////////////AAAP///////////gAAB///////////wAAAH//////////4AAAA//////////8AAAAH/////////8AAAAAf/////////AAAAAD/////////iAAAAAf////////8AAAAAD/////////wAAAAAP/////////wAAAAB//////////wAAAAP//////////AAAAB//////////4AAAAH/////////AAAAAA////////+AAAAAAH////////gAAAAAAf///////4AAAAAAD///////+AAAAAAAP///////wAAAAAAB///////8AAAAAAAH///////AAAAAAAAf//////wAAAAAAAB//////8AAAAAAAAH//////AAAAAAAAAP/////wAAAAAAAAA/////4AAAAAAAAAB////+AAAAAAAAAAD////wAAAAAAAAAAD///+AAAAAAAAAAAH/8HgAAAAAAAAAAD/wAwAAAAAAAAAAA/4AMAAAAAAAAAAA/AADAAAAAAAAAAAFwAAwAAAAAAAAAABOAAcAAAAAAAAAAADgAGAAAAAAAAAAAAWAB30AAAAAAAAAACQAf8AAAAAAAAAAAQAfAAAAAAAAAAAACAP4AAAAAAAAAAAAQCOAAAAAAAAAAAAAABQAAAAAAAAAAAAAAeAAAAAAAAAAAAAACwAAAAAAAAAAAAAA2AAAAAAAAAAAAAAGQAAAAAAAAAAAAAAhAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"pyrrhula-pyrrhula-2":{"w":93,"h":45,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAH+AAAAAAAAAAAAAD/8AAAAAAAAAAAAA//wAAAAAAAAAAAAP//AAAAAAAAAAAAD//8AAAAAAAAAAAAf//4fwAAAAAAAAH//////4AAAAAAB////////8AAAAAH/////////4AAAAH//////////4AAAH///////////4AAH////////////wAA/////////////gAB/////////////AAN////////////+AAP////////////4AAAP///////////wAAAA///////4f//AAAAAP/////+ADvwAAAAAP/////AAAAAAAAAA/////gAAAAAAAAAAf///+AAAAAAAAAAAD///4AAAAAAAAAAAH///AAAAAAAAAAAAf//+AAAAAAAAAAAB///4AAAAAAAAAAAe5//gAAAAAAAAAADWgf/AAAAAAAAAAAYyB/8AAAAAAAAAABCAH/4AAAAAAAAAAAIAf/wAAAAAAAAAAAAD//gAAAAAAAAAAAAP//AAAAAAAAAAAAA//8AAAAAAAAAAAAH//wAAAAAAAAAAAAf34AAAAAAAAAAAAB8AAAAAAAAAAAAAAPgAAAAAAAAAAAAAA4AAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"pyrrhula-pyrrhula":{"w":93,"h":92,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAA//AAAAAAAAAAAAAf/+AAAAAAAAAAAAP//4AAAAAAAAAAAH///wAAAAAAAAAAB////gAAAAAAAAAAf///+AAAAAAAAAAH////4AAAAAAAAAB/////gAAAAAAAAAP////4AAAAAAAAAD////8AAAAAAAAAA////+AAAAAAAAAAP////gAAAAAAAAAB////8AAAAAAAAAAf////gAAAAAAAAAD////8AAAAAAAAAA/////gAAAAAAAAAP////8AAAAAAAAAD/////gAAAAAAAAA/////8AAAAAAAAAP/////gAAAAAAAAD/////+AAAAAAAAA//////wAAAAAAAAP/////+AAAAAAAAD//////wAAAAAAAA//////+AAAAAAAAP//////wAAAAAAAD//////+AAAAAAAA///////wAAAAAAAH//////+AAAAAAAB///////wAAAAAAAf//////+AAAAAAAH///////wAAAAAAB///////+AAAAAAAP///////gAAAAAAD///////8AAAAAAB////////gAAAAAAf///////4AAAAAAH////////AAAAAAB////////wAAAAAAP///////+AAAAAAD////////gAAAAAA////////8AAAAAAH////////AAAAAAB////////wAAAAAAf///////8AAAAAAH////////AAAAAAA////////4AAAAAAP///////+AAAAAAB////////gAAAAAAP///////4AAAAAAB///////8AAAAAAAf///////AAAAAAAH///////wAAAAAAB///////4AAAAAAAf//////+AAAAAAAH///////AAAAAAAB///////gAAAAAAAf//////4AAAAAAAHv/////7/AAAAAAB5/////8H/AAAAAAMf/4D/wPnsAAAAADD/8AP8CgWAAAAAAg/+ABxwQDYAAAAAAP/gAADgALAAAAAAD44AAAPABoAAAAAA/eAAAAcAZAAAAAAP/gAAAP/AIAAAAAD/4AAAf38DAAAAAAf/AAAHgcQAAAAAAH/wAAAgByAAAAAAB/8AAAEAPAAAAAAAf/AAAAAB4AAAAAAH/wAAAAAPAAAAAAB/+AAAAAD4AAAAAAf/gAAAAACAAAAAAH/4AAAAAAQAAAAAB/+AAAAAAEAAAAAAP/gAAAAAAAAAAAAD/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/wAAAAAAAAAAAAD/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/wAAAAAAAAAAAAB/8AAAAAAAAAAAAAH3AAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"rallus-aquaticus-2":{"w":85,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAiAAAAADgwAAAACZAAAAAHhwAAAABNkAAAAHzwAAAAAuzAAAAH3wAAAAA//gAAAP/xgAAAAf/2AAAP/zgAAAAP/3AAAP//gAAAAH//gAAP//gAAAAH//8AAP//gAAAAD//+AAP//mAAAAB//+AAP//+AAAAA///AAP//+AAAAAf//wAP//+AAAAAP//4AP//+AAAAAH//8AH///wAAAAD//8AH///wAAAAB//+AH///wAAAAA///AH///wAAAAAf//gH///4AAAAAP//wH///4AAAAAH//wH///4AAAAAD//4H///8AAAAAB//+H///+AAAAAA///j///8AAAAAAf//7///8AAAAAAP//////8AAAAAAH//////4AAAAAAB//////wAAAAAAA//////4AAAAAAAf/////+AAAAAAAH/////+AAAAAAAA//////gAAAAAAAP/////wAAAAAOAD/////4AAAAAf4A/////8AAAAAf+AP/////AAAAAf/wH/////AAAAAf/8D/////gAAAAf////////wAAAAf////////4AAAA/////////8AAAB/////////+AAAD4D///////+AAAHgAH///////ABwHAAB///////gH4GAAAf//////gP4AAAAH//////8f8AAAAB////////+AAAAAf///////+AAAAAH////////AAAAAB////////AAAAAAf//////+AAAAAAH//////+AAAAAAA///////AAAAAAAP//////AAAAAAAA//////AAAAAAAAH/////AAAAAAAAA/////AAAAAAAAAH///+AAAAAAAAAA///+AAAAAAAAAAD//8AAAAAAAAAAAf/4AAAAAAAAAAAD/8AAAAAAAAAAAAf/AAAAAAAAAAAAAPwAAAAAAAAAAAAD8AAAAAAAAAAAAA2AAAAAAAAAAAAAZAAAAAAAAAAAAAIgAAAAAAAAAAAAEQAAAAAAAAAAAAGIAAAAAAAAAAAADMAAAAAAAAAAAABGAAAAAAAAAAAABjAAAAAAAAAAAAAxgAAAAAAAAAAAAYwAAAAAAAAAAAAMYAAAAAAAAAAAAPuAAAAAAAAAAAAHfwAAAAAAAAAAABzkAAAAAAAAAAAAY4AAAAAAAAAAAAPOAAAAAAAAAAAAD3gAAAAAAAAAAAA18AAAAAAAAAAAAOcAAAAAAAAAAAABjgAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"rallus-aquaticus":{"w":93,"h":90,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAf8AAAAAAAAAAAAAH/4AAAAAAAAAAAAD//gAAAAAAAAAAAAf/+AAAAAAAAgAAAH//wAAAAAAAcAAAB///AAAAAAADwAAA///8AAAAAAA+AAAf///gAAAAAAPwAAf///+AAAAAAD+AAP8f//wAAAAAA/wAH4Af//AAAAAAH+AB4AA//4AAAAAB/wA4AAD//gAAAAAf+AMAAAf/8AAAAAD/wAAAAD//4AAAAA/+AAAAAP//7//gAP/wAAAAB//////4P/+AAAAAf/////////wAAAAD/////////+AAAAAf/////////wAAAAD/////////+AAAAAf/////////wAAAAD/////////+AAAAAf/////////gAAAAD/////////8AAAAAf/////////4AAAAD//////////wAAAAf//////////AAAAD//////////8AAAAf/////////+AAAAB/////////+AAAAAP/////////4AAAAB/////////+AAAAAH/////////AAAAAAf////////8AAAAAD/////////4AAAAAP/////////wAAAAA//////////AAAAAD/////////8AAAAAP////////+AAAAAAf////////AAAAAAB////////AAAAAAAD//////8AAAAAAAAH//////AAAAAAAAAP/////gAAAAAAAAAf////4AAAAAAAAAA////8AAAAAAAAAAA////AAAAAAAAAAAA///4AAAAAAAAAAAf//zgAAAAAAAAAAH///+AAAAAAAAAAB+f8fgAAAAAAAAAAOx/gAAAAAAAAAAADjD4AAAAAAAAAAAAcYPAAAAAAAAAAAAHhgcAAAAAAAAAAAA4IBwAAAAAAAAAAAHjAOAAAAAAAAAAAAUABwAAAAAAAAAAACwAOAAAAAAAAAAAASABwAAAAAAAAAAADMAMAAAAAAAAAAAAIADgAAAAAAAAAAAAgAYAAAAAAAAAAAAAADAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAGAAAAAAAAAAAAAABwAAAAAAAAAAAAAAOAAAAAAAAAAAAAADgAAAAAAAAAAAAAAYAAAAAAAAAAAAAAHAAAAAAAAAAAAAAA4AAAAAAAAAAAAB4P/AAAAAAAAAAAAD/7gAAAAAAAAAAAAD8AAAAAAAAAAAAAB/AAAAAAAAAAAAAD8QAAAAAAAAAAAAB8GAAAAAAAAAAAAAcBgAAAAAAAAAAAAEAYAAAAAAAAAAAAAAGAAAAAAAAAAAAAABgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"recurvirostra-avosetta-2":{"w":75,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAADAAAAAAAAAAAAcAAAAAAAAAAAHgAAAAAAAAAAA+AAAAA4AAAAAPwAAAA8AAAAAB/AAAAf4AAAAAf4AAAP8AAAAAD/AAAH/gAAAAA/4AAD/4AAAAAH/gAB/+AAAAAA/4AA//wAAAAAP/AAP/8AAAAAB/4AH//AAAAAAP/gB//4AAAAAD/4A//+AAAAAAf/AP//gAAAAAH/4D//8AAAAAA//B//+AAAAAAH/4f//gAAAAAA//H//8AAAAAAH/x///AAAAAAA/+f//gAAAAAAP/z//4AAAAAAB////+AAAAAAAP////AAAAAAAB////4AAAAAAAP////AAAAAAAA////4AAAAAAAD////AAAAAAAAP///4AAAAAAAA////AAAAAAHgD///4AAAAAD/Af///AAAAAAf+D///4AAAAAH/wf///AAAAAAgHD///4AAAAAcAe////AAAAAPgBj///wAAAAHAAAf//+AAAADAAAD///gAAABgAAAP//8AAAAQAAAB///gAAAEAAAAP//4AAABAAAAA///AAAAAAAAAH//8AAAAAAAAAf//gAAAAAAAAD//+AAAAAAAAAP//wAAAAAAAAB///AAAAAAAAAP//8AAAAAAAAA///4AAAAAAAAH///gAAAAAAAA////AAAAAAAAD///+AAAAAAAAD///8AAAAAAAAP/n/AAAAAAAAAf4BwAAAAAAAAAfgAAAAAAAAAAB2AAAAAAAAAAADMAAAAAAAAAAAMwAAAAAAAAAAAzAAAAAAAAAAADcAAAAAAAAAAANgAAAAAAAAAABkAAAAAAAAAAAEwAAAAAAAAAAAyAAAAAAAAAAAGQAAAAAAAAAAATAAAAAAAAAAADIAAAAAAAAAAAJgAAAAAAAAAABEAAAAAAAAAAAMgAAAAAAAAAAAiAAAAAAAAAAAGQAAAAAAAAAAATAAAAAAAAAAACMAAAAAAAAAAAJ4AAAAAAAAAAB3AAAAAAAAAAAOcAAAAAAAAAAA5wAAAAAAAAAADmAAAAAAAAAAAOYAAAAAAAAAAAxgAAAAAAAAAADEAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"recurvirostra-avosetta":{"w":74,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAeAAAAAAAAAAAf4AAAAAAAAAAP/AAAAAAAAAAH/4AAAAAAAAAB/+AAAAAAAAAAf/wAAAAAAAAAP/8AAAAAAAAAD//AAAAAAAAAB//wAAAAAAAAB4/8AAAAAAAAA4H/AAAAAAAAAYB/gAAAAAAAAMAf4AAAAAAAAMAP+AAAAAAAAGAD/AAAAAAAACAB/wAAAAAAABAAf8AAAAAAAAgAH/wAAAAAAAQAD//4AAAAAAIAA///wAAAAAAAAP///gAAAAAAAD///+AAAAAAAA////wAAAAAAAP////AAAAAAAD////4AAAAAAA/////AAAAAAAP////8AAAAAAD/////gAAAAAAf////8AAAAAAH/////gAAAAAA/////4AAAAAAP/////AAAAAAA/////4AAAAAAP/////AAAAAAD/////4AAAAAAf/////AAAAAAH/////4AAAAAA//////AAAAAAH/////4AAAAAA/////+AAAAAAH/////wAAAAAAf////+AAAAAAD/////4AAAAAAP/////gAAAAAB/////8AAAAAAP/////wAAAAAB/////8AAAAAAf//v//AAAAAAD+AAP/4AAAAAAfAAAfhAAAAAAHgAAA8AAAAAABYAAAHgAAAAAAaAAAAAAAAAAACgAAAAAAAAAAAsAAAAAAAAAAAJAAAAAAAAAAADQAAAAAAAAAAAWAAAAAAAAAAAGgAAAAAAAAAADsAAAAAAAAAAA7AAAAAAAAAAAEwAAAAAAAAAABMAAAAAAAAAAATAAAAAAAAAAAEwAAAAAAAAAABMAAAAAAAAAAATAAAAAAAAAAAEwAAAAAAAAAABMAAAAAAAAAAASAAAAAAAAAAAEgAAAAAAAAAABIAAAAAAAAAAASAAAAAAAAAAAEgAAAAAAAAAABIAAAAAAAAAAAyAAAAAAAAAAAMgAAAAAAAAAAzoAAAAAAAAAG/yAAAAAAAAAAH4gAAAAAAAAAB4MAAAAAAAAAA8PAAAAAAAAAAA/gAAAAAAAAAAPwAAAAAAAAAAH8AAAAAAAAAAMHAAAAAAAAAAABgAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"regulus-ignicapilla-2":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAMAAAAAAAAAAAAAATiAAAAAAAAAAAAAG4wAAAAAAAAAAAABnOAAAAAAAAAAAAANziAAAAAAAAAAAAD+5wAAAAAAAAAAAAf/cAAAAAAAAAAAAH/3AAAAAAAAAAAAA//5AAAAAAAAAAAAP/+4AAAAAAAAAAAD//+AAAAAAAAAAAA///gAAAAAAAAAAAH//4AAAAAAAAAAAB///wAAAAAAAAAAAf//+AAAAAAAAAAAD///gAAAAAAAAAAA///4AAAAAAAAAAAP///AAAAAAAAAAAD///4AAAAAAAAAAA////AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAf///gAAAAAAAAAAH///8AAAAAAAAAAB////AAAAAAAAAAAf///wAAAAAAAAAAH///8AAAAAAAAHwB////AAAAAAAAD/gf///wAAAAAAAB//n///8AAAAAAAAf//////gAAAAAAAH//////8AAAAAAAB///////gAAAAAAAP//////8AAAAAAAB///////AAAAAAAAf//////4AAAAAAAD///////gAAAAAAA///////4AAAAAAAP///////AAAAAAAAP//////4AAAAAAAA//////+AAAAAAAAD//////gAAAAAAAB//////8AAAAAAAA//////+AAAAAAAAf/////wAAAAAAAAH//////AAAAAAAAD//////8AAAAAAAB///////wAAAAAAA////////AAAAAAAf///////8AAAAAAP////////wAAAAAH/////////wAAAAD//////////wAAAB///////////gAAA////////////wAAf////////////wAP/////////////AP/////////////8H///////5/+H///A///////+c5A///wAP//////j7AD///AH//////gZ8AP//4D/////7ADhgA//8A+f///4AAOAAH/+AAH3//4AAAwAAf/AAB9///AAADgAB/4AAeff/AAAAAAAP/AAAH3uwAAAAAAA/wAAA57kAAAAAAAD8AAAMOYAAAAAAAAPgAAABAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"regulus-ignicapilla":{"w":93,"h":66,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAAAAA//+AAAAAP+AAAAA////AAAAH/+AAAf/////AAAB//+AB//////+AAA///+D///////8AAP////////////wAA/////////////AAB////////////8AAA////////////wAAAP//////////+AAAAH//////////4AAAAT//////////gAAAAB/////////8AAAAA//////////wAAAAP/////////+AAAAD//////////wAAAH//////////+AAAf///////////wAAH///////////+AAAH///////////4AAAD//////////+AAAAD//////////4AAAAH//////////gAAAAH/////////+AAAAAf////////54AAAAD////////+DAAAAAP////////gAAAAAA////////4AAAAAAD///////+AAAAAAAf///////gAAAAAAB///////8AAAAAAAH///////AAAAAAAA///////wAAAAAAAD//////8AAAAAAAAP//////AAAAAAAAA//////wAAAAAAAAD/////4AAAAAAAAAH////+AAAAAAAAAAf////AAAAAAAAAAD////gAAAAAAAAAAff//8AAAAAAAAAAA4f//4AAAAAAAAAABgOB+gAAAAAAAAAAGCADwAAAAAAAAAAAYAAOAAAAAAAAAAABgABYAAAAAAAAAAAGAACAAAAAAAAAAAAYAAQAAAAAAAAAAABgAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAYAAAAAAAAAAAAAABgAAAAAAAAAAAAAAP/wAAAAAAAAAAAAH/9AAAAAAAAAAAAH/+AAAAAAAAAAAABwH/AAAAAAAAAAAAcAPcAAAAAAAAAAACAAZQAAAAAAAAAAAIABgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"regulus-regulus-2":{"w":75,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEYAAAwAAAAAABjAAAHgAAAAAAM4AAAeAAAAAADnAAAh4AAAAADc4AAHPgAAAAAbvAAAc/AAAAAH/4AAD78AAAAA//AAAP/wAAAA3/4AAE//AAAAG//AAAz/8AAAB//4AAH//wAAAP//AAAf//AAAB//4AAB//8AAA///AAAH//wAAH//wAAAf//AAB//+AAAP//8AAP//wAAB///wAD//+AAAH///AA///wAAAf//8AH//+AAAB///wA///wAAAf///AP//8AAAD///8D///gAAAP///wf//8AAAB////D///gAAAH///8///4AAAA////////AAAAH///////4AAAAf///////AAAAB///////4AAAAP//////+AAAAB///////wAAAAH//////+AAAAAf//////wAAAAD///////4AAAAf///////wAAAB////////gAAAH///////+AAAA////////4AAAH////////AAAA////////8AAAP////////wAAB////////+AAAP////////8AAB/////////4AAP////////gAAA////////4AAAP///////+AAAB////////AAAAP///////wAAAB///////8AAAAP///////AAAAB///////wAAAAH//////8AAAAA///////gAAAAD//////4AAAAAOf/////AAAAAAH/////wAAAAAA/////8AAAAAAP/////gAAAAAB/////4AAAAAAf////+AAAAAAD/////gAAAAAAf////4AAAAAAH////8AAAAAAA/////AAAAAAAH////4AAAAAAB/////gAAAAAAP////8AAAAAAD///37gAAAAAAf//+/cAAAAAAH///PjgAAAAAA//+x44AAAAAAP/4GPGAAAAAAD/4AjxgAAAAAA/+AEaMAAAAAAH/gACCAAAAAAB/8AAAAAAAAAAf/AAAAAAAAAAD/4AAAAAAAAAA/+AAAAAAAAAAP/wAAAAAAAAAB/8AAAAAAAAAAf/gAAAAAAAAAH/4AAAAAAAAAA+fAAAAAAAAAAHDwAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"regulus-regulus":{"w":93,"h":56,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAB8AAAAAAAAP/gAAAP+AAAAAAAf//AAAD/+AAAAD////8AAP//8AAH//////4AA///8Af///////gAA///+f///////+AAAf///////////4AAAP///////////AAAAH//////////8AAAAH//////////gAAAAb/////////+AAAAAD/////////+AAAAA//////////4AAAB//////////hgAAB//////////wAAAA//////////8AAAAAA/////////AAAAAAD////////wAAAAAAP///////8AAAAAAA////////AAAAAAAD///////wAAAAAAAf//////8AAAAAAAB///////gAAAAAAAH//////4AAAAAAAA//////+AAAAAAAAD//////gAAAAAAAAP/////4AAAAAAAAA/////+AAAAAAAAAD/////gAAAAAAAAAH////wAAAAAAAAAAf///4AAAAAAAAAAD///8AAAAAAAAAAAf//+AAAAAAAAAAABw/4AAAAAAAAAAAADAYAAAAAAAAAAAAAMBgAAAAAAAAAAAAAwHAAAAAAAAAAAAADAMAAAAAAAAAAAAAMAwAAAAAAAAAAAAA3/gAAAAAAAAAAAADAfAAAAAAAAAAAAAcB4AAAAAAAAAAAB/wPAAAAAAAAAAAA//hwAAAAAAAAAAAEA2OAAAAAAAAAAAAAHzwAAAAAAAAAAAAA8IAAAAAAAAAAAAAHAAAAAAAAAAAAAAD4AAAAAAAAAAAAAADAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"riparia-riparia-2":{"w":91,"h":93,"bits":"AAAAAAAAAAAAAAAOAAAAAAAAAAAAAAD4AAAAAAAAAAAAAA/AAAAAAAAAAAAAAP4AAAAAAAAAAAAAD/AAAAAAAAAAAAAA/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAD/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/4AAAAAAAAAAAAD//AAAAAAAAAAAAA//wAAAAAAAAAAAAP/+AAAAAAAAAAAAD//wAAAAAAAAAAAA//8AAAAAAAAAAAAf//gAAAAAAAAAAAD//4AAAAAAAAAAAA///AAAAAAAAAAAAf//wAAAAAAAAAAAH//8AAAAAAAAAAAA///gAAAAAAAAAAAP//4AAAAAAAAAAAD//+AAAAAAAAAAAB///gAAAAAAAAAAAf//4AAAAAAAAAAAD//8AAAAAAAAAAAA//+AAAAAAAAAAAAH//gAAAAAAAAAAAD//wB/AAAAAAAAAB//8D/4AAAAAAAAA///H/+AAAAAAAAAf/////gAAAAAAAAP/////4AAAAAAAAD//////AAAAAAAAB/////4AAAAAAAAA/////4AAAAAAAAAf////4AAAAAAAAAP////wAAAAAAAAAD////4AAAAAAAAAB////4AAAAAAAAAAf///8AAAAAAAAAAH///+AAAAAAAAAAB////gAAAAAAAAAAf///8AAAAAAAAAAH////wAAAAAAAAAH////+AAAAAAAAAD/////gAAAAAAAAD/////wAAAAAAAAB/////8AAAAAAAAA/////+AAAAAAAAAf/////gAAAAAAAAf/////4AAAAAAAAP/////8AAAAAAAAH//////AAAAAAAAH//////gAAAAAAAH/+P///4AAAAAAAH/+B///8AAAAAAAH//AH///AAAAAAAD//AAf//gAAAAAAD/+AAAP/4AAAAAAD/8AAAH/+AAAAAAD/8AAAB//AAAAAAD/8AAAAf/wAAAAAD/+AAAAP/4AAAAAD/+AAAAD/+AAAAAD//AAAAA//AAAAADwfAAAAAP/wAAAADgPgAAAAH/4AAAADgDgAAAAB/+AAAADADgAAAAAf/AAAADABwAAAAAH/wAAADAAwAAAAAB/4AAADAAYAAAAAAf+AAACAAIAAAAAAP/AAACAAEAAAAAAD/wAACAAGAAAAAAAf4AAAAACAAAAAAAH+AAAAABAAAAAAAD/AAAAABAAAAAAAA/wAAAAAgAAAAAAAP4AAAAAQAAAAAAAH+AAAAAQAAAAAAAB/AAAAAIAAAAAAAAPgAAAAAAAAAAAAAD4AAAAAAAAAAAAAA8AAAAAAAAAAAAAAfAAAAAAAAAAAAAAHgAAAAAAAAAAAAAA4AAAAAAAAAAAAAAMAAAAAAAAAAAAAADAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAA="},"riparia-riparia":{"w":89,"h":93,"bits":"AAAAAAAAAAAf4AAAAAAAAAAAAH/8AAAAAAAAAAAA//+AAAAAAAAAAAD//+AAAAAAAAAAAP//+AAAAAAAAAAA///+AAAAAAAAAAD///+AAAAAAAAAAP////AAAAAAAAAAf////wAAAAAAAAB/////QAAAAAAAAD////gAAAAAAAAAP///+AAAAAAAAAAf///4AAAAAAAAAB////wAAAAAAAAAH////AAAAAAAAAA////+AAAAAAAAAD////8AAAAAAAAAf////4AAAAAAAAB/////wAAAAAAAAH/////wAAAAAAAAf/////gAAAAAAAB//////AAAAAAAAP/////+AAAAAAAA//////8AAAAAAAB//////4AAAAAAAH//////wAAAAAAAf//////gAAAAAAB///////AAAAAAAH//////+AAAAAAAf//////4AAAAAAA///////wAAAAAAD///////gAAAAAAf//////+AAAAAAB///////8AAAAAAH///////wAAAAAAf///////gAAAAAB///////+AAAAAAH///////4AAAAAAf///////wAAAAAB////////AAAAAAH///////8AAAAAAP///////wAAAAAA////////AAAAAAD///////8AAAAAAP///////wAAAAAA////////AAAAAAH///////8AAAAAAf///////wAAAAAB///////+AAAAAAH///////4AAAAAA////////AAAAAAD///////8AAAAAAP///////gAAAAAB////////AAAAAAH////////AAAAAAf///////+AAAAAD////////+AAAAAP////////8AAAAA//////8D/wAAAAD/////gAP/wAAAAPn///+AAfjgAAAA8f///wAA8DAAAADj/7//AAAwGAAAAAP/H/8AABAcAAAAA/4f/wAABAwAAAAH+A/+AAAAPgAAAAPgD/4AAAADAAAAA8AH/gAAAAAAAAAAAAf+AAAAAAAAAAAAB/wAAAAAAAAAAAAD/gAAAAAAAAAAAAP+AAAAAAAAAAAAA/8AAAAAAAAAAAAB/wAAAAAAAAAAAAH/AAAAAAAAAAAAAf+AAAAAAAAAAAAA/4AAAAAAAAAAAAD/wAAAAAAAAAAAAP/AAAAAAAAAAAAA/8AAAAAAAAAAAAB/4AAAAAAAAAAAAH/gAAAAAAAAAAAAefAAAAAAAAAAAAAw8AAAAAAAAAAAADB4AAAAAAAAAAAAEHgAAAAAAAAAAAAAOAAAAAAAAAAAAAAcAAAAAAAAAAAAABwAAAAAAAAAAAAADAAAAAAAAAAAAAAGAAAAAAAAAAAAAAYAAAAAAAAAAAAAAgAAAAAAAAAAAAA"},"rissa-tridactyla-2":{"w":93,"h":69,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAH4AAAAAAAAAAAAAH+AAAAAAAAAAAAAH/wPAAAAAAAAAAAD/4A8AAAAAAAAAAB/+AF4AAAAAAAAAB//gAfgAAAAAAAAA//4AD+AAAAAAAAAf/+AAP4AAAAAAAAP//gAB/wAAAAAAAP//4AAH/AAAAAAAH//+AAA/+AAAAAAB///gAAD/4AAAAAA///4AAAP/gAAAAAP//+AAAB/+AAAAAD///gAAAH/8AAAAB///4AAAAf/wAAAA///+AAAAB//AAAAP///gAAAAH/8AAAD///4AAAAA//wAAA///8AAAAAD//AAAP///AAAAAAP/8AAD///wAAAAAA//wAA///8AAAAAAH//gAH///AAAAAAAf/+AA///gAAAAAAB//4AH//8AAAAAAAH//wA///AAAAAAAAf//AH//4AAAAAAAA//8A///AAAAAAAAB//wH//4AAAAAAAAH//B//+AAAAAAAAAP/8P//wAAAAAAAAA//x//+AAAAAAAAAH//f//wAAAAAAAAAf/7//+AAAAAAAAAB/////gAAAAAAAAAP////8AAAAAAAAAA/////gAAAAAAAAAH////4AAAAAAAAAA/////AAAAAAAAAAH////wAAAAAAAAA/////+AAAAAAAAAf/////gAAAAAAAAH/////8AAAAAAAAB//////gAAAAAAAAP/////8AAAAAAAAD//////wAAAAAAAAf/////+AAAAAAAAH//////wAAAAAAAD///////AAAAAAAA///////+AAAAAAAHj//////4AAAAAAAwD//////wAAAAAAAAP//////AAAAAAAAAf//////AAAAAAAAB///////wAAAAAAAD///////+AAAAAAAH///////4AAAAAAAH//////+AAAAAAAAD//////gAAAAAAAAB////P4AAAAAAAAAAAf/4EAAAAAAAAAAAD/AAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"rissa-tridactyla":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAf+AAAAAAAAAAAAAP/8AAAAAAAAAAAAD//wAAAAAAAAAAAA///AAAAAAAAAAAAP//4AAAAAAAAAAAB///gAAAAAAAAAAA///8AAAAAAAAAAAf///wAAAAAAAAAAP///+AAAAAAAAAAD////wAAAAAAAAAA////+AAAAAAAAAAPwf//wAAAAAAAAABAB//+AAAAAAAAAAAAP//4AAAAAAAAAAAD///4AAAAAAAAAAAf///4AAAAAAAAAAH////8AAAAAAAAAA/////+AAAAAAAAAP/////+AAAAAAAAB//////8AAAAAAAAf//////4AAAAAAAD///////wAAAAAAAf///////gAAAAAAD///////+AAAAAAAf///////8AAAAAAD////////wAAAAAAf////////AAAAAAB/////////AAAAAAP////////+AAAAAB/////////4AAAAAH/////////gAAAAA//////////AAAAAD/////////8AAAAAf/////////8AAAAB//////////+AAAAH///////////gAAAf///////////gAAB////////////AAAH///////////4AAAf//////////+AAAA///////////wAAAD//////////4AAAAH////8D///8AAAAAP////Af///wAAAAAP///wGAAf+AAAAAAP//8CAAAPAAAAAAAP//gAAAAAAAAAAAA//wAAAAAAAAAAAAD/4AAAAAAAAAAAAAb+AAAAAAAAAAAAADPAAAAAAAAAAAAAAQYAAAAAAAAAAAAACDAAAAAAAAAAAAAAQYAAAAAAAAAAAAAGDAAAAAAAAAAAAAA4YAAAAAAAAAAAAf+DAAAAAAAAAAAAD/wYAAAAAAAAAAAAf+HAAAAAAAAAAAAH//4AAAAAAAAAAAADv+AAAAAAAAAAAAAB/wAAAAAAAAAAAAAf+AAAAAAAAAAAAAH/gAAAAAAAAAAAAAB4AAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"saxicola-rubetra-2":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAA4AAAAAAAAAAAAAAOEAAAAAAAAAAAAAHzAAAAAAAAAAAAAB9wAAAAAAAAAAAAA/+AQAAAAAAAAAAAP/gDAAAAAAAAAAAH/zAOAAAAAAAAAAB//4M4AAAAAAAAAA//+AzwAAAAAAAAAP//gD/AAAAAAAAAD//wAP+AAAAAAAAB///wA/4AAAAAAAAf//8AD/wAAAAAAAH///ADP/gAAAAAAB///wAP/+AAAAAAAf//8AA//8AAAAAAP///4AD//wAAAAAD///+AAH//gAAAAA////gAAf/+AAAAAP///4AAN//8AAAAH////AAA///4AAAB////4AAB///gAAAf///8AAAH////AAH////AAAAf////AB////4AAAD////+Af///+AAAAP////4H////gAAAAf////5////wAAAAB/////////4AAAAAH/////////AAAAAAf////////gAAAAAA////////8AAAAAAAf///////wAAAAAAH///////8AAAAAAA////////wAAAAAAD///////+AAAAAAAf///////wAAAAAAD///////+AAAAAAAH///////wAAAAAAA///////+AAAAAAAH///////wAAAAAAAP//////+AAAAAAAB///////gAAAAAAAH//////8AAAAAAAAv////7/AAAAAAAAA/////DwAAAAAAAAA////8AAAAAAAAAAD////wAAAAAAAAAAP////AAAAAAAAAAA////4AAAAAAAAAAD////gAAAAAAAAAAH///8AAAAAAAAAAAP///wAAAAAAAAAAAf///AAAAAAAAAAAH///8AAAAAAAAAAB3///wAAAAAAAAAAOe/v/AAAAAAAAAABvQA/+AAAAAAAAAAc5gD/4AAAAAAAAABzkAf/gAAAAAAAAAHcQB/+AAAAAAAAAAxwAH/4AAAAAAAAABEAAf/wAAAAAAAAAAQAD//AAAAAAAAAAAAAP/8AAAAAAAAAAAAA//4AAAAAAAAAAAAD8/AAAAAAAAAAAAAPgAAAAAAAAAAAAAA4AAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"saxicola-rubetra":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAD/8AAAAAAAAAAAAA//4AAAAAAAAAAAAf//gAAAAAAAAAAAH//+AAAAAAAAAAAB///4AAAAAAAAAAAf///gAAAAAAAAAAH////wAAAAAAAAAB/////AAAAAAAAAAP///8AAAAAAAAAAD////AAAAAAAAAAA////wAAAAAAAAAA////8AAAAAAAAAAf////AAAAAAAAAAP////4AAAAAAAAAD/////AAAAAAAAAB/////wAAAAAAAAAf////+AAAAAAAAAP/////wAAAAAAAAP/////+AAAAAAAAH//////wAAAAAAAD//////+AAAAAAAA///////gAAAAAAAf//////8AAAAAAAH///////gAAAAAAB///////8AAAAAAA////////AAAAAAAf///////4AAAAAAf///////+AAAAAAP////////wAAAAADP///////8AAAAAAD////////AAAAAAB////////4AAAAAAf///////+AAAAAAP////////gAAAAAP////////4AAAAAP////////+AAAAAH/x///////AAAAAH/4AH/////wAAAAD/4AAH////4AAAAB/8AAAf///+AAAAA/8AAAA////AAAAAP+AAAAD///AAAAAAeAAAAAP//wAAAAAAAAAAAB////wAAAAAAAAAAOD+A/AAAAAAAAAAAwAAE4AAAAAAAAAAGAADDAAAAAAAAAAAYAAwwAAAAAAAAAABAAMOAAAAAAAAAAAMABAwAAAAAAAAAAAwAEWAAAAAAAAAAAGAABgAAAAAAAAAAAYAAAAAAAAAAAAAABAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAeAAAAAAAAAAAAAAH4AAAAAAAAAAAAABuAAAAAAAAAAAAAAZwAAAAAAAAAAAAAGOAAAAAAAAAAAAAAXgAAAAAAAAAAAAAL4AAAAAAAAAAAAAATAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"saxicola-rubicola-2":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAhAAAAAAAAAAAAAAMYAAAAAAAAAAAAADHAAAAAAAAAAAAAA5wAAAAAAAAAAAAAGeIAAAAAAAAAAAAB3jAAAAAAAAAAAAAd5wAAAAAAAAAAAAH+eAAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+EAAAAAAAAAAAB//nAAAAAAAAAAAAf//4AAAAAAAAAAAH//+AAAAAAAAAAAB///gAAAAAAAAAAAf//wAAAAAAAAAAAH//8wAAAAAAAAAAD///+AAAAAAAAAAA////gAAAAAAAAAAP///wAAAAAAAOAAD///8AAAAAAAP/AA////wAAAAAAH/8AP///+AAAAAAB//4D////gAAAAAA///g////wAAgAAA///+f///+AADAAAA////////gAGOAAAB///////4AAeeAAAH//////4AAA//gAAf//////AAAx///wB//////4AAD////////////AAAH///////////4AAAH///////////AAAP///////////4AAA///////////8AAAA///////////wAAAB//////////+AAAB///////////AAAAB//////////4AAAAD//////////AAAAAf/////////gAAAAAP////////4AAAAAAH//////+AAAAAAAAD//////4AAAAAAAAD//////AAAAAAAAAB/////4AAAAAAAAAJ/////gAAAAAAAAAN////8AAAAAAAAAANoP//gAAAAAAAAAAAD//+AAAAAAAAAAAAf//4AAAAAAAAAAADm//AAAAAAAAAAAAaf/8AAAAAAAAAAABLX/gAAAAAAAAAAAMIP+AAAAAAAAAAAAwg/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAAf8AAAAAAAAAAAAAD/wAAAAAAAAAAAAAP/AAAAAAAAAAAAAB/8AAAAAAAAAAAAAH/gAAAAAAAAAAAAA/+AAAAAAAAAAAAAD/4AAAAAAAAAAAAAf/AAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAA+8AAAAAAAAAAAAADgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"saxicola-rubicola":{"w":93,"h":80,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHwAAAAAAAAAAAAAP/4AAAAAAAAAAAAH//wAAAAAAAAAAAB///AAAAAAAAAAAA///8AAAAAAAAAAAP///wAAAAAAAAAAD////gAAAAAAAAAA/////wAAAAAAAAAH/////gAAAAAAAAB////+AAAAAAAAAAf////AAAAAAAAAAH////wAAAAAAAAAA////8AAAAAAAAAAP////gAAAAAAAAAH////4AAAAAAAAAD/////AAAAAAAAAB/////wAAAAAAAAA/////+AAAAAAAAAP/////wAAAAAAAAH/////8AAAAAAAAB//////gAAAAAAAAf/////8AAAAAAAAH//////gAAAAAAAB//////8AAAAAAAAf//////gAAAAAAAP//////8AAAAAAAD///////gAAAAAAB///////8AAAAAAAf///////gAAAAAAH///////4AAAAAAB////////AAAAAAAf///////4AAAAAAH///////+AAAAAAB////////wAAAAAAf///////8AAAAAAH////////gAAAAAA////////4AAAAAAP////////AAAAAAB////////wAAAAAAP///////8AAAAAAD////////AAAAAAA////////4AAAAAAf///////+AAAAAAH////////gAAAAAB5///////4AAAAAAcf//////8AAAAAACH///////AAAAAAAB///////gAAAAAAAf//////4AAAAAAAH//////+AAAAAAAB///////AAAAAAAAf/8f///gAAAAAAAH/4Af//gAAAAAAAB/8AD//gAAAAAAAAf/AAeD4AAAAAAAAH/wABwBwAAAAAAAB/8AADgDgAAAAAAAf/AAAOAHAAAAAAAH/wAAAYAOAAAAAAB/8AAABgA8AAAAAAf/AAAAGAAwAAAAAP/wAAAAcAPgAAAAD/8AAAAAwfPAAAAAf/AAAAADEB8AAAAH/wAAAAAeAHgAAAA/8AAAAAP4A8AAAAP/AAAAAPHwPAAAAB/gAAAABAeHgAAAAHAAAAAAADwcAAAAAAAAAAAAA8NgAAAAAAAAAAAAmAIAAAAAAAAAAAADwCAAAAAAAAAAAAA8AAAAAAAAAAAAAAAgAAAAAAAAAAAAAAIAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"sitta-europaea-2":{"w":77,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAMwAAAAAAAAAAAZgAAAAAAAAAAEzAAAAAAAAAAAJ/YAAAAAAAAAAf+wAAAAAAAAAA/9gAAAAAAAAAD//AAAAAAAAAAf/+AAAAAAAAAA//8AAAAAAAAAB//4AABAAAAAAP//wAADgAAAAAf//gABDwAAAAB//+AADjwAAAAD//8AADz4AAAAP//4AAD78AAAA///wAAD/8AAAB///gABx/+AAAD//+AAB//+AAAP//8AAB///AAAf//4AAA///AAB///gAAA///AAD///AAAH///gAH//8AAAP///gAf//4AAAH///gA///wAAAH///wB///gAAAH///wH//+AAAAf///4f//8AAAAf///4///wAAAAP///7///wAAAAP///////8AAAA////////+AAAA////////+AAAA////////+AAAA/////////AAAA/////////wAAA/////////8AAAf////////AAAA////////gAAAA///////8AAAAB///////wAAAAH//////+AAAAAP//////4AAAAAP//////gAAAAAf//////AAAAAA//////+AAAAAB//////4AAAAAA//////wAAAAAB//////gAAAAAD/////+AAAAAAH/////8AAAAAAD/////wAAAAAAH/////gAAAAAAH////+AAAAAAAD////8AAAAAAACT////AAAAAAAAH////AAAAAAAAP///+AAAAAAAAf//+QAAAAAAAA///9gAAAAAAAB///rAAAAAAAAD//+iAAAAAAAAH//5EAAAAAAAAP//yAAAAAAAAAP//CAAAAAAAAAf/4AAAAAAAAAA//AAAAAAAAAAB/8AAAAAAAAAAD/wAAAAAAAAAAH/gAAAAAAAAAAP/AAAAAAAAAAAf+AAAAAAAAAAA/8AAAAAAAAAAB/4AAAAAAAAAAD/4AAAAAAAAAAP/wAAAAAAAAAAf/gAAAAAAAAAA//AAAAAAAAAAB/+AAAAAAAAAAD/8AAAAAAAAAAP/4AAAAAAAAAAf/wAAAAAAAAAA//gAAAAAAAAAB/8AAAAAAAAAAD9gAAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"sitta-europaea":{"w":93,"h":61,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAD/8AAAAAAAAAAAAB//4AAAAAAAAAAAA///wAAAAAAAAAAAP///gAAAAAAAAAAH///+AAAAAAAAAD/////4AAAAAAAAA///////8AAAAAAAB/////////8AAAAAAf//////////AAAAA///////////wAAAD//////////8AAAAP/////////wAAAAAf////////+D/AAAD///////////+AAAP///////////wAAA////////////AAAH///////////8AAA////////////gAAH///////////4AAAf/////////AAAAAD/////////gAAAAAf////////wAAAAAB////////wAAAAAAP///////8AAAAAAB////////gAAAAAAH///////4AAAAAAA///////+AAAAAAAD///////gAAAAAAAP//////4AAAAAAAA///////AAAAAAAAD//////wAAAAAAAAP/////8AAAAAAAAAf/////AAAAAAAAAA/////wAAAAAAAAAD////8AAAAAAAAAAf////gAAAAAAAAAf////4AAAAAAAAAHx4/AeAAAAAAAAABODAADAAAAAAAAAADgIAAwAAAAAAAAAA8AAAMAAAAAAAAAAHgAADAAAAAAAAAAA0AABwAAAAAAAAAAEYAAc8AAAAAAAAAAQAAH/wAAAAAAAAACAAD4AAAAAAAAAAAAAA+AAAAAAAAAAAAAANwAAAAAAAAAAAAABeAAAAAAAAAAAAAADwAAAAAAAAAAAAAASAAAAAAAAAAAAAADYAAAAAAAAAAAAAAZAAAAAAAAAAAAAACAAAAAAAAAAAAAAAYAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"spatula-clypeata-2":{"w":93,"h":76,"bits":"AAAAAAAAAAAAAAAAAAAAAAABIAAAAAAAAAAAAAAbAAAAAAAAAAAAAADyAAAAAAAAAAAAAA/wAAAAAAAAAAAAAP8AAAAAAAAAAAAAB/gAAAAAAAAAAAAAf+AAAAAAAAAAAAAH/wAAAAAAAAAAAAA/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAD/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAH/8AAAAAAAAAAAAB//gAAAAEAAAAAAAP/8AAAABgAAAAAAD//AAAAA44AAAAAAf/4AAAAf+AAAAAAH//AAAAP/AAAAAAB//wAAAP/+AAAAAAP/+AAAH//gAAAAAD//wAAH//4AAAAAAf/8AAD//8AAAAAAH//gAB///gAAAAAA//4AA///4AAAAAAP//AA///+AAAAAAB//wAf///gAAAAAAf/+AP///4AAAAAAD//wD///+AAAAAAAf/8B////gAAAAAAH//w////4AAAAAAA//+P///+AAAAAAAH///////gAAAAAAA///////wAAAAAAAH//////4AAAAAAAAf/////+AAAAAAAAD//////AAAAAAAAAP/////wAAAAAAAAA/////4AAAAAAAAAH////4AAAAAAAAAAf////AAAAAAAAAAD////4AAAAAABgAAf////AAAAAAD/4AD////4AAAAAB//wAf////AAAAAAP//gP////4AAAAAD//+D////+AAAAAB/////////wAAAAA/////////+AAAAAf/////////gAAAA//////////8AAAAH8AAH//////gAAAAAAAAf/////4AAAAAAAAD/////+AAAAAAAAAf/////wAAAAAAAAB//////AAAAAAAAAP/////+AAAAAAAAA//////8AAAAAAAAH//////wAAAAAAAAf//////AAAAAAAAB//////+AAAAAAAAD///////AAAAAAAAH///////AAAAAAAAH//////8AAAAAAAAH//////wAAAAAAAAP/////+AAAAAAAAAf/////wAAAAAAAAA/////8AAAAAAAAAA///7/AAAAAAAAAAAf/+CAAAAAAAAAAAAA/+AAAAAAAAAAAAAH/wAAAAAAAAAAAAA//8AAAAAAAAAAAAD//4AAAAAAAAAAAAH/4AAAAAAAAAAAAAPwAAAA="},"spatula-clypeata":{"w":88,"h":93,"bits":"AAAAAAAAAAAAAAAAAAD/gAAAAAAAAAAAA//gAAAAAAAAAAAH//gAAAAAAAAAAA///AAAAAAAAAAAD//+AAAAAAAAAAAf//4AAAAAAAAAAB///wAAAAAAAAAAP///AAAAAAAAAAA///+AAAAAAAAAAH///4AAAAAAAAAAf///gAAAAAAAAAD///+AAAAAAAAAAf///4AAAAAAAAAD////gAAAAAAAAAf///+AAAAAAAAAH////wAAAAAAAAB//D//AAAAAAAAAf/wP/4AAAAAAAAH/8A//gAAAAAAAA//gH/8AAAAAAAAP/4A//gAAAAAAAB//AH/+AAAAAAAAP/4B//wAAAAAAAA//AP//PgAAAAAAB/wB////8AAAAAAAAAP////+AAAAAAAAB/////+AAAAAAAAH/////+AAAAAAAA//////+AAAAAAAD//////+AAAAAAAf//////8AAAAAAB///////4AAAAAAH///////4AAAAAAf///////4AAAAAB////////wAAAAAH////////gAAAAAf////////AAAAAB/////////AAAAAH////////+AAAAAf////////8AAAAB/////////4AAAAD/////////8AAAAP/////////8AAAAf/////////8AAAB//////////8AAAD/////////78AAAH/////////g4AAAP/////////AAAAAf////////8AAAAA/////////+AAAAA//////////AAAAB//////////AAAAB/////////+AAAAB////////+AAAAAD////////8AAAAAD////////8AAAAAD////////wAAAAAP////////AAAAAA//////9/+AAAAAD////+AD/4AAAAAP////AAD+AAAAAA/4f/AAAAAAAAAAD/w/4AAAAAAAAAAL5g/AAAAAAAAAAAGAA8AAAAAAAAAAAYADwAAAAAAAAAAAwAPAAAAAAAAAAAAAA8AAAAAAAAAAAAADgAAAAAAAAAAAAAOAAAAAAAAAAAAAA4AAAAAAAAAAAAADAAAAAAAAAAAAAAMAAAAAAAAAAAAABwAAAAAAAAAAAAAHAAAAAAAAAAAAAAeAAAAAAAAAAAAAD+AAAAAAAAAAAP//IAAAAAAAAAAAf/8AAAAAAAAAAAA//wAAAAAAAAAAAD/+AAAAAAAAAAAAP/4AAAAAAAAAAAA//gAAAAAAAAAAAH/+AAAAAAAAAAAB//wAAAAAAAAAAAEH/AAAAAAAAAAAAAP4AAAAAAAAAAAAAfAAAAAAAAAAAAAB4AAAAAAAAAAAAAHAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA"},"spinus-spinus-2":{"w":93,"h":90,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAA4AAAAAAAAAAAAAAeAAAAAAAAAAAAAAPhAAAAAAAAAAAAAH44AAAAAAAAAAAAB/eAAAAAAAAAAAAA//gAAAAAAAAAAAAP/4AAAAAAAAAAAAH/+YAAAAAAAAAAAB//uAAAAAAAAAAAA///gAAAAAAAAAAAP//4AAAAAAAAAAAD//+AAAAAAAAAAAA///gAAAAAAAAAAAf//4AAAAAAAAAAAH//+YAAQAAAAAAAB///+ABjAAAAAAAAf///gAGcQAAAAAAH///4AA5zAAAAAAB///+AADvcAAAAAAf///gAAe93AAAAAP///8AAB//cAAAAD////AAAP//0AAAA////4AAA///wAAAH///+AAAH///AAAB////gAAAf///AAAf///4AAAB///8AAH///+AAAAP///4AB////wAAAA////gAf///8AAAAD////gH////AAAAAP///+A////4AAAAB////8P///+AAAAAH////5////gAAAAAP////v///4AAAAAA////////+AAAAAAH////////4AAAAAAf////////AAAAAAB////////4AAAAAAD////////AAAAAAAP///////8AAAAAAB////////AAAAAAAf///////8AAAAAAH////////gAAAAAB////////8AAAAAAAf///////gAAAAAAD///////8AAAAAAAP///////gAAAAAAA///////4AAAAAAAD///////AAAAAAAAP//////4AAAAAAAA///////AAAAAAAAH//////wAAAAAAAAf/////gAAAAAAAAD/////+AAAAAAAAAP/////wAAAAAAAAB//////AAAAAAAAAH/////8AAAAAAAAAf/////wAAAAAAAAB/////+AAAAAAAAAH/////4AAAAAAAAAf/////gAAAAAAAAB/////8AAAAAAAAAD/////wAAAAAAAAAP/////AAAAAAAAAAf////8AAAAAAAAAAf////wAAAAAAAAAA////+AAAAAAAAAAH////4AAAAAAAAAA//A//gAAAAAAAAAH/4B/+AAAAAAAAAAf/AD/4AAAAAAAAAA4YAP/wAAAAAAAAAAAAA//AAAAAAAAAAAAAD/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAB//gAAAAAAAAAAAAH/+AAAAAAAAAAAAAf/8AAAAAAAAAAAAD+PwAAAAAAAAAAAAPwfAAAAAAAAAAAAA8AAAAAAAAAAAAAADwAAAAAAAAAAAAAAcAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"spinus-spinus":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAAAAAAD/8AAAAAAAAAAAAA//4AAAAAAAAAAAAf//wAAAAAAAAAAAH///AAAAAAAAAAAA///8AAAAAAAAAAAP///wAAAAAAAAAAD////AAAAAAAAAAB////8AAAAAAAAAAf////gAAAAAAAAAH////+AAAAAAAAAAf////4AAAAAAAAAAf////gAAAAAAAAAB/////AAAAAAAAAAP////+AAAAAAAAAB/////8AAAAAAAAAH/////4AAAAAAAAA//////wAAAAAAAAH//////AAAAAAAAA//////+AAAAAAAAH//////4AAAAAAAA///////gAAAAAAAD///////AAAAAAAAf//////8AAAAAAAD///////wAAAAAAAf///////AAAAAAAD///////8AAAAAAAf///////4AAAAAAD////////gAAAAAAP///////+AAAAAAB////////4AAAAAAP////////gAAAAAB////////+AAAAAAH////////4AAAAAA/////////gAAAAAD////////+AAAAAAf////////4AAAAAB/////////AAAAAAP////////8AAAAAA/////////gAAAAAD////////+AAAAAAP////////4AAAAAA/////////gAAAAAD/////////AAAAAAP////////8AAAAAA/////////wAAAAAB/////////AAAAAAH////////8AAAAAAP///////+QAAAAAAf/////n/4AAAAAAA/////8f/gAAAAAAA///+AR/4AAAAAAAef/8AAX/gAAAAAAfAP4AAAf+AAAAAEfwAfAAAA/4AAAAD//8HwAAAD/wAAAA/8ADgAAAAP/AAAAOOAA4AAAAA/8AAACDAAcAAAAAD/4AAAgwAHAAAAAAH/gAAAAAD/+AAAAAf+AAAAAf9mAAAAAB/4AAAAH+AAAAAAAH/gAAAB9gAAAAAAAfgAAAAOYAAAAAAAB8AAAAHGAAAAAAAADgAAABBgAAAAAAAAMAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"stercorarius-parasiticus-2":{"w":63,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAMAAAAAAAAABwAAAAAAAAAPAAAAAAAAAB8AAAAAAAAAHwAAAAAAAAA+AAAAAAAAAH4AAAAAAAAA/gAAAAAAAAD+AAAAAAAAAf4AAAAAAAAD/gAAAAAAAAf+AAAAAAAAB/4AAAAAAAAP/gAAAAAAAA/8AAAAAAAAH/wAAAAAAAA/+AAAAAAAAD/4AAAAAAAAP/wAAAAAAAB//AAAAAAAAP/+AAAAAAAA//8AAAAAAAD//wAAAAAAAP//AAAAAAAA//8AAAAAAAB//wAAAAAAAD//AAAAAAAAH/4AAAAAAAAf/gAAAAAAAD/8AAAAAAAAf/wAABwAAAD//AAB4AAAAf/8AB+AAAAP///B/gAAB//////8AAA///////gAAP/f////8AAB/z/////wAAP4f/////AAH8D/////8AD4Af/////wAYAC////4/wAAAE///+AAAAAAD//GAAAAAAAP/wAAAAAAAB/+AAAAAAAAH/4AAAAAAAA//AAAAAAAAH/4AAAAAAAA//AAAAAAAAP/4AAAAAAAB//AAAAAAAAP/wAAAAAAAD/+AAAAAAAAf/wAAAAAAAD/+AAAAAAAAf/gAAAAAAAD/8AAAAAAAAP/gAAAAAAAB/8AAAAAAAAP/wAAAAAAAA/+AAAAAAAAH/4AAAAAAAA//AAAAAAAAD/4AAAAAAAAf/AAAAAAAAB/8AAAAAAAAP/gAAAAAAAA/8AAAAAAAAH/gAAAAAAAAf8AAAAAAAAD/wAAAAAAAAP+AAAAAAAAA/wAAAAAAAAH+AAAAAAAAAfwAAAAAAAAD/AAAAAAAAAP4AAAAAAAAA/AAAAAAAAAH4AAAAAAAAAfgAAAAAAAAB8AAAAAAAAAHgAAAAAAAAAcAAAAAAAAABgAAAAAAAAAEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA=="},"stercorarius-parasiticus":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAH//gAAAAAAAAAAAB//8AAAAAAAAAAAAP//wAAAAAAAAAAAD///AAAAAAAAAAAAf//8AAAAAAAAAAAD///gAAAAAAAAAAB///8AAAAAAAAAAD////wAAAAAAAAAA////+AAAAAAAAAAH////4AAAAAAAAAB8f///gAAAAAAAAAIB////AAAAAAAAAAAH///+AAAAAAAAAAA////+AAAAAAAAAAP////+AAAAAAAAAB/////8AAAAAAAAAf/////4AAAAAAAAD//////wAAAAAAAAf//////AAAAAAAAD//////8AAAAAAAAf//////wAAAAAAAD///////gAAAAAAA///////+AAAAAAAD///////4AAAAAAAf///////gAAAAAAD///////+AAAAAAAf///////4AAAAAAD////////AAAAAAAP///////8AAAAAAB////////wAAAAAAH////////AAAAAAA////////8AAAAAAD////////wAAAAAAP///////+AAAAAAA////////8AAAAAAD////////gAAAAAAf///////+AAAAAAB////////wAAAAAAH////////AAAAAAAf///////8AAAAAAB////////gAAAAAAH///////8AAAAAAAf///////4AAAAAAB////////gAAAAAAD////////AAAAAAAH///////8AAAAAAAf///////8AAAAAAA//4f/P//4AAAAAAB/8B/4P//wAAAAAAH/AP/A///gAAAAAP/gA/+D///AAAAAB/+AH/AP//+AAAAAf//A4OB//f4AAAAD/v+GAcH/8DAAAAA/5//gAIf/wAAAAAD+fn8AA5//gAAAAAfz4DgAD/5+AAAAAA/3AAAAf/j8AAAAAD25AAAB/+BwAAAAAEf4AAAH/4AAAAAAAD/gAAAf/gAAAAAAAEAAAAB/+AAAAAAAAAAAAAH/4AAAAAAAAAAAAAf8AAAAAAAAAAAAAB/gAAAAAAAAAAAAAD8AAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"stercorarius-pomarinus-2":{"w":63,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAwAAAAAAAAAOAAAAAAAAAHgAAAAAAAAB8AAAAAAAAAfAAAAAAAAAH4AAAAAAAAB+AAAAAAAAAfwAAAAAAAAH+AAAAAAAAB/gAAAAAAAAf8AAAAAAAAH/AAAAAAAAD/4AAAAAAAA/+AAAAAAAAH/gAAAAAAAB/8AAAAAAAAf/AAAAAAAAH/wAAAAAAAB/+AAAAAAAAP/gAAAAAAAD/8AAAAAAAAf/gAAAAAAAH/8AAAAAAAA//gAAAAAAAD/+AAAAAAAAP/wAAAAAAAA//AAAAAAAAH/4AAAAAAAAf/AAAAAAAAD/4AAAAAAAAf/AAAAAAAAD/4AAAAAAAA//AAAAAAB///8AAAAAAf///gAAAAAH///8AAAAAD////wAAAAB/////gPAAAAP/////8AAAAf/////AAAAB/////4AAAAH3////AAAAAMf///4AAAAAD/8//gAAAAAf/h///gAAAB/8//+AAAAAP/v/4MAAAAD/8B/AIAAAAf/gH4AAAAAH/8APAAAAAA//gAYAAAAAP/4AAAAAAAB//AAAAAAAAf/wAAAAAAAD/+AAAAAAAAP/gAAAAAAAB/8AAAAAAAAP/gAAAAAAAB/8AAAAAAAAH/gAAAAAAAA/8AAAAAAAAH/wAAAAAAAAf+AAAAAAAAD/wAAAAAAAAP/AAAAAAAAB/4AAAAAAAAH/AAAAAAAAA/8AAAAAAAAD/gAAAAAAAAP8AAAAAAAAB/gAAAAAAAAH+AAAAAAAAA/wAAAAAAAAD+AAAAAAAAAfwAAAAAAAAB+AAAAAAAAAH4AAAAAAAAAeAAAAAAAAAD4AAAAAAAAAPgAAAAAAAAA8AAAAAAAAADgAAAAAAAAAcAAAAAAAAABwAAAAAAAAAGAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"stercorarius-pomarinus":{"w":93,"h":65,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAD/wAAAAAAAAAAAAA//gAAAAAAAAAAAAP/+AAAAAAAAAAAAD//4AAAAAAAAAAAAf//gAAAAAAAAAAAH//8AAAAAAAAAAAB///wAAAAAAAAAAA///+AAAAAAAAAAA////wAAAAAAAAAAP////AAAAAAAAAAB8f//4AAAAAAAAAAMB///AAAAAAAAAAAAH//+AAAAAAAAAAAA///+AAAAAAAAAAAH////gAAAAAAAAAB/////gAAAAAAAAAP/////gAAAAAAAAD//////AAAAAAAAAf/////+AAAAAAAAD//////8AAAAAAAAf//////4AAAAAAAD///////gAAAAAAAf///////AAAAAAAD///////8AAAHwAAf///////wAAH/gAD////////wAD/8AAf////////AD//gAD////////8B//+AAP////////////wAB////////////4AAH///////////+AAAf///////////AAAD///////////gAAAP//////////wAAAA//////////wAAAAD/////////4AAAAAP////////+AAAAAAf////////gAAAAAB/////////AAAAAAD/////////gAAAAAP/////////4AAAAAf/////////+AAAAA//////////8AAAAB//////////AAAAAH////////4AAAAAD/////8f//gAAAAAf3///8A//+AAAAADiD//4AD//4AAAAAcQD/wAAH//AAAAAHgOP8AAAf/4AAAAA8D//AAAA/+AAAAAHg/fwAAAB/gAAAAAfP4AAAAADwAAAAABR/AAAAAAAAAAAAAAPAAAAAAAAAAAAAAB4AAAAAAAAAAAAAAPwAAAAAAAAAAAAAAfAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"sterna-hirundo-2":{"w":54,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAACAAAAAAAADAAAAAAAADAAAAAAAADgAAAAAAADgAAAAAAABwAAAAAAABwAAAAAAAB4AAAAAAAB4AAAAAAAB4AAAAAAAB8AAAAAAAB8AAAAAAAB8AAAAAAAB+AAAAAAAA+AAAAAAAB+AAAAAAAB/AAAAAAAB/AAAAAAAB/AAAAAAAB/AAAAAAAB/gAAAAAAB/gAAAAAAB/gAAAAAAB/gAAAAAAB/wAAAAAAD/wAAAAAAD/wAAAAAAB/wAAAAAAD/wAQAAAAH/wAMAAAAP/wACAAAAf/wABgAAB//wAAwAAD//wAAYAAH//wAAOAAH//wIAHAAP//wGAHwAP//gBgD4Af/+AAcD+Af/4AAH//g//wAAB/////gAAAf////gAAAH////AAAAA////AAAAAH///AAAAAH///gAAAAP///4AAAAH///+AAAAAf///AAAAA////gAAAA////wAAAB////4AAAB////4AAAB////4AAAB////4AAAB/+DB4AAAB/+AAcAAAB/+AAEAAAB/+AAGAAAB//AACAAAB//AAAAAAB//AAAAAAA//AAAAAAB//AAAAAAD//AAAAAAD/+AAAAAAH/8AAAAAAP/4AAAAAAf/wAAAAAA//gAAAAAB//AAAAAAB/+AAAAAAD/8AAAAAAH/4AAAAAAH/gAAAAAAP/AAAAAAAf+AAAAAAA/8AAAAAAA/4AAAAAAB/gAAAAAAD/AAAAAAAH+AAAAAAAP4AAAAAAAfwAAAAAAA/AAAAAAAB8AAAAAAADwAAAAAAAHAAAAAAAAIAAAAAAAAA=="},"sterna-hirundo":{"w":93,"h":47,"bits":"AAH4AAAAAAAAAAAAAD/wAAAAAAAAAAAAB//gAAAAAAAAAAAAf/8AAAAAAAAAAAD///wAAAAAAAAAAD////AAAAAAAAAAAR///4AAAAAAAAAAAAP//AAAAAAAAAAAAAf/8AAAAAAAAAAAAB//gAAAAAAAAAAAAP/8AAAAAAAAAAAAB//wAAAAAAAAAAAAP//gAAAAAAAAAAAD///gAAAAAAAAAAAf///AAAAAAAAAAAD////AAAAAAAAAAAf///+AAAAAAAAAAD////4AAAAAAAAAAf////wAAAAAAAAAD/////AAAAAAAAAAf////8AAAAAAAAAD/////4AAAAAAAAAP/////gAAAAAAAAB/////+AAAAAAAAAH/////4AAAAAAAAA//////4AAAAAAAAD//////4AAAAAAAAf//////wAAAAAAAB///////AAAAAAAAH///////+AAf/AAAf///////////AAAB///////////AAAAH/////////+AAAAAP////////4AAAAAAf///////gAAAAAAA///////gAAAAAAAB/////x4AAAAAAAAD///AAAAAAAAAAAAP//AAAAAAAAAAAAB4AAAAAAAAAAAAAAJAAAAAAAAAAAAAAD4AAAAAAAAAAAAAD/AAAAAAAAAAAAAAfgAAAAAAAAAAAAAP8AAAAAAAAAAAAAB4AAAAAAAAAAAAAAYAAAAAAAAAAAA=="},"sternula-albifrons-2":{"w":93,"h":73,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAABAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAHgAAAAAAAAAAAAAA8AAAAAAAAAAAAAAHgAAAAAAAAAAAAAB8AAAAAAAAAAAAAAPgAAAAAAAAAAAAAB8AAAAAAAAAAAAAAf4AAAAAAAAAAAAAD+AAAAAAAAAAA4AAf4AAAAAAAAAD+AAH/AAAAAAAAAH/AAA/4AAAAAAAAH/4AAH/gAAAAAAAH/8AAA/8AAAAAAAD/+AAAH/gAAAAAAD//gAAA/8AAAAAAB//4AAAP/gAAAAAA//8AAAB/+AAAAAA///AAAAP/wAAAAAf//wAAAB/+AAAAAP//8AAAAP/wAAAAH//+AAAAB/+AAAAD///gAAAAP/wAAAB///4AAAAB//AAAA///+AAAAAP/4AAAP///AAAAAB/+AAAH///wAAAAAP/wAAD///8AAAAAB//gAA////AAAAAAP/+AAP///gAAAAAB//4AH///4AAAAAAP//wB///+AAAAAAA///AP///AAAAAAAH//8D///wAAAAAAAf//wf//wAAAAAAAA///D//8AAAAAAAAB//8///gAAAAAAAAD//n//4AAAAAAAAAP/////AAAAAAAAAAv////wAAAAAAAAAB////+AAAAAAAAAf/////wAAAAAAAAP/////+AAAAAAAAH//////gAAAAAAAB//////8AAAAAAAAP//////AAAAAAAAD//////4AAAAAAAA//////+AAAAAAAAf//////wAAAAAAAf//////8AAAAAAAHh//////gAAAAAAAAB/////8AAAAAAAAAH/////wAAAAAAAAAP/////gAAAAAAAAA//////gAAAAAAAAD///////AAAAAAAAP/////////gAAAAA///////wAAAAAAAB//////gAAAAAAAAD/////8AAAAAAAAAD/////wAAAAAAAAAB///g/gAAAAAAAAAAA/8AfAAAAAAAAAAAD/4APAAAAAAAAAAAAKAAPAAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"sternula-albifrons":{"w":93,"h":64,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/4AAAAAAAAAAAAH//gAAAAAAAAAAAB//+AAAAAAAAAAAAf//4AAAAAAAAAAAH///gAAAAAAAAAAH///+AAAAAAAAAAH////wAAAAAAAAAH/////AAAAAAAAAD/////4AAAAAAAAA4Af///gAAAAAAAAAAB///8AAAAAAAAAAAH///4AAAAAAAAAAA////4AAAAAAAAAAH////wAAAAAAAAAA/////AAAAAAAAAAH////+AAAAAAAAAB/////4AAAAAAAAAP/////wAAAAAAAAB//////AAAAAAAAAP/////8AAAAAAAAD//////wAAAAAAAAf//////AAAAAAAAB//////8AAAAAAAAP//////gAAAAAAAB//////+AAAAAAAAP//////8AAAAAAAA///////4AAAAAAAH///////gAAAAAAAf///////AAAAAAAD////////0AAAAAAP/////////+AAAAB///////////AAAAH//////////gAAAAf/////////gAAAAD///////////AAAAP//////////4AAAAf/////////4AAAAB/////////AAAAAAD///////AAAAAAAAH//////4HAAAAAAAH//////8fgAAAAAAf///gH/wHwAAAAAB///wAD/gAAAAAAAH/8AAAB/AAAAAAAAfTAAAAA+AAAAAAADgQAAAAAAAAAAAAAMGAAAAAAAAAAAAABpgAAAAAAAAAAAAAf+AAAAAAAAAAAAAD/YAAAAAAAAAAAAA3iAAAAAAAAAAAAB+wAAAAAAAAAAAAD/4AAAAAAAAAAAAAP9AAAAAAAAAAAAAA+EAAAAAAAAAAAAAHAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"streptopelia-decaocto-2":{"w":93,"h":70,"bits":"AAAAAAAAAAAAAAACQAAAAAAAAAAAAAAbgAAAAAAAAAAAAABuAAAAAAAAAAAAAAP+AAAAAAAAAAAAAA/4AAAAAAAAAAAAAD/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAB//AAAAAAAAAAABgP/+AAAAAAAAAAD4A//4AAAAAAAAAP8AD//wAAAAAAAAf/+Af//gAAAAAAAf//gB//+AAAAAAAf//gAH//4AAAAAAP//wAA///gAAAAAP///AAD///AAAAAP///wAAP//8AAAAH///4AAA///wAAAH///+AAAD///AAAD////gAAAP///AAD////wAAAA///+AB////8AAAAH///4Af////AAAAAf///gP////gAAAAB///+D////4AAAAAH///4////+AAAAAAP///v////AAAAAAH////////wAAAAAB////////4AAAAAAf///////+AAAAAAH///////+AAAAAAA////////AAAAAAAH///////wAAAAAAA///////+AAAAAAAP///////wAAAAAAD////////AAAAAAA4///////4AAAAAAEB///////AAAAAAAAH//////4AAAAAAAA///////AAAAAAAAH//////4AAAAAAAAf//////AAAAAAAAD//////4AAAAAAAAf/////+AAAAAAAAD//////wAAAAAAAAP/////+AAAAAAAAB//////4AAAAAAAAH//////gAAAAAAAA//////+AAAAAAAAD//////4AAAAAAAAP//////gAAAAAAAA//////+AAAAAAAAB//////4AAAAAAAAH//////gAAAAAAAAP/////8AAAAAAAAAf/////wAAAAAAAAA//////gAAAAAAAAB/////+AAAAAAAAAD/////8AAAAAAAAB+/wP//4AAAAAAAAPP+A///gAAAAAAABvwAD///AAAAAAAAMZgAP//+AAAAAAABjEAA///4AAAAAAAOcAAD///wAAAAAAATgAAH///AAAAAAAAOAAAP//8AAAAAAAAAAAAf//wAAAAAAAAAAAAP/8AAAAAAAAAAAAAAMAA=="},"streptopelia-decaocto":{"w":93,"h":65,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAD/4AAAAAAAAAAAAA//AAAAAAAAAAAAAP/8AAAAAAAAAAAAD//gAAAAAAAAAAAAf/8AAAAAAAAAAAAH//wAAAAAAAAAAAA///AAAAAAAAAAAAP//8AAAAAAAAAAAB//4wAAAAAAAAAAAf/8AAAAAAAAAAAAD//AAAAAAAAAAAAA//wAAAAAAAAAAAAH/+AAAAAAAAAAAAB//wAAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAB//+AAAAAAAAAAAA///wAAAAAAAAAAAP//+AAAAAAAAAAAH///4AAAAAAAAAAD////AAAAAAAAAAB////4AAAAAAAAAA/////AAAAAAAAAAf////4AAAAAAAAAH////+AAAAAAAAAD/////4AAAAAAAAA//////AAAAAAAAAP/////4AAAAAAAAH//////AAAAAAAAB//////4AAAAAAAAf//////AAAAAAAAH//////4AAAAAAAD//////+AAAAAAAA///////wAAAAAAAf//////+AAAAAAAH///////wAAAAAAD///////8AAAAAAA////////gAAAAAAP///////4AAAAAAD////////AAAAAAA////////wAAAAAAP///////8AAAAAAH////////AAAAAAD////////wAAAAAA////////8AAAAAAf////////AAAAAAD////////gAAAAAA////////4AAAAAAH///////4AAAAAAB///////8AAAAAAA///////8AAAAAAAf//////+AAAAAAAP//8P///wAAAAAAH//4AAA///wAAAAD//gAAAA///AAAAA//AAAAAB88AAAAAf/gAAAAA//AAAAAP/gAAAAAH//AAAAH/wAAAAAAAcfAAAB/4AAAAAAAAwAAAAf4AAAAAAAADAAAAD4AAAAAAAAAIAAAAAAAAAAAAAAAAAAAA"},"sturnus-vulgaris-2":{"w":93,"h":82,"bits":"AAAAAAAAAAAAAAAAQAAAAAAAAAAAAAADgAAAAAAAAAAAAAGOAAAAAAAAAAAAAAY8AAAAAAAAAAAAABzwAAAAAAAAAAAAAP/gAAAAAAAAAAAAAf+AAAAAAAAAAAAAZ/8AAAAAAAAAAAAB//wAAAAAAAAAAAAH//gAAAAAAAAAAAAf/+AAAAAAAAAAAAB//8AAAAAAAAAAAAH//wAAAAAAAAAAAB///AAAAAAAAAAAAP//+AAAAAAAAAAAA///4AAAAAAAAAAAB///gAAAAAAAAAAAP//+AAAAAAAAAAAD///4AAAAAAAAAAAP///wAAAAAAAAAAA////AAAAAAAAAAAD///8AAAAAAAAAAAf///wAAAAAAAAAAD////AAAAAAAAAAAP///8AAAAAAAAAAA////wAAAAAAAAAAH////AAAAAAAAAAAf///4AAAAAAAAAAA////gAH8AAAAAAAH///8AH/4AAAAAAA////wB//wAAAAAAD///+Af//+AAAAAAf///wH///+AAAAAD////B///+AAAAAAf///8///wAAAAAAD///////4AAAAAAAf//////+AAAAOAAD///////gAAAfgAAP//////4AAD/wAAB///////AAP//wAAf//////wA///4AAB//////+P///8AAAH///////////AAAA///////////wAAAH//////////wAAAA//////////8AAAAB//////////AAAAAP/////////gAAAAB/////////4AAAAAD7///////8AAAAAAcf///////AAAAAAAH///////AAAAAAAB///////wAAAAAAAP//////4AAAAAAAD//////+AAAAAAAA//////+AAAAAAAAH//////wAAAAAAAB//////+AAAAAAAAf//////gAAAAAAAP//////8AAAAAAAH//////+AAAAAAAD///////gAAAAAAB///////gAAAAAAB/////BIAAAAAAAA/////wAAAAAAAAAP/////gAAAAAAAAB/////+AAAAAAAAAH///G/gAAAAAAAAA///4P8AAAAAAAAAH//+A+AAAAAAAAAA///wHAAAAAAAAAAD//+AAAAAAAAAAAAP//wAAAAAAAAAAAB//8AAAAAAAAAAAAH//gAAAAAAAAAAAAf/8AAAAAAAAAAAAD//AAAAAAAAAAAAAH/4AAAAAAAAAAAAAP/AAAAAAAAAAAAAAuwAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"sturnus-vulgaris":{"w":93,"h":91,"bits":"AAAAAAAAAAH+AAAAAAAAAAAAAH/+AAAAAAAAAAAAD//8AAAAAAAAAAAA///4AAAAAAAAAAAP///+AAAAAAAAAAD/////gAAAAAAAAA//////gAAAAAAAAP//////AAAAAAAAB/////+AAAAAAAAAP////gAAAAAAAAAD////gAAAAAAAAAAf///4AAAAAAAAAAH///+AAAAAAAAAAA////wAAAAAAAAAAH///8AAAAAAAAAAA////gAAAAAAAAAAP///8AAAAAAAAAAB////AAAAAAAAAAAP///4AAAAAAAAAAB////AAAAAAAAAAAf///4AAAAAAAAAAP////AAAAAAAAAAD////4AAAAAAAAAB/////gAAAAAAAAAf////8AAAAAAAAAH/////gAAAAAAAAD/////+AAAAAAAAA//////wAAAAAAAAP/////+AAAAAAAAD//////wAAAAAAAA//////+AAAAAAAAP//////4AAAAAAAD///////AAAAAAAA///////4AAAAAAAP//////+AAAAAAAB///////wAAAAAAAf//////+AAAAAAAH///////wAAAAAAB///////+AAAAAAAf///////wAAAAAAD///////8AAAAAAA////////gAAAAAAP///////4AAAAAAD///////+AAAAAAA////////wAAAAAAH///////+AAAAAAB////////gAAAAAAf///////8AAAAAAH////////AAAAAAA////////4AAAAAAP///////+AAAAAAB////////gAAAAAAf///////4AAAAAAD////////AAAAAAA////////wAAAAAAH///////8AAAAAAB////////AAAAAAAP///////wAAAAAAB///////8AAAAAAAf///////AAAAAAAH///////wAAAAAAA///////8AAAAAAAP///////AAAAAAAB///////gAAAAAAAf//////4AAAAAAAH//////8AAAAAAAA///////AAAAAAAAP//////gAAAAAAAD//////4AAAAAAAA//////+AAAAAAAAP//////gAAAAAAADf//8P/4AAAAAAAAT//4Af+AAAAAAAAA//+AB/gMAAAAAAAP//AAD4HwAAAAAAD//gAAPH/8AAAAAA//4AAB///wAAAAAH/4AAAD/8gAAAAAB/+AAAf//gAAAAAAf/gAAP8f/AAAAAAH/4AADMA/IAAAAAB/+AAAQAD4BwAAAAP/wAAAAAHg8AAAAD/8AAAAAAf/nwAAA//AAAAAAD///gAAH/wAAAAB///gAAAA/+AAAAARwPwAAAAH/gAAAAAAAP8AAAAf4AAAAAAAAGwAAAB+AAAAAAAAAAAAAAHgAAAAAAAAAAAAAA="},"sylvia-atricapilla-2":{"w":93,"h":91,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAQwAAAAAAAAAAAAACOEAAAAAAAAAAAAAzhgAAAAAAAAAAAAO84AAAAAAAAAAAABvPAAAAAAAAAAAAAfzwAAAAAAAAAAAAH/8wAAAAAAAAAAAB//OAAAAAAAAAAAAf//gAAAAAAAAAAAD//4AAAAAAAAAAAA//+AAAAAAAAAAAAP//kAAAAAAAAAAAD///gAAAAAAAAAAA///4AAAAAAAAAAAH//+AAAAAAAAAAAB///gAAAAAAAAAAAf//8AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAH///wAAAAAAAAAAB///+AAAAAAAAAAAf///wAAAAAAAAAAH///8AAAAAAAAAAB////AAAAAAAAAAAf///wAAAAAAAA4AD///8AAAAAAAA/8A////AAAAAAAAf/4H///4AAAAAAAH//h///+AAAAAAAB//+P///wAAAAAAAf//////+AAAAAAAf///////wAAAAAAH///////+AAAAAAAD///////4AAAAAAAP///////AAAAAAAAf//////wAAAAAAAB///////AAAAAAAAH//////4AAAAAAAA///////AAAAAAAAD//////wAAAAAAAAf/////+AAAAAAAAB//////wAAAAAAAAP/////+AAAAAAAAH//////gAAAAAAAH//////8AAAAAAAB///////gAAAAAAAf/////+wAAAAAAAH//////wAAAAAAAB///////AAAAAAAAf//////4AAAAAAAD///////gAAAAAAA///////+AAAAAAAP///////wAAAAAAB////////AAAAAAAf///////4AAAAAAH////////gAAAAAA////////+AAAAAAP/////v//4AAAAAD/////4P//gAAAAAf/////Dh//AAAAAH/////w/H/8AAAAB/////8Nuf/wAAAAf////+BmB//AAAAH////+APwH/8AAAA////+ABnAf/4AAAP///+AAMcB//gAAD///+AAAxwP/+AAA////gAADAA//4AAP///4AAAcAD//wAD///+AAAAYAP//AA////gAAAAAA//4AP///4AAAAAAD//gD///8AAAAAAAf/AA////AAAAAAAB/AAP///4AAAAAAAH4AHv//4AAAAAAAAeAAj/92AAAAAAAABwAAd/sgAAAAAAAAEAAHO7gAAAAAAAAAAABzmYAAAAAAAAAAAAMZyAAAAAAAAAAAADGMAAAAAAAAAAAAAAhAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"sylvia-atricapilla":{"w":93,"h":62,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/wAAAAAAAAAAAAB//wAAAAAAAAAAAAf//AAAAAAAAAHAAP//8AAAAAAAAH4AP///wAAAAAAAH/AH////AAAAAAAD//gf///8AAAAAAD//4AP/////AAAAB///AA//////gAAA///wAH//////+AA///4AA////////w///4AAD///////////4AAAf//////////4AAAD//////////4AAAAf/////////4AAAAB/////////4AAAAAP////////8AAAAAB/////////gAAAAAP////////4AAAAAB////////+AAAAAAP////////gAAAAAB/////////AAAAAAP/////////AAAAAA/////////+AAAAAH/////////wAAAAAf///////4AAAAAAD///////4AAAAAAAP//////+AAAAAAAA///////gAAAAAAAH//////4AAAAAAAAf//////AAAAAAAAB//////wAAAAAAAAH/////4AAAAAAAAAP////+AAAAAAAAAAf////gAAAAAAAAAA////wAAAAAAAAAAA///+AAAAAAAAAAAA//nwAAAAAAAAAAAP/gcAAAAAAAAAAAf9wGAAAAAAAAAAAH8ABgAAAAAAAAAAA/AAYAAAAAAAAAAAGwAGAAAAAAAAAAABEABgAAAAAAAAAAAAAAYcAAAAAAAAAAAEAGeAAAAAAAAAAAAAB+AAAAAAAAAAAAAA8AAAAAAAAAAAAAA/AAAAAAAAAAAAAAJ4AAAAAAAAAAAAAAaAAAAAAAAAAAAAAMwAAAAAAAAAAAAADMAAAAAAAAAAAAAAxgAAAAAAAAAAAAAEIAAAAAAAAAAAAABAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"sylvia-borin-2":{"w":93,"h":87,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAEeAAAAAAAAAAAAAA58AAAAAAAAAAAAAD3wAAAAAAAAAAAAAP/gAAAAAAAAAAAAC//AAAAAAAAAAAAAf/8AAAAAAAAAAAAB//4AAAAAAAAAAAAH//gAAAAAAAAAAAAP//AAAAAAAAAAAAD//8AAAAAAAAAAAAf//4AAAAAAAAAAAB///gAAAAAAAAAAAD//+AAAAAAAAAAAAf//8AAAAAAAAAAAD///wAAAAAAAAAAAP///AAAAAAAAAAAA///8AAAAAAAAAAAH///4AAAAAAAAAAAf///gAAAAAAAAAAB///+AAAAAAAAAAAP///4AAAAAAAAAAAf///gAAAAAAAAAAD///8AAAAAAAAAAAP///wAAAAAAAAAAAP//+AB8AAAAAAAAB///wB//gAAAAAAAH///Af/8AAAAAAAA///8P/+AAAAAAAAD///j//gAAAAAAAAf//+//8AAAAAAAAH//////AAAAAAAAAf/////4AAAAAAAAD/////+AAAAAAAAAP/////wAAAAAAAAD/////+AAAAAAAAAf/////gAAAAAAAAB/////8AAAAAAAAAP/////gAAAAAAAAB/////8AAAAAAAAAH//////8AAAAAAAA///////wAAAAAAAB///////AAAAAAAAP//////8AAAAAAAAf//////wAAAAAAAAP//////AAAAAAAAB//////8AAAAAAAAf//////wAAAAAAAD///////AAAAAAAAf//////8AAAAAAAH///////gAAAAAAA///////+AAAAAAAH///////4AAAAAAB////////gAAAAAAf///////+AAAAAAH////////4AAAAAB/////////AAAAAAf//7/////8AAAAAH/8/A/////wAAAAB/+H4AAL//+AAAAAf/g+AAAf//4AAAAH/8HAAAB///gAAAB//AAAAAD//8AAAAP/wAAAAAP//wAAAH/+AAAAAB///AAAA//gAAAAAB//4AAAP/4AAAAAAH//gAADw/AAAAAAA3/+AAAwHwAAAAAACb/wAAIA8AAAAAAABv3AACAHgAAAAAAAE3YAAgA4AAAAAAAADZgAIADAAAAAAAAABgAAAAQAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAIAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"sylvia-borin":{"w":93,"h":66,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/4AAAAAAAAAAAAP//wAAAAAAAAAAAD///+AAAAAAAAAAB////4AAAAAAAAAAf///8AAAAAAAAAAH///8AAAAAAAAAAA////AAAAAAAAAAAP///wAAAAAAAAAAP///+AAAAAAAAAAP////gAAAAAAAAAH////8AAAAAAAAAH/////AAAAAAAAAB/////4AAAAAAAAA//////AAAAAAAAA//////wAAAAAAAA//////+AAAAAAAAf//////wAAAAAAAP//////+AAAAAAAD///////wAAAAAAD///////8AAB////////////gAA////////////8AAD////////////gAA////////////4AAH////////////AAAP//5////////wAAAAAAA///////8AAAAAAAP///////gAAAAAAH///////4AAAAAAB///////+AAAAAAA////////gAAAAAAP///////4AAAAAABwB/////+AAAAAAAAAH/////AAAAAAAAAAf////wAAAAAAAAAA////4AAAAAAAAAAB///8AAAAAAAAAAAB//+AAAAAAAAAAAAZ/+AAAAAAAAAAAADAngAAAAAAAAAAAAOAHAAAAAAAAAAAAA4AOAAAAAAAAAAAABgA8AAAAAAAAAAAAGP/wAAAAAAAAAAAAaYPgAAAAAAAAAAABwA+AAAAAAAAAAAAHAHwAAAAAAAAAAAAcA4AAAAAAAAAAAABweAAAAAAAAAAAAf/BwAAAAAAAAAAAE4cOAAAAAAAAAAAAADwQAAAAAAAAAAAAAfEAAAAAAAAAAAAATwAAAAAAAAAAAAAB8AAAAAAAAAAAAAANAAAAAAAAAAAAAAD4AAAAAAAAAAAAAADAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tachybaptus-ruficollis-2":{"w":93,"h":80,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAAAAAAAAAAAAAAsAAAAAAAAAAAAAANoAAAAAAAAAAAAAD+AAAAAAAAAAAAAAf8AAAAAAAAAAAAAH/gAAAAEAAAAAAAB/8AAAADgAAAAAAAP/gAAAB4AAAAAAAD/8AAAA+4AAAAAAA//AAAAf+AAAAAAAH/8AAAP/gAAAAAAB//gAAD/7AAAAAAAP/4AAB//wAAAAAAD//AAAf/8AAAAAAAf/8AAP//AAAAAAAH//gAD//wAAAAAAA//4AA///gAAAAAAP//AAf//4AAAAAAB//4AH//+AAAAAAAf//AD///gAAAAAAD//wA///8AAAAAAA//+AP///AAAAAAAP//gH///4AAAAAAB//8B///+AAAAAAAP//Af///AAAAAAAB//4H///4AAAAAAAf/+B///+AAAAAAAD//4f///gAAAAAAAf//n///4AAAAAAAD//9///+AAAAAAAA///////gAAAAAAAD//////gAAAAAAAAf/////4AAAAAAAAB/////8AAAAAAHwAH/////wAAAAAH/4A/////+AAAAAD//gD/////wAAAAA///Af////+AAAAAP//8D/////wAAAAD///gf////+AAAAA///+D/////wAAAA////4f////8AAAAf////v/////gAAAHx/////////8AAAAAB/////////gAAAAAAD///////8AAAAAAAP///////AAAAAAAA///////4AAAAAAAH///////AAAAAAAAf//////4AAAAAAAD//////8AAAAAAAAf//////wAAAAAAAB///////AAAAAAAAP//////8AAAAAAAA///////wAAAAAAAD///////gAAAAAAAP///////8AAAAAAA////////4AAAAAAB////////AAAAAAAD///////wAAAAAAAB//////4AAAAAAAAH/////8AAAAAAAAAP/////AAAAAAAAAAf////wAAAAAAAAAA////8AAAAAAAAAAA////gAAAAAAAAAAAP/8OAAAAAAAAAAAAADg44AAAAAAAAAAAAMP+AAAAAAAAAAAAB/fAAAAAAAAAAAAAH7/AAAAAAAAAAAAAf//gAAAAAAAAAAAA//+AAAAAAAAAAAAB/ngAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tachybaptus-ruficollis":{"w":93,"h":77,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB/4AAAAAAAAAAAAA//wAAAAAAAAAAAAf//gAAAAAAAAAAAH//+AAAAAAAAAAAB///4AAAAAAAAAAAP///gAAAAAAAAAAD///8AAAAAAAAAAA////wAAAAAAAAAAP///+AAAAAAAAAAD////wAAAAAAAAAD////+AAAAAAAAAB/////wAAAAAAAAA/////+AAAAAAAAAP4H///wAAAAAAAAAAAP//+AAAAAAAAAAAAf//wAAAAAAAAAAAAf/+AAAAAAAAAAAAB//wAAAAAAAAAAAAf/+AAAAAAAAAAAAH//gAgAAAAAAAAAB//4f/+AAAAAAAAAf//f///AAAAAAAAH//////+AAAAAAAB///////8AAAAAAAf///////4AAAAAAH////////wAAAAAA/////////gAAAAAP////////+AAAAAB/////////8AAAAAP/////////wAAAAD//////////AAAAAf/////////+AAAAD//////////4PwAAf//////////n9AAD////////////4AAf///////////+AAD////////////wAAP///////////+AAB////////////gAAP///////////4AAA////////////AAAH///////////wAAAf//////////+AAAB///////////gAAAH//////////4AAAAf//////////gAAAB//////////8AAAAH//////////wAAAAH/////////wAAAAAP////////+AAAAAAf////////gAAAAAAf///////8AAAAAAB////////AAAAAAAf///////wAAAAAAH///////8AAAAAABH///////AAAAAAAI/P/////AAAAAAAAP4P////4AAAAAAABiAP////AAAAAAAAYQD////4AAAAAAACCA//wA+AAAAAAAAQAJ/gAAAAAAAAAAAAAP8AAAAAAAAAAAAAD/AAAAAAAAAAAAAA/wAAAAAAAAAAAAAH+AAAAAAAAAAAAABjgAAAAAAAAAAAAAIMAAAAAAAAAAAAADBgAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"tadorna-tadorna-2":{"w":93,"h":65,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAH4AAAAAAAAAAAAAP+AAAAAAAAAAAAAf/4AADAAAAAAAAAf/+AAAPwAAAAAAAf//wAAA/wAAAAAAf//8AAAD/wAAAAAf//+AAAAf/gAAAAP///wAAAB/+AAAAH///8AAAAH/8AAAD////AAAAAf/4AAD////wAAAAD//gAB////8AAAAAP/+AAf////AAAAAB//4AH////wAAAAAH//gB////8AAAAAA///Af///+AAABn+D//+H////gAAAf/+f//8////wAAAD//////3///8AAAAf/////////+AAAAB//////////gAAAAf/////////gAAAAP/////////8AAAAH//////////wAAAB/AB///////+AAAAAAAD///////wAAAAAAAP//////+AAAAAAAB///////gAAAAAAAH//////8AAAAAAAA///////gAAAAAAAH//////8AAAAAAAAf//////AAAAAAAAD//////4AAAAAAAAf//////AAAAAAAAB//////wAAAAAAAAP/////+AAAAAAAAA//////AAAAAAAAAH/////8AAAAAAAAAf/////gAAAAAAAAB/////8AAAAAAAAAH/////gAAAAAAAAAf////+AAAAAAAAAA/////4AAAAAAAAAD/////gAAAAAAAAAH////+AAAAAAAAAAf////4AAAAAAAAAA/////gAAAAAAAAAD////8AAAAAAAAAAP////wAAAAAAAAAAf////gAAAAAAAAAA///3/AAAAAAAAAAB//+P+AAAAAAAAAAB/+wf8AAAAAAAAAAB/jZ/gAAAAAAAAAAA8f/4AAAAAAAAAAAD7/+AAAAAAAAAAAAf/8AAAAAAAAAAAAA//4AAAAAAAAAAAAA//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tadorna-tadorna":{"w":93,"h":81,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+AAAAAAAAAAAAAAf8AAAAAAAAAAAAAP/4AAAAAAAAAAAAD//gAAAAAAAAAAAAf/+AAAAAAAAAAAAH//wAAAAAAAAAAAA///AAAAAAAAAAAAP//8AAAAAAAAAAAB///gAAAAAAAAAAAf//+AAAAAAAAAAAH///wAAAAAAAAAAD///+AAAAAAAAAAA////wAAAAAAAAAAf+P/+AAAAAAAAAAP+AP/wAAAAAAAAABmAB/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAP/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/wAAAAAAAAAAAAB/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAP/8AAAAAAAAAAAAD//gf/wAAAAAAAAAf/8///wAAAAAAAAH//////wAAAAAAAB///////4AAAAAAAP///////wAAAAAAD////////wAAAAAAf////////wAAAAAH/////////4AAAAA//////////wAAAAH//////////gAAAA///////////wAAAH///////////8AAA////////////wAAH///////////4AAA////////////4AAH////////////4AAf///////////+AAD///////////8AAAP///////////gAAB///////////+AAAH///////////8AAAf///////////8AAB////////////4AAH////////////AAAP///////////4AAAf/////////n+AAAA////////+ABAAAAB////////AAAAAAAB///////AAAAAAAAB//////wAAAAAAAAD/////8AAAAAAAAAf////4AAAAAAAAAP////AAAAAAAAAAD/8AA4AAAAAAAAAA//gAGAAAAAAAAAAAf8AAwAAAAAAAAAAD/gAOAAAAAAAAAAAOMABwAAAAAAAAAABAAAfAAAAAAAAAAAIAAPgAAAAAAAAAAAAH/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAB/8AAAAAAAAAAAAAP/gAAAAAAAAAAAAB/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/4AAAAAAAAAAAABB+AAAAAAAAAAAAAAHgAAAAAAAAAAAAAAcAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"thalasseus-sandvicensis-2":{"w":74,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAABgAAAAAAAAAABgAAAAAAAAAAB4AAAAAAAAAAA8AAAAAAAAAAA+AAAAAAAAAAA/AAAAAAAAAAAfgAAAAAAAAAAfwAAAAAAAAAAP4AAAAAAAAAAP+AAAAAAAAAAH/AAAAAAAAAAD/gAAAAAAAAAB/wAAAAAAAAAB/4AAAAAAAAAB/+AAAAAAAAAA//AAAAAAAAAAf/gAAAAAAAAAP/4AAAAAAAAAP/8AAAAAAAAAD/8AAAAAAAAAB//AAAAAAAAAA//gAAAAAAAAAf/wAAAAAAAAAP/+AAAAAAAAAD//gAAAAAAAAA//4AAAAAAAAAH//AAAAAAAAAA//wAAAAAAAAAH/+AAAAAAAAAA//gAAAAAAAAAP/4AAAAAAAAAD/+AAAAAAAAAA//gAAAAAAAAAP/4AAAAAAAAAD/+AAAAAAAAAB//gAAAAAAAAA//4AAAAAAAP///+AAAAAAAP////gAAAAAAH////4AAAAAAf4D///gAAAAA/4Af//+AADAB/AAB/////+AAAAAAP////4AAAAAAB////wAAAAAAAP///8AAAAAAAD////gAAAAAAAf///8AAAAAAAH/78fwAAAAAAD/+AAPgAAAAAA//gAAHAAAAAAP/4AAAAAAAAAH/+AAAAAAAAAD//AAAAAAAAAA//wAAAAAAAAAf/4AAAAAAAAAH/+AAAAAAAAAB//AAAAAAAAAAf/wAAAAAAAAAD/4AAAAAAAAAA/+AAAAAAAAAAH/gAAAAAAAAAB/8AAAAAAAAAAP/gAAAAAAAAAD/4AAAAAAAAAAf+AAAAAAAAAAD/wAAAAAAAAAAf8AAAAAAAAAAD/gAAAAAAAAAAf4AAAAAAAAAAD/AAAAAAAAAAA/wAAAAAAAAAAH8AAAAAAAAAAA/gAAAAAAAAAAH4AAAAAAAAAAA/AAAAAAAAAAAH4AAAAAAAAAAA+AAAAAAAAAAAHgAAAAAAAAAAA8AAAAAAAAAAADgAAAAAAAAAAAcAAAAAAAAAAADAAAAAAAAAAAAYAAAAAAAAAAABAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"thalasseus-sandvicensis":{"w":93,"h":57,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8AAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/wAAAAAAAAAAAAH//AAAAAAAAAAAAB//8AAAAAAAAAAAAf//+AAAAAAAAAAAD////AAAAAAAAAAA/////AAAAAAAAAAH//+f/AAAAAAAAAA///AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAAP//gAAAAAAAAAAAH//+AAAAAAAAAAAD///wAAAAAAAAAAB///+AAAAAAAAAAA////4AAAAAAAAAAf////AAAAAAAAAAP////4AAAAAAAAAD/////AAAAAAAAAA/////4AAAAAAAAAf////8AAAAAAAAAH/////AAAAAAAAAB/////gAAAAAAAAAf////8AAAAAAAAAH/////gAAAAAAAAH/////4AAAAAAAAD/////+AAAAAAAAB//////wAAAAAAAAf/////8AAAAAAAAD//////AAAAAAAAD//////wAAAAAAAH//////8IAAAAAH////////AAAAAD/////////wAAAAA/////////4AAAAAAD////////AAAAAAAAH//////yAAAAAAAH////B//AAAAAAAP////AD/gAAAAAAP////gAf8AAAAAAP/4D/4AB/AAAAAAAAAB/+AAc4AAAAAAAAA//AABjAAAAAAAAAf/gAAMYAAAAAAAAPPwAAAhAAAAAAAAGB4AAAGMAAAAAAADAcAAAARgAAAAAABgMAAAACEAAAAAAAACAAAAAfxAAAAAAABAAAAAF/+AAAAAAAAAAAAADfwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tringa-nebularia-2":{"w":80,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAABQAAAAAAAAAAAA9AAAAAAAAAAAAOwAAAAAAAAAAAH4AAAAAAAAAAAD8AAAAGAAAAAAA/wAAAHYAAAAAAf4AAAH8AAAAAAP+AAAD+gAAAAAD/wAAD/4AAAAAB/8AAD/4AAAAAAf+AAB/+AAAAAAP/gAB//gAAAAAH/4AA//wAAAAAB/+AA//4AAAAAA//gAf/+AAAAAAP/4AP//AAAAAAH/+AP//gAAAAAB//AH//4AAAAAA//wH//8AAAAAAP/8D//+AAAAAAH//B///gAAAAAB//g///wAAAAAA//4f//4AAAAAAP/8f//8AAAAAAH//n///AAAAAAB//////AAAAAAAf/////wAAAAAAH/////4AAAAAAB/////4AAAAAAAf////4AAAAAAAH/////AAAAAAAAf////wAAAAAAAD////8AAAAAAAAf////AAAAAAAAD////wAAAAAAAA////8AAAAAAH8H////AAAAAAH/h////wAAAAAB/+f///8AAAAAB///////AAAAAD///////gAAAAP///////4AAAA/gP/////+AAAB4AA//////gAAAAAAD/////4AAAAAAA/////+AAAAAAAH/////AAAAAAAB/////4AAAAAAAP////+AAAAAAAD/////wAAAAAAAf////+AAAAAAAD/////AAAAAAAAf////8AAAAAAAB/////gAAAAAAAHf///+AAAAAAAAT////4AAAAAAAAf////wAAAAAAAH/////AAAAAAAAP////4AAAAAAAA////+AAAAAAAAD/8AHAAAAAAAAAf8AAAAAAAAAAAA/gAAAAAAAAAAADsAAAAAAAAAAAANgAAAAAAAAAAAB8AAAAAAAAAAAAPgAAAAAAAAAAAB4AAAAAAAAAAAALAAAAAAAAAAAACQAAAAAAAAAAAA2AAAAAAAAAAAAEgAAAAAAAAAAABIAAAAAAAAAAAAbAAAAAAAAAAAACQAAAAAAAAAAAAmAAAAAAAAAAAAEgAAAAAAAAAAABMAAAAAAAAAAAAZgAAAAAAAAAAAD+AAAAAAAAAAAA3AAAAAAAAAAAAGYAAAAAAAAAAAAzAAAAAAAAAAAAOYAAAAAAAAAAABjAAAAAAAAAAAAEQAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tringa-nebularia":{"w":86,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAAAAAAAAAAH/AAAAAAAAAAAAD/4AAAAAAAAAAAB//AAAAAAAAAAAA//wAAAAAAAAAAAP/+AAAAAAAAAAAH//gAAAAAAAAAAP//4AAAAAAAAAAP//+AAAAAAAAAAfz//wAAAAAAAAA/AH/8AAAAAAAAB8AA//AAAAAAAAA4AAP/wAAAAAAAAAAAD/+AAAAAAAAAAAA//wAAAAAAAAAAAP//wAAAAAAAAAAH///gAAAAAAAAAB////AAAAAAAAAAf///+AAAAAAAAAH////4AAAAAAAAB/////gAAAAAAAAf////+AAAAAAAAH/////wAAAAAAAB//////AAAAAAAAf/////4AAAAAAAH//////AAAAAAAB//////4AAAAAAAP//////AAAAAAAD//////4AAAAAAAf//////AAAAAAAH//////4AAAAAAA///////gAAAAAAH//////8AAAAAAB///////gAAAAAAP//////8AAAAAAB///////gAAAAAAP//////8AAAAAAB///////gAAAAAAP//////8AAAAAAB///////gAAAAAAH//////8AAAAAAA///////wAAAAAAD///////AAAAAAAP//////8AAAAAAA///////wAAAAAAP//////AAAAAAAB///8D/4AAAAAAAP//4AB/AAAAAAAB/4AAAH4AAAAAAAP8AAAAYAAAAAAAB/AAAAAAAAAAAAAbgAAAAAAAAAAAACIAAAAAAAAAAAAAzAAAAAAAAAAAAAMQAAAAAAAAAAAABGAAAAAAAAAAAAAZgAAAAAAAAAAAAGMAAAAAAAAAAAABjAAAAAAAAAAAAAY4AAAAAAAAAAAAGMAAAAAAAAAAAABjAAAAAAAAAAAAAYwAAAAAAAAAAAAGMAAAAAAAAAAAABDAAAAAAAAAAAAAQwAAAAAAAAAAAAEMAAAAAAAAAAAADCAAAAAAAAAAAAAwgAAAAAAAAAAAAMIAAAAAAAAAAAADCAAAAAAAAAAAAAggAAAAAAAAAAAAIYAAAAAAAAAAAACGAAAAAAAAAAAABhgAAAAAAAAAAAAYYAAAAAAAAAAAOfGAAAAAAAAAAAAfpgAAAAAAAAAAAOwYAAAAAAAAAAD+IPgAAAAAAAAAAQP/AAAAAAAAAAAAGDwAAAAAAAAAAACBMAAAAAAAAAAAABiAAAAAAAAAAAADhgAAAAAAAAAAABgQAAAAAAAAAAAAAMAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"tringa-ochropus-2":{"w":93,"h":88,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAD/AAAAAAAAAAAAAD/4AAAAAAAAAAAAD/8AAAAAAAAAAAAB//gAAAAAAAAAAAA//8AAAAAAAAAAAAf/+AEAAAAAAAAAAP//gA+AAAAAAAAAH//8AD4AAAAAAAAD///AAf4AAAAAAAB///wAB/gAAAAAAA///8AAP/AAAAAAAf///AAA/+AAAAAAP///wAAD/4AAAAAD///8AAAf/wAAAAB////AAAB//AAAAAf///wAAAH/+AAAAH///8AAAAf/4AAAD////AAAAB//wAAA////wAAAAP//AAAP///4AAAAA//8AAB///+AAAAAD//wAAf///gAAAAAP//AAD///wAAAAAA//+AAf//8AAAAAAD//8AD//+AAAAAAAP//wA///wAAAAAAB///gH///AAAAAAAD//+A///wAAAAAAAP//8H///AAAAAAAAf//w///4AAAAAAAAf//P//+AAAAAAAAD//9///wAAAAAAAB//////+AAAAAAAAf//////wAAAAAAAH//////+AAAAAAAB///////wAAAAAAAP//////+AAAAAAAB///////wAAAAAAAf//////8AAAAAAAH///////gAAAAAAD///////8AAAAAAB8P//////gAAAAAAcAf/////8AAAAAAOAB//////gAAAAAHAAH/////+AAAAABgAA//////wAAAAAAAAD//////AAAAAAAAAf/////4AAAAAAAAB//////AAAAAAAAAH/////8AAAAAAAAAP/////wAAAAAAAAAf/////gAAAAAAAAA/////+AAAAAAAAAB/////4AAAAAAAAAH/////4AAAAAAAAAP/////8AAAAAAAAAf/////+AAAAAAAAAP/////8AAAAAAAAAf////+AAAAAAAAAA/////wAAAAAAAAAA+P//+AAAAAAAAAAA43//gAAAAAAAAAADDf/8AAAAAAAAAAAIb//AAAAAAAAAAABhP/4AAAAAAAAAAAMM/8AAAAAAAAAAAAhgAAAAAAAAAAAAAEEAAAAAAAAAAAAAAwwAAAAAAAAAAAAACGAAAAAAAAAAAAAAQQAAAAAAAAAAAAADDAAAAAAAAAAAAAAMfAAAAAAAAAAAAAB5gAAAAAAAAAAAAAMOAAAAAAAAAAAAAA48AAAAAAAAAAAAADzwAAAAAAAAAAAAAPPAAAAAAAAAAAAAA84AAAAAAAAAAAAABhgAAAAAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tringa-ochropus":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAD/gAAAAAAAAAAAAA/+AAAAAAAAAAAAAP/4AAAAAAAAAAAAD//gAAAAAAAAAAAA//8AAAAAAAAAAAAP//gAAAAAAAAAAAB//8AAAAAAAAAAAAf//gAAAAAAAAAAH///+AAAAAAAAAH/////wAAAAAAAAP//////gAAAAAAAP//////+AAAAAAAP//////x4AAAAAAP//////8HwAAAAAP///////APAAAAAf///////4A8AAD//////////ABwAD//////////4AHgAf//////////AAOAA//////////4AA4AD//////////AABgP//////////4AAHA//////////+AAAID//////////wAAAAAf////////8AAAAAAP////////AAAAAAAP///////wAAAAAAAP//////0AAAAAAAAf//////AAAAAAAAB//////wAAAAAAAAD/////4AAAAAAAAAG////+AAAAAAAAAAR//+HAAAAAAAAAAAn/8AgAAAAAAAAAAB//AAAAAAAAAAAAAB/4AAAAAAAAAAAAAD/gAAAAAAAAAAAAAf4AAAAAAAAAAAAAD+AAAAAAAAAAAAAA/gAAAAAAAAAAAAAP4AAAAAAAAAAAAAA//AAAAAAAAAAAAAA//+AAAAAAAAAAAAGAD4AAAAAAAAAAAAwAfgAAAAAAAAAAAHAGeAAAAAAAAAAAAwAxwAAAAAAAAAAADAEOAAAAAAAAAAAAYABQAAAAAAAAAAADAAaAAAAAAAAAAAAIACQAAAAAAAAAAABgASAAAAAAAAAAAAMAAwAAAAAAAAAAAAgAGAAAAAAAAAAAAGAAgAAAAAAAAAAAAwAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAYAAAAAAAAAAAAAADAAAAAAAAAAAAAAA8HAAAAAAAAAAAAA7/gAAAAAAAAAAAAAPgAAAAAAAAAAAAAA3wAAAAAAAAAAAAAGH4AAAAAAAAAAAAAYAAAAAAAAAAAAAABgAAAAAAAAAAAAAAGAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tringa-totanus-2":{"w":84,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFgAAAAAAAAAAAAFAAAAAAAAAAAAAPQAAAAAAAAAAAAPQAAAAAAAAAAAAfwAAAAAAAAAAAAfwAAAAAAAAAAAA/4AAAAAAYAAAAA/4AAAAADwAAAAA/4AAAAAPgAAAAB/+AAAAB/YAAAAB/+AAAAH/wAAAAD/8AAAAf/gAAAAD/8AAAB/+AAAAAD/+AAAH//gAAAAD/+AAAf//AAAAAH/+AAA//+AAAAAH/+AAD//8AAAAAH//AAP//4AAAAAP//AAf//4AAAAAP/+AB///4AAAAAP/+AD///gAAAAAP//AH///AAAAAAP/+Af///AAAAAAP/+B///+AAAAAAf/+D///8AAAAAAf//H///4AAAAAAf//P///4AAAAAAf//////wAAAAAAf//////AAAAAAAf/////+AAAAAAAf/////8AAAAAAAP/////wAAAAAAAH/////AAAAAAAAD/////gAAAAAAAB/////gAAAAAAAA/////gAAAAAADgf////gAAAAAAf8f////AAAAAAA/+f////gAAAAAB///////AAAAAAB///////AAAAAAD///////AAAAAAH///////AAAAAAf///////AAAAAB///////+AAAAAHwP/////+AAAAAeAD/////+AAAAB4AB/////+AAAAHAAB/////+AAAAMAAA/////8AAAAAAAA/////8AAAAAAAAf////+AAAAAAAAf////+AAAAAAAAP/////AAAAAAAAH/////AAAAAAAAB/////AAAAAAAAA/////gAAAAAAAAP////wAAAAAAAAH////8AAAAAAAAD////+AAAAAAAAA/////gAAAAAAAAP////8AAAAAAAAB/////gAAAAAAAA/////gAAAAAAAAf/wf/gAAAAAAAAH/gP/AAAAAAAAAAfwD/AAAAAAAAAAG4A8AAAAAAAAAADYAcAAAAAAAAAADIAAAAAAAAAAAABIAAAAAAAAAAAABMAAAAAAAAAAAABEAAAAAAAAAAAABkAAAAAAAAAAAAAmAAAAAAAAAAAAAmAAAAAAAAAAAAAzAAAAAAAAAAAAAzwAAAAAAAAAAAATQAAAAAAAAAAAAfgAAAAAAAAAAAAY4AAAAAAAAAAAAMcAAAAAAAAAAAAHOAAAAAAAAAAAADnAAAAAAAAAAAABjAAAAAAAAAAAAAwAAAAAAAAAAAAAQAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"tringa-totanus":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPgAAAAAAAAAAAAA/4AAAAAAAAAAAAB/8AAAAAAAAAAAAD/+AAAAAAAAAAAAH//AAAAAAAAAAAAH//AAAAAAAAAAAAP//gAAAAAAAAAAAf//gAAAAAAAAAAA///gAAAAAAAAAAD///gAAAAAAAAAAP///wAAAAAAAAAA+A//wAAAAAAAAAD4Af/wAAAAAAAAAPAAf/wAAAAAAAAA8AA//4AAAAAAAADwAA//8AAAAAAAAHAAA///wAAAAAAAEAAB////AAAAAAAAAAB////4AAAAAAAAAB/////AAAAAAAAAD/////wAAAAAAAAD/////8AAAAAAAAD/////+AAAAAAAAD//////gAAAAAAAD//////wAAAAAAAD//////8AAAAAAAD//////+AAAAAAAB///////AAAAAAAB///////gAAAAAAB///////wAAAAAAA///////4AAAAAAA///////8AAAAAAA////////AAAAAAAf///////gAAAAAAP///////wAAAAAAP///////4AAAAAAH///////8AAAAAAD////////AAAAAAB////////gAAAAAA////////4AAAAAAf///////+AAAAAAP////////gAAAAAH///////5wAAAAAB///////+AAAAAAA////////gAAAAAAP///////gAAAAAAD///////wAAAAAAA////wP/4AAAAAAAf//+AA/8AAAAAAAP//wAAH4AAAAAAAH//wAAAwAAAAAAAD//8AAAAAAAAAAA///8AAAAAAAAAAD///wAAAAAAAAAAD4eAAAAAAAAAAAAHwMAAAAAAAAAAAAPQOAAAAAAAAAAAAOQGAAAAAAAAAAAAOQGAAAAAAAAAAAAOADAAAAAAAAAAAAeADgAAAAAAAAAAAaADgAAAAAAAAAAALADgAAAAAAAAAAAMADAAAAAAAAAAAAEADAAAAAAAAAAAAAADAAAAAAAAAAAAAADAAAAAAAAAAAAAADAAAAAAAAAAAAAADAAAAAAAAAAAAAADAAAAAAAAAAAAAACAAAAAAAAAAAAAACAAAAAAAAAAAAAACAAAAAAAAAAAAAAGAAAAAAAAAAAAAAGAAAAAAAAAAAAAAGAAAAAAAAAAAAAAGAAAAAAAAAAAAAAHAAAAAAAAAAAAAAHgAAAAAAAAAAAAP+wAAAAAAAAAAAAB+AAAAAAAAAAAAAB8AAAAAAAAAAAAB+IAAAAAAAAAAAAPgYAAAAAAAAAAAAAAwAAAAAAAAAAAAABgAAAAAAAAAAAAAGAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"troglodytes-troglodytes-2":{"w":93,"h":92,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAEGAAAAAAAAAAAAABhgAAAAAAAAAAAAAMcIAAAAAAAAAAAADHDAAAAAAAAAAAAA55wAAAAAAAAAAAAGecAAAAAAAAAAAAB/ngAAAAAAAAAAAAf/4AAAAAAAAAAAAH/+MAAAAAAAAAAAA//3AAAAAAAAAAAAP/9wAAAAAAAAAAAD//+AAAAAAAAAAAA///gAAAAAAAAAAAH//4AAAAAAAAAAAB//+wAAAAAAAAAAAf//+AAAAAAAAAAAH///gAAAAAAAAAAB///4AAAAAAAAAAAP//+AAAAAAAAAAAH///gAAAAAAAAAAB////AAAAAAAAAAAP///4AAAAAAAAAAD///+AAAAAAAAAAA////gAAAAAAAAAAP///4AAAAAAAAAAD////gAAAAAAAAAA////4AAAAAAAAAAP///+AAAAAAAAAAD////gAAAAAAAAAA////4AAAAAAAHwAH///+AAAAAAAP/wB////gAAAAAAD//gP///4AAAAAAB///D///+AAAAAAAf///////4AAAAAAH////////AAAAAAP////////4AAAAAH/////////AAAAAB/////////8AAAAAAH////////gAAAAAAf///////4AAAAAAB////////gAAAAAAH///////8AAAAAAAf///////gAAAAAAD///////4AAAAAAAP///////gAAAAAAA///////8AAAAAAAD///////AAAAAAAAf//////4AAAAAAAD//////+AAAAAAAB///////gAAAAAAAf//////gAAAAAAAP//////+AAAAAAAB///////4AAAAAAAf///////gAAAAAAH///////8AAAAAAB////////wAAAAAAP///////+AAAAAAD////////4AAAAAA/////////gAAAAAP////////8AAAAAD/////////wAAAAA//////////AAAAAH/////////8AAAAB//////////wAAAAf/////z/d//AAAAH/////8BzD/8AAAB//////AcwP/wAAAf/////wGMB//AAAH/////4BhAH/4AAB////6QAYQAf/gAAf///+AAH/+D/8AAH////AABx4AP/gAD////wAAOMAA/+AA////4AABxwAB/wAP////AAAPOAAF4AH////wAABkoAAEAB////4AAAG2gAAAAf///+AAAAozgAAAPP//+wAAAGzAAAAAD3//kAAAAQMAAAAA57/cAAAAAAQAAAAMedzAAAAAAAAAAAADnMQAAAAAAAAAAAAwxAAAAAAAAAAAAAAMQAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"troglodytes-troglodytes":{"w":93,"h":80,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAAAAB//wAAAAAAAAAAAA///gAAAAAAAAAAAf///AAAAAAAAAAAH///8AAAAAAAAAAB////4AAAAAAAAAAf////gAAAAAAAAAP////+AAAAAAAAAf/////8AAAAAAAAf//////8AAAAAAAH///////+AAAAAAAB///////+AAAAAAAD///////8AAAAAAAP///////4AAAAAAA////////wAAAAAAH////////gAAAAAAf///////+AAAAAAB////////4AAAAAAP////////wAAAAAB/////////gAAAAAH////////+AAAAAA/////////4AAAAAD/////////AAAAAAf////////8AAAAAD/////////wAAAAAP/////////AAAAAB/////////8AAAAAP/////////gAAAAA/////////+AAAAAH/////////8AAAAA//////////wAAAAD/////////+AAAAAf/////////gAAAAB/////////+AAAAAP/////////4AAAAA//////////AAAAAD////////8AAAAAAP////////wAAAAAA////////+AAAAAAD////////4AAAAAAP////////AAAAAAAf///////8AAAAAAB////////gAAAAAAH///////8AAAAAAAf///////wAAAAAAA///////+AAAAAAAB/////H/4AAAAAAAB////wP/gAAAAAAAD///wAf8AAAAAAAAA//8AA/wAAAAAAAAAA/AAH/AAAAAAAAAAPAAAf8AAAAAAAAADgAAD/gAAAAAAAAB4AAAP+AAAAAAAAAcAAAA/4AAAAAAAAPAAAAD/AAAAAAAADwAAAAf8AAAAAAAB4AAAAB/wAAAAAAAeAAAAAD+AAAAAAAPg+AAAAP4AAAAAAD//4AAAA/AAAAAAA/4YgAAAD8AAAAAAPgAAAAAABgAAAAAD4AAAAAAAAAAAAAD+AAAAAAAAAAAAAAfgAAAAAAAAAAAAAH4AAAAAAAAAAAAAA+AAAAAAAAAAAAAAHgAAAAAAAAAAAAAA8AAAAAAAAAAAAAAPAAAAAAAAAAAAAABIAAAAAAAAAAAAAAIwAAAAAAAAAAAAABAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"turdus-iliacus-2":{"w":93,"h":55,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAADwAAAAAAAAAAAAAH4gAAAAAAAAAAAAP/4AAAAAAAAAAAAP/8AAAAAAAAAAAAP//AAAAAAAAAAAAP//+AAAAAAAAAAAH///AAAAAAAAAAAH///wAAAAAAB4AAD///+AAAAAAA/4AB////AAAAAAAf/gAf///wAAAAAA//+AP///+AAAAAAB//4D////AAAAAAAD//h////wAAAAAAAP//////4AAAAAAAA//////8AAAAAAA+H//////AAAAAAH////////AAAAAB/////////wAAAAH/////////+AAAAf//////////wAAAH//////////+AAAAH//////////gAAAB//////////4AAAAAf/////////AAAAADf////////wAAAAAAv///////8AAAAAAAH///////AAAAAAAAAD/////AAAAAAAAAAf////8AAAAAAAAAA/////gAAAAAAAAAC////+AAAAAAAAAAC////4AAAAAAAAAAAD///AAAAAAAAAAAAH//4AAAAAAAAAAAAf//gAAAAAAAAAAAAf/8AAAAAAAAAAAAB//wAAAAAAAAAAAAD//AAAAAAAAAAAAAe/8AAAAAAAAAAAAEj/4AAAAAAAAAAABMf/gAAAAAAAAAAAZj/+AAAAAAAAAAAD9P/4AAAAAAAAAAAZh//wAAAAAAAAAABmH/+AAAAAAAAAAAMw//gAAAAAAAAAAAyH/wAAAAAAAAAAAAAfgAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"turdus-iliacus":{"w":93,"h":74,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAA/+AAAAAAAAAAAAAf/8AAAAAAAAAAAAH//wAAAAAAAAAAAB///AAAAAAAAAAAAf///wAAAAAAAAAAH////gAAAAAAAAAB////wAAAAAAAAAAf///wAAAAAAAAAAH///4AAAAAAAAAAA////AAAAAAAAAAAP///wAAAAAAAAAAD///+AAAAAAAAAAB////gAAAAAAAAAB////8AAAAAAAAAA/////gAAAAAAAAAf////4AAAAAAAAAP/////AAAAAAAAAH/////4AAAAAAAAB//////AAAAAAAAB//////4AAAAAAAA///////AAAAAAAAf//////4AAAAAAAP///////AAAAAAAH///////4AAAAAAB///////+AAAAAAAf///////wAAAAAAH///////+AAAAAAB////////wAAAAAA////////+AAAAAAf////////wAAAAAP////////8AAAAAD/////////gAAAABz////////4AAAAAA/////////AAAAAAf////////wAAAAAP////////+AAAAAD/////////gAAAAA/////////8AAAAAP/////////AAAAAH/4B//////wAAAAD/4AD/////8AAAAB//IYf/////gAAAA//AAj/////4AAAAf/gACP////8AAAAP/wAAE/////AAAAD/4AAAb////wAAAA/8AAAA////4AAAAH+AAAAB///8AAAAB/AAAAAP//+AAAAADgAAAAD//8AAAAAAAAAAAAPHwAAAAAAAAAAAABgOAAAAAAAAAAAAAGAOAAAAAAAAAAAAAQAcAAAAAAAAAAAADAA4AAAAAAAAAAAAMD/4AAAAAAAAAAAAgAP8AAAAAAAAAAAGAA34AAAAAAAAAAAYADcAAAAAAAAAAABgAIwAAAAAAAAAAP+AAjAAAAAAAAAAAf/ACIAAAAAAAAAAAD/AAAAAAAAAAAAAAbgAAAAAAAAAAAAABnAAAAAAAAAAAAAAGMAAAAAAAAAAAAAAQQAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"turdus-merula-2":{"w":93,"h":84,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAfAAAAAAAAAAAAAA/wAAAAAAAAAAAAAf+AAAAAAAAAAAAAf/AAAAAAAAAAAAAP/wAAAAAAAAAAAAP/8AAAAAAAAAAAAH//AAAAAAAAAAAAD//wAAAAAAAAAAAB//4AAAAAAAAAAAAf/+AAAAAAAAAAAAP//wAAAAAAAAAAAH//8AAAAAAAAAAAB//+AAAAAAAAAAAA///gAAAAAAAAAAAf//4AAAAAAAAAAAP//+AAAAAAAAAAAD///wAAAAAAAAAAB///4AAAAAAAAAAA///8AAAAAAAAAAAP///AAAAAAAAAAAH///wAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAH///4AAAAAAAAAAB////AAAAAAAAAAAf///8AAAAAAAAAAH////gAAAAAAAAAA////8AAAAAAAAAAH////wAAAAAAAAAA////+AAAAAAAAAAD////wAAAAAAAAAAP///+AAAAAAAAAeA////wAAAA/4AAf/////8AAB//wAAP//////gAf/+AAAD//////+D//4AAAB//////////8AAAB//////////+AAAA///////////gAAAH//////////wAAAAA/////////+AAAAAD/////////8AAAAAH/////////4AAAAAf/////////wAAAAB//////////8AAAAH//////wA///+AAAP/////8gAAAAAAAA/////+4AAAAAAAAB//////AAAAAAAAAH////+WAAAAAAAAAH/////gAAAAAAAAAf////wAAAAAAAAAH////gAAAAAAAAAA////8AAAAAAAAAAH////gAAAAAAAAAAf///4AAAAAAAAAAD////AAAAAAAAAAAP///+AAAAAAAAAAA////4AAAAAAAAAAB////gAAAAAAAAAAH////AAAAAAAAAAAf///8AAAAAAAAAAAf///wAAAAAAAAAAB////gAAAAAAAAAAD///+AAAAAAAAAAAH///wAAAAAAAAAAAH///gAAAAAAAAAAAP//+AAAAAAAAAAAAf//8AAAAAAAAAAAA///gAAAAAAAAAAAB//+AAAAAAAAAAAAD//8AAAAAAAAAAAAH//wAAAAAAAAAAAAH/+AAAAAAAAAAAAAP/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAAH+AAAAAAAAAAAAAAH4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"turdus-merula":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAAAAAAAAAAAH/gAAAAAAAAAAAAf/+AAAAAAAAAAAAf//4AAAAAAAAAAAP///gAAAAAAAAAAAP//+AAAAAAAAAAAAP//4AAAAAAAAAAAA///AAAAAAAAAAAAD//8AAAAAAAAAAAAP//wAAAAAAAAAAAB///AAAAAAAAAAAAP//8AAAAAAAAAAAA///wAAAAAAAAAAAH///wAAAAAAAAAAA////gAAAAAAAAAAD////AAAAAAAAAAAf///+AAAAAAAAAAD////4AAAAAAAAAAf////wAAAAAAAAAD/////AAAAAAAAAAf////8AAAAAAAAAD/////4AAAAAAAAAf/////wAAAAAAAAD//////AAAAAAAAAP/////+AAAAAAAAB//////4AAAAAAAAP//////wAAAAAAAA///////gAAAAAAAH///////gAAAAAAA////////AAAAAAAD////////AAAAAAAP////////wAAAAAB/////////8AAAAAH/////////+AAAAAf//////////AAAAB///////////AAAAH//////////+AAAAf//////w///4AAAB//////AAf//gAAAH/////gAAH/4AAAAP////+AAAD+AAAAAf////4AAAAAAAAAA/////gAAAAAAAAAA////8AAAAAAAAAAB///8wAAAAAAAAAAP/D/wAAAAAAAAAAAz4D/AAAAAAAAAAAMPAD4AAAAAAAAAADB4AHgAAAAAAAAAAQGAAMAAAAAAAAAAEBgAAAAAAAAAAAABgMAAAAAAAAAAAAAYDAAAAAAAAAAAAAGAQAAAAAAAAAAAAD/2AAAAAAAAAAAAf8BgAAAAAAAAAAAC/AIAAAAAAAAAAAAdgDAAAAAAAAAAAAMYA/wAAAAAAAAAABEAf8AAAAAAAAAAAAj/gAAAAAAAAAAAAAB8AAAAAAAAAAAAAB7AAAAAAAAAAAAAAYwAAAAAAAAAAAAAMMAAAAAAAAAAAAABCAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"turdus-migratorius-2":{"w":93,"h":78,"bits":"AAAAAAAAAAAAAACAAAAAAAAAAAAAAAgAAAAAAAAAAAAAAcQAAAAAAAAAAAAAHGAAAAAAAAAAAAAB7gAAAAAAAAAAAAA/9AAAAAAAAAAAAAP/4AAAAAAAAAAAAD/+gAAAAAAAAAAAB//mQAAAAAAAAAAAf/9aAAAAAAAAAAAP//x4AAAAAAAAAAD//8PAAAAAAAAAAB///k8AAAAAAAAAAf//4zwAAAAAAAAAH///j/AAAAAAAAAD///4P+AAAAAAAAA///+A/4AAAAAAAAf///gD/wAAAAAAAH///8B//gAAAAAAD////gH/+AAAAAAA////4Af/8AAAAAAf///+AB//8AAAAAH////gAD//4B/wAA////4AAP//w//gAP////AAH/////+AH////wAAf/////4B////8AAA//////gP////AAAD/////+D////wAAAH//////////8AAAD//////////+AAAAP//////////gAAAAf/////////8AAAAA//////////gAAAAH/////////8AAAAAP/////////gAAAAAf////////8AAAAAA/////////gAAAAAD////////8AAAAAAP////////gAAAAAB////////4AAAAAAD////////AAAAAAAf///////4AAAAAAD///////+AAAAAAAP///////wAAAAAAB///////+AAAAAAAH///////AAAAAAAAP//////4AAAAAAAB/////+AAAAAAAAAD/////4AAAAAAAAAP/////AAAAAAAAAAA////8AAAAAAAAAAD////gAAAAAAAAAAP///+AAAAAAAAAAA////4AAAAAAAAAAD////AAAAAAAAAAAP///8AAAAAAAAAAAf///gAAAAAAAAAAH////AAAAAAAAAAA////8AAAAAAAAAAH////wAAAAAAAAAA3mH//AAAAAAAAAAGMQf/+AAAAAAAAAAZwD//4AAAAAAAAABCAf//gAAAAAAAAAAAB///AAAAAAAAAAAAP//8AAAAAAAAAAAB///4AAAAAAAAAAAP///gAAAAAAAAAAA///+AAAAAAAAAAAH///wAAAAAAAAAAA///8AAAAAAAAAAAD///gAAAAAAAAAAAf//8AAAAAAAAAAAD///AAAAAAAAAAAAP//gAAAAAAAAAAAB//AAAAAAAAAAAAAA/wAAA=="},"turdus-migratorius":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAB/4AAAAAAAAAAAAP/+AAAAAAAAAAAAf//gAAAAAAAAAAB////AAAAAAAAAAD////8AAAAAAAAAD////+AAAAAAAAAH////4AAAAAAAAAP////gAAAAAAAAAP///8AAAAAAAAAAf///4AAAAAAAAAA////4AAAAAAAAAA////wAAAAAAAAAB////wAAAAAAAAAB////gAAAAAAAAAD////AAAAAAAAAAD////AAAAAAAAAAH///+AAAAAAAAAAH///+AAAAAAAAAAP///+AAAAAAAAAAf///+AAAAAAAAAB////+AAAAAAAAAD////+AAAAAAAAAP////+AAAAAAAAAf/////AAAAAAAAA//////AAAAAAAAB//////AAAAAAAAD//////AAAAAAAAH//////gAAAAAAAP//////gAAAAAAAf//////gAAAAAAA///////gAAAAAAB///////gAAAAAAD///////gAAAAAAD///////gAAAAAAH///////gAAAAAAP///////gAAAAAAP///////gAAAAAAf///////gAAAAAA////////AAAAAAB////////AAAAAAD////////AAAAAAD////////AAAAAAH///////+AAAAAAP///////+AAAAAAP///////8AAAAAAf///////8AAAAAAf///////4AAAAAA////////4AAAAAA////////wAAAAAB////////wAAAAAB////////gAAAAAD////////AAAAAAB////////AAAAAAB///////+AAAAAAD///////8AAAAAAH///////4AAAAAAH///////wAAAAAAP///////AAAAAAAf//////+AAAAAAA///////8AAAAAAB///////wAAAAAAD///////gAAAAAAD//////+AAAAAAAH//////wAAAAAAAP//////4AAAAAAAM//4f+Af8AAAAAAZ//wPgAA/AAAAAAD//ADwAA/wAAAAAH/+AA8AHzwAAAAAH/8AAOAOD4AAAAAP/4AAHgYD4AAAAAf/4AABwQDwAAAAA//wAAA8AXgAAAAB//gAAB+AfgAAAAB//gAADvA/AAAAAD//AAAOPgYAAAAAH/+AAAMPgAAAAAAP/8AAAIfAAAAAAAf/8AAAK+AAAAAAAf/4AAAH8AAAAAAA//wAAAD4AAAAAAB//wAAABAAAAAAAD//gAAAAAAAAAAAD//AAAAAAAAAAAAH//AAAAAAAAAAAAP/+AAAAAAAAAAAAP/8AAAAAAAAAAAAf/8AAAAAAAAAAAAf/4AAAAAAAAAAAA//wAAAAAAAAAAAAf+AAAAAAAAAAAAACAAAAAAAAAAAAAAA"},"turdus-philomelos-2":{"w":93,"h":86,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACEAAAAAAAAAAAAAAxgAAAAAAAAAAAAAO4AAABAAAAAAAAADvIAAA4AAAAAAAAA9zAAAODAAAAAAAAH9wAAHhwAAAAAAAB/+AAD58AAAAAAAAf/oAB//AAAAAAAAH//AAf/wwAAAAAAA//4AP/88AAAAAAAP/+AD///AAAAAAAD//gB///wAAAAAAAf/9Af//4AAAAAAAH//4P//+YAAAAAAB//+D///+AAAAAAAP//g////AAAAAAAD//8f///wAAAAAAAf//3////AAAAAAAH///////4AAAAAAB///////+AAAAAAAP///////gAAAAAAD///////4AAAAAAAf//////+AAAAAAAH///////gAAAAAAA///////8AAAAAAAP///////AAAAAAAB///////wAAAAAAAf//////4AAAAAAAD///////AAAAAAAAf//////wAAAAAAAD//////8AAAAAAAAf/////+AAAAAAAAD//////wAAAAAAA4P/////+AAAAAAB/9//////wAAAAAA/////////AAAAAAP////////wAAAAD/////////+AAAAA//////////4AAAAB//////////AAAAAB/////////4AAAAAD////////+AAAAAAf////////wAAAAAA/////////AAAAAAD////////wAAAAAAf///////+AAAAAAB////////gAAAAAAH///////8AAAAAAAf///////gAAAAAAB///////4AAAAAAAP///////AAAAAAAA///////8AAAAAAAH///////4AAAAAAAf///////gAAAAAAB////////AAAAAAAP////////AAAAAAA/////////gAAAAAD/////////wAAAAAP/////////4AAAAA//////////8AAAAB//////////4AAAAH//////////AAAAAP////4G///wAAAAAf///8AB//8AAAAAAP//+AAD//wAAAAAAP//gAAH//AAAAAAAA48AAAH/wAAAAAAAOHAAAAP+AAAAAAAHBwAAAAPgAAAAAAHAYAAAAAEAAAAAADgMAAAAAAAAAAAAA8HAAAAAAAAAAAAAOdgAAAAAAAAAAAABw/wAAAAAAAAAAAAOHHAAAAAAAAAAAABw4AAAAAAAAAAAAAPHAAAAAAAAAAAAAA44AAAAAAAAAAAAABjwAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"turdus-philomelos":{"w":93,"h":68,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/4AAAAAAAAAAAP///wAAAAAAAAAAH////AAAAAAAAAAAf///8AAAAAAAAAAA////gAAAAAAAAAAA///+AAAAAAAAAAAD///4AAAAAAAAAAAf///gAAAAAAAAAAD///+AAAAAAAAAAAf///4AAAAAAAAAAB////gAAAAAAAAAAP////gAAAAAAAAAB/////AAAAAAAAAAH////8AAAAAAAAAA/////4AAAAAAAAAH/////gAAAAAAAAA/////+AAAAAAAAAH/////4AAAAAAAAA//////wAAAAAAAAH//////AAAAAAAAA//////8AAAAAAAAH//////wAAAAAAAA///////gAAAAAAAH///////AAAAAAAA///////8AAAAAAAH///////wAAAAAAAf///////AAAAAAAD///////8AAAAAAAf///////wAAAAAAB////////AAAAAAAP///////8AAAAAAA////////wAAAAAAH////////AAAAAAAf///////8AAAAAAB////////wAAAAAAP////////gAAAAAA////////+AAAAAAD////////8AAAAAAP////////wAAAAAAf///////zAAAAAAB////////AAAAAAAD///////8AAAAAAAP///////wAAAAAAAP///////AAAAAAAAf///A//+AAAAAAAAP//gAf/8AAAAAAAAf/wAAH/wAAAAAAAB/wAAAP/gAAAAAAAH8AAAA/+AAAAAAAA+AAAAD/8AAAAAAAfgAAAAH/wAAAAAAP4AAAAAP/AAAAAMD8AAAAAA/+AAAAA9/AAAAAAB/4AAAH//4AAAAAAH/gAAAf//wAAAAAAP8AAB///P4AAAAAA+AAADHwfggAAAAAAAAAAB8AAAAAAAAAAAAAAcAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"turdus-pilaris-2":{"w":81,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAGAAATAAAAAAAADgAACZAAAAAAAB4YAAbsAAAAAAA+OAADdgAAAAAAfngAAbsAAAAAAHz4AADfsAAAAAD8+AAAf9gAAAAB//jAAD/sAAAAAf/zwAA//kAAAAP/98AAH/9gAAAD///AAA//sAAAB///wAAH//gAAAf//4wAA//9AAAH///8AAH//4AAD////AAA///AAA////wAAH//4AAP///4AAA///wAD///+cAAD//+AB/////AAAf//wAf////gAAD//+AH////4AAAf//wB////+AAAD//+Af////8AAA///gH/////AAAH//+B/////wAAA///4f////4AAAH///n/////gAAAf//+/////8AAAD////////+AAAAP////////gAAAD////////8AAAB/////////AAAA/////////wAAH/////////4AAA/////////+AAAA/////////gAAAB////////8AAAAH////////gAAAA////////8AAAAD////////wAAAAP///////+AAAAA////////gAAAAH///////8AAAAAf///////wAAAAB///////+AAAAAP///////gAAAAB///////8AAAAAH///////gAAAAA///////8AAAAAH///////AAAAAA///////4AAAAAD///////AAAAAAf//////4AAAAAB//////+AAAAAAP/////PwAAAAAA/////4AAAAAAAH/////gAAAAAAAf////+AAAAAAAB/////4AAAAAAAH/////AAAAAAAA/////8AAAAAAAD/////wAAAAAAAH/////AAAAAAAAf////4AAAAAAAA/////gAAAAAAAD////8AAAAAAAAP////wAAAAAAAAf////AAAAAAAAA////4AAAAAAAAAf///wAAAAAAAAB////AAAAAAAAf////8AAAAAAAH//w//4AAAAAAA/wAD//gAAAAAAOfAAP/+AAAAAABzsAB//8AAAAAAOYQAH//4AAAAAA7gAA///gAAAAAH8AAD///AAAAAAN4AAP//8AAAAAAHAAB///gAAAAAAAAAH//8AAAAAAAAAAf//AAAAAAAAAAD//wAAAAAAAAAAP/8AAAAAAAAAAA/+AAAAAAAAAAAH7AAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"turdus-pilaris":{"w":93,"h":83,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4AAAAAAAAAAAAAB/4AAAAAAAAAAAAA//wAAAAAAAAAAAf///AAAAAAAAAAAP///8AAAAAAAAAAAf///wAAAAAAAAAAA////AAAAAAAAAAAB///4AAAAAAAAAAAH///gAAAAAAAAAAAf//8AAAAAAAAAAAB///wAAAAAAAAAAAP//+AAAAAAAAAAAB///wAAAAAAAAAAAH///AAAAAAAAAAAA///4AAAAAAAAAAAH///gAAAAAAAAAAAf//+AAAAAAAAAAAD///4AAAAAAAAAAAf///gAAAAAAAAAAD///+AAAAAAAAAAA////8AAAAAAAAAAH////4AAAAAAAAAA/////wAAAAAAAAAH/////AAAAAAAAAA/////+AAAAAAAAAH/////4AAAAAAAAA//////gAAAAAAAAH/////+AAAAAAAAA//////8AAAAAAAAH//////wAAAAAAAA///////AAAAAAAAH//////8AAAAAAAA///////4AAAAAAAH///////gAAAAAAAf///////AAAAAAAD///////8AAAAAAAf///////wAAAAAAD////////AAAAAAAP///////8AAAAAAB////////wAAAAAAH////////AAAAAAA////////8AAAAAAD////////wAAAAAAP///////+AAAAAAB////////4AAAAAAH////////gAAAAAAf///////+AAAAAAB////////4AAAAAAH////////wAAAAAAf////////AAAAAAB////////+AAAAAAD///////74AAAAAAH///////DAAAAAAAP//////8AAAAAAAAf//////wAAAAAAAAf//////AAAAAAAAAP//P//8AAAAAAAAA/8ADz/wAAAAAAAAD/AAHf/AAAAAAAAA58AAM/8AAAAAAAAMPAAAH/wAAAAAAADBwAAAf/AAAAAAABwMAAAB/8AAAAAAAYDAAAAH/wAAAAAAHAwAAAAf/AAAAAAH/sAAAAB/8AAAAAP8DAAAAAH/wAAAAA/AwAAAAAf/AAAAAHwMAAAAAB/8AAAADMDvgAAAAD/wAAAAyD/wAAAAAP/AAAAIn+AAAAAAA/4AAAABPgAAAAAAD/gAAAADYAAAAAAAP4AAAAB2AAAAAAAA+AAAAAZgAAAAAAAAAAAAAEIAAAAAAAAAAAAABCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"turdus-torquatus-2":{"w":93,"h":53,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADx4AAAAAAAAAAAAAf/4AAAAAAAAAAAAA//gAAAAAAAAAAAAB/+AAAAAAAAAAAAAP/4AAAAAAAAAAAAA//AAAAAAAAAAAAAH/8AH/AAAAAAAAAA//wD//wAAAAAAAAD//x///8AAAAAAf////////+AAAAB//////////+AAAH///////////+AAH////////////8AH/////////////4D/////////////+B//////////////4D//////////////h//////////////wB/////////////wAP///////////5gAAf/////////8AAAAAM/////////AAAAAAAAP//////wAAAAAAAAf/////8AAAAAAAAA//////AAAAAAAAAB/////wAAAAAAAAAH////8AAAAAAAAAAH///8AAAAAAAAAAAB///gAAAAAAAAAAAD//+AAAAAAAAAAAAP//4AAAAAAAAAAAA///gAAAAAAAAAAAD//+AAAAAAAAAAAAOf/4AAAAAAAAAAAAz//gAAAAAAAAAAAIx/+AAAAAAAAAAAGYP/4AAAAAAAAAABmA//gAAAAAAAAAAf4H//AAAAAAAAAADMwf/8AAAAAAAAAANgD//wAAAAAAAAABmAP//AAAAAAAAAAGwB//4AAAAAAAAAAyAH/+AAAAAAAAAAAAA//wAAAAAAAAAAAAD/+AAAAAAAAAAAAAf/gAAAAAAAAAAAAA/8AAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"turdus-torquatus":{"w":93,"h":70,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgGAAAAAAAAAAAAA///AAAAAAAAAAAAB//+AAAAAAAAAAAAH//4AAAAAAAAAAAAP//gAAAAAAAAAAAB//+AAAAAAAAAAAAH//wAAAAAAAAAAAA///AAAAAAAAAAAAH//4AAAAAAAAAAAA///gAAAAAAAAAAAH//+AAAAAAAAAAAAf//4AAAAAAAAAAAD///wAAAAAAAAAAAf///wAAAAAAAAAAD////gAAAAAAAAAAf////AAAAAAAAAAD////+AAAAAAAAAA/////8AAAAAAAAAH/////4AAAAAAAAA//////8AAAAAAAAH//////4AAAAAAAA///////4AAAAAAAH///////gAAAAAAA///////+AAAAAAAH///////8AAAAAAA////////wAAAAAAH////////AAAAAAA/////////AAAAAAD/////////AAAAAAf/////////AAAAAD/////////8AAAAAP//////////AAAAB///////////gAAAH///////////4AAAf///////////8AAD////////7///4AAP//////8AB///gAA//////gAAA//4AAD/////wAAAAf/AAAH////8AAAAAPAAAAf////AAAAAAAAAAA////wAAAAAAAAAAA///4AAAAAAAAAAAA//8AAAAAAAAAAAAAfPgAAAAAAAAAAAABw8AAAAAAAAAAAAAMHAAAAAAAAAAAAADAwAAAAAAAAAAAAAwMAAAAAAAAAAAAAMDAAAAAAAAAAAAABAwAAAAAAAAAAAAAQYAAAAAAAAAAAAAEGAAAAAAAAAAAAABBgAAAAAAAAAAAAA/4AAAAAAAAAAAAAPP/wAAAAAAAAAAB/j/wAAAAAAAAAAAf/8AAAAAAAAAAAAD//AAAAAAAAAAAAA5iQAAAAAAAAAAAAMJkAAAAAAAAAAAABBZgAAAAAAAAAAAAAGIAAAAAAAAAAAAABCAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},"turdus-viscivorus-2":{"w":84,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAIAAAAABEAAAAAA4wAAAADMgAAAABxgAAAATdgAAAAHngAAAAXZgAAAAPPAAAAAX7IAAAA/+YAAAA//YAAAB/94AAAA//4AAAD//wAAAB//wAAAP//gAAAB//4AAAf//AAAAB//4AAA//8wAAAD//4AAD///gAAAD//4AAH///AAAAH//4AAP//+AAAAH//4AAf//+AAAAH//4AA////AAAAH//4AB///+AAAAP//4AH///8AAAAP//wAP///8AAAAP//wAf///4AAAAP//wA////4AAAAf//4B////wAAAAf//4D////gAAAAf//8H////AAAAAf//+P////AAAAA///+f////AAAAA////////+AAAAA////////8AAAAA////////4AAAAA////////4AAAAA////////wAAAAA////////gAAAAAf///////AAAAAP////////AAAAA////////+AAAAD////////4AAAH/////////4AAAP/////////8AAAB/////////8AAAAP////////8AAAAH////////8AAAAD////////8AAAAB////////8AAAAA////////8AAAAA////////8AAAAAf///////8AAAAAP///////8AAAAAH///////8AAAAAD///////8AAAAAD///////8AAAAAB///////4AAAAAB///////4AAAAAA///////4AAAAAA///////wAAAAAAf//////wAAAAAAf/////+AAAAAAAP/////4AAAAAAAP/////8AAAAAAAH/////+AAAAAAAD/////+AAAAAAAB//////AAAAAAAA//////gAAAAAAAf/////wAAAAAAAP/////wAAAAAAAH/////4AAAAAAAB/////4AAAAAAAAf////8AAAAAAAAP////+AAAAAAAAD////+AAAAAAAAAf////AAAAAAAAAD////AAAAAAAAAA////AAAAAAAAAB/8//gAAAAAAAA//4P/wAAAAAAAB8fAH/4AAAAAAADv4AB/4AAAAAAADj+AA/8AAAAAAADjDgA/+AAAAAAABzgAAf/AAAAAAAB7gAAf/gAAAAAAA/wAAP/wAAAAAAAF4AAH/wAAAAAAAA8AAH/4AAAAAAAAAAAD/8AAAAAAAAAAAB/+AAAAAAAAAAAA//AAAAAAAAAAAA+PgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="},"turdus-viscivorus":{"w":90,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAf+AAAAAAAAAAAAB//AAAAAAAAAAAD///wAAAAAAAAAAP///4AAAAAAAAAAD///4AAAAAAAAAAA///8AAAAAAAAAAAP//8AAAAAAAAAAAH//+AAAAAAAAAAAH//+AAAAAAAAAAAH///AAAAAAAAAAAD///AAAAAAAAAAAD///AAAAAAAAAAAD///gAAAAAAAAAAD///gAAAAAAAAAAB///wAAAAAAAAAAB///wAAAAAAAAAAB///4AAAAAAAAAAB///+AAAAAAAAAAB////AAAAAAAAAAD////wAAAAAAAAAD////8AAAAAAAAAD/////AAAAAAAAAD/////gAAAAAAAAD/////4AAAAAAAAH/////8AAAAAAAAH/////+AAAAAAAAH//////AAAAAAAAH//////gAAAAAAAH//////wAAAAAAAH//////8AAAAAAAH//////+AAAAAAAD///////AAAAAAAD///////wAAAAAAD///////4AAAAAAD///////8AAAAAAB///////+AAAAAAB///////+AAAAAAB////////AAAAAAA////////gAAAAAA////////wAAAAAAf///////4AAAAAAP///////8AAAAAAP///////+AAAAAAH////////AAAAAAD////////gAAAAAD////////wAAAAAB////////4AAAAAA////////+AAAAAAP////////AAAAAAH////////wAAAAAD////////4AAAAAA////////+AAAAAAf////////gAAAAAH////AD//wAAAAAB///8AAP/8AAAAAA///wAAD/+AAAAAAf/+AAAB//gAAAAAPn+AAAAf/wAAAAAHj+AAAAP/4AAAAAHg+AAAAD/8AAAAADA+AAAAB/4AAAAAGAeAAAAAeQAAAAAMAcAAAAAGAAAAAAIAcAAAAAAAAAAAAYAYAAAAAAAAAAAAwAYAAAAAAAAAAABgAQAAAAAAAAAAABgAwAAAAAAAAAAADAAgAAAAAAAAAAAHnBgAAAAAAAAAAf/+BgAAAAAAAAAAO8ABAAAAAAAAAAAA8ADAAAAAAAAAAADYACAAAAAAAAAAAGQAGAAAAAAAAAAAYgAH+AAAAAAAAAAxAAf4AAAAAAAAABCAH8AAAAAAAAAACCA94AAAAAAAAAAAAABIAAAAAAAAAAAAAGQAAAAAAAAAAAAAMwAAAAAAAAAAAAAxgAAAAAAAAAAAADhAAAAAAAAAAAAAGDAAAAAAAAAAAAAICAAAAAAAAAAAAAICAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"tyto-alba-2":{"w":89,"h":93,"bits":"AAAAAAAAAAAAAAAwAAAAAAAAAAAAAB+AAAAAAAAAAAAAB+AAAAAAAAAAAAAB/gAAAAAAAAAAAAD/wAAAAAAAAAAAAD/wAAAAAAAAAAAAD/wAAAAAAAAAAAAD/4AAAAAAAAAAAAD/4AAAAAAAAAAAAD/4AAAAAAAAAAAAD/8AAAAAAAAAAAAD/8AAAAAAAAAAAAH/8AAAAAAAAAAAAH/+AAAAAAAAAAAAH/+AAAAAAAAAAAAH/+AAAAAAAAAAAAP/+AAAAAAAAAAAAP/+AAAAAAAAAAAAP/+AAAAAAAAAAAAf/+AAAAAAAAAAAAf/8AAAAAAAAAAAAf/+AAAAAAAAAAAA//8AAAAAAAAAAAA//8AAAAAAAAAAAA//8AAAAAAAAAAAB//4AAAAAAAAAAAB//4AAAAAAAAAAAD//4AAAAAAAAAAAH//4AAAAAAAAAAAH//4AAAAAAAAAAAP//8AAAAAAAAAAAP//+AAAAAAAAAAAP//+AAAAAAAAAAAf//+AAAAAAAAAAAf//+AAAAAAAAAAAf//+AAAAAAAAAAAf//+AAAAAAAAAAAP//+AAAAAAAAAAAH//+ADwAAAAAAAAD//+AP4AAAAAAAAD//8A/8AAAAAAAAD//8B/8AAAAAAAAD//8D/8AAAAAAAAD//4P/+AAAAAAAAH//4f/+AAAAAAAAH//x//+AAAAAAAAP//3//+AAAAAAAAf/////+AAAAAAAB//////+AAAAAAA///////+AAAAAAH///////+AAAAAAf///////+AAAAAB////////+AAAAAD////////+AAAAAP////////8AAAAAf////////8AAAAA/////////4AAAAB/////////4AAAAB/////////wAAAAD/////////wAAAAH/////////gAAAAP/////////AAAAAf//////z//AAAAA//////+H/+AAAAA//////wH/8AAAAB//////gP/4AAAAB//////gP/4AAAAB//////gf/wAAAAB//////g//gAAAAAAB////A//AAAAAAAAf///B/+AAAAAAAAD///D/8AAAAAAAAD///D/4AAAAAAAAD//+H/4AAAAAAAAB//+P/wAAAAAAAAAf/+P/AAAAAAAAAAf/+f+AAAAAAAAAA//+f+AAAAAAAAAB//4/8AAAAAAAAADf+B/wAAAAAAAAAEYAB/gAAAAAAAAAYwAD/AAAAAAAAAAxgAH+AAAAAAAAABCAAH8AAAAAAAAAHHAAPwAAAAAAAAAP/AAPgAAAAAAAAAZ4AAfAAAAAAAAAA4wAAYAAAAAAAAABxwAAAAAAAAAAAABzwAAAAAAAAAAAABxgAAAAAAAAAAAAAAAAAA"},"tyto-alba":{"w":60,"h":93,"bits":"AAAAAAAAAAAB//4AAAAAAH//+AAAAAAf///gAAAAA////wAAAAB////4AAAAD////4AAAAH////8AAAAH////+AAAAP////+AAAAP////+AAAAP/////AAAAP/////AAAAf/////AAAAf/////AAAAf/////AAAAf/////gAAAf/////gAAA//////gAAA//////gAAA//////gAAA//////gAAA//////wAAAf/////wAAAf/////4AAAf/////4AAAf/////8AAAf/////+AAAf//////AAAf//////gAAf//////wAAf//////4AAf//////8AAf//////+AAf///////AAf///////AAf///////gAf///////wAP///////wAf///////4Af///////4AP///////8AP///////8AP///////8AP///////8AP///////+AP///////+AH////////AH////////AH////////AD////////AD////////gB///////+AA////////AAf///////AAP///////AAH///////gAD///////gAB///////gAB///////gAA///////wAAf//////wAAP//////gAAH//////gAAH//////wAAD//////wAAB//////wAAA//////wAAAf/////wAAAP/////wAAAP/////gAAAP/////gAAAf/////gAAA/////+AAAH/////+AAA///////AAA/v/////AABuf7////AAAMZw////gAAITgf///wAAADAf///4AAACAH///8AAAAAB///8AAAAAA///+AAAAAA///+AAAAAA////AAAAAA////AAAAAA///+AAAAAA///+AAAAAAf/vgAAAAAAD/gAAAAAAAB/AAAAAAAAACAAA="},"vanellus-vanellus-2":{"w":66,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAIAAAAAAAAAA8AAAAAAAAAA8AAAAAAAAAB+AAAGAAAAAB+AAADgAAAAB+AAAB4AAAAB/AAAG+AAAAD/AAAD/gAAAD/AAAB/wAAAD/gAAG/8AAAD/gAAD/+AAAP/gAAB//gAAP/wAAA//wAAP/wAAB//8AAP/wAAA//+AAf/wAAAf//AAf/4AAAf//wAf/4AAAf//4Af/4AAAP//8A//4AAAH//+A//4AAAH///A//4AAAH///w//4AAAD///4//8AAAB///8//8AAAB///+//8AAAA//////8AAAAf/////8AAAAf/////8AAAAP/////8AAAAH/////8AAAAD/////8AAAAB/////4AAAAA/////4AAAAAf////wAAAAAP////wAAAAAP////gAAAAAP////AAAAAAP////AAAAAAP///+AAAAAAP///+EAAAAAP///8GAAAAAP///8HAAAAAH///8HgAAAAH///8D4AAAAH///+H+AAAAH///+f/AAAAH//////AAAAD//////AAAAD//////AAAAD//////gAAAB//////wAAAD/////wYAAAD/////AEAAAD////+AAAAAH////8AAAAAD////4AAAAAH////4AAAD//////wAAAD//////gAAAH//////AAAAH/////+AAAAH/////4AAAAH/////wAAAAP/////AAAAAP////8AAAAAP4A//AAAAAAPgAD+AAAAAAOAADwAAAAAAAAAHgAAAAAAAAANwAAAAAAAAAGYAAAAAAAAAGMAAAAAAAAADDAAAAAAAAABBgAAAAAAAABgwAAAAAAAAAh4AAAAAAAAAxYAAAAAAAAAYwAAAAAAAAB4wAAAAAAAAAYgAAAAAAAAAwgAAAAAAAABwgAAAAAAAABgAAAAAAAAABgAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"vanellus-vanellus":{"w":89,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAACAAAAAAAAAAAAAACAAAAAAAAAAAAAADAAAAAAAAAAAAAAfgAAAAAAAAAAAAAf8AAAAAAAAAAAAAf/gAAAAAAAAAAAA//gAAAAAAAAAAAB//gAAAAAAAAAAAD//gAAAAAAAAAAAH//AAAAAAAAAAAAP/+AAAAAAAAAAAAf/+AAAAAAAAAAAA//+AAAAAAAAAAAB///AAAAAAAAAAAH///AAAAAAAAAAAP//HAAAAAAAAAAAf/4AAAAAAAAAAAB//wAAAAAAAAAAAD//gAAAAAAAAAAAP//AAAAAAAAAAH///+AAAAAAAAAf////8AAAAAAAAH/////8AAAAAAAB//////4AAAAAAAf//////wAAAAAAH///////gAAAAAH////////gAD////////////AAB////////+f/+AAP////////8//8AAf////////9//wAAP////////5//gAAH////////z//AAB/////////n/+AA//////////f/4AB/////////+//wAD/////////9//gAH/////////x/+AAHAA///////D/8AAAAAP/////8H/wAAAAAH/////gP/gAAAAAD////+AP+AAAAAAB////gAf4AAAAAAA+D/8AAfgAAAAAAA4A3gAAeAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAABwCAAAAAAAAAAAAAgIAAAAAAAAAAAABEAAAAAAAAAAAAACGAAAAAAAAAAAAAGcAAAAAAAAAAAAAc4AAAAAAAAAAAAA4wAAAAAAAAAAAABwwAAAAAAAAAAAABgwAAAAAAAAAAAADBgAAAAAAAAAAAADBgAAAAAAAAAAAAGBgAAAAAAAAAAAAMDAAAAAAAAAAAAAYDAAAAAAAAAAAAAQDAAAAAAAAAAAAAwHAgAAAAAAAAAABgP/AAAAAAAAAAADAnwAAAAAAAAAAAGHM/gAAAAAAAAAAMAMDAAAAAAAAAAA8AMAAAAAAAAAAAHf4GAAAAAAAAAAAA+AAAAAAAAAAAAAAnwAAAAAAAAAAAABg8AAAAAAAAAAAABgAAAAAAAAAAAAABgAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"zonotrichia-albicollis-2":{"w":93,"h":56,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAiAAAAAAAAAAAAAAJyAAAAAAAAAAAAADcgAAAAAAAAAAAAA/8AAAAAAAAAAAAAf/AAAAAAAAAAAAAH/2AAAAAAAAAAAAB//gAAAAAAAAAAAAf/4AAAAAAAAAAAAH//wAAAAAAAAAAAB//8AAAAAAAAAAAAf//AAAAAAAAAAAAH//wAAAAAAAAAAAB///AAAAAAAAAAAAf//wAAAAAAAAAAAP//8AAAAAAAAAAAD///AAAAAAAAAAAA///8AAAAAAAAAAAP///AAAAAAAAAAAD///gAAAAAAAAAAA///8AAAAAAAAA+AP//+AAAAAAAAAf+B///AAAAAAAAAH/////8AAAAAAAAB//////gAAAAAAAAf/////8AAGAAAAAH//////gAP/gAAAB//////8AP/wAAAAP//////gf/gAAAAAP////////AAAAAAA///////+AAAAAAAf//////+AAAAAAAP///////AAAAAAAH///////wAAAAAAD///////4AAAAAAB///////+AAAAAAAf///////gAAAAAAf///////4AAAAAAP///////+AAAAAAH////////gAAAAAH////////wAAAAAP////////8AAAAAH////////+AAAAAAH////////wAAAAAH/////8AH8AAAAAAA8//wAADMAAAAAAAeOdwAAA/AAAAAAAADGIAAAE/AAAAAAAAAAAAAAkAAAAAAAAAAAAAAGwAAAAAAAAAAAAAAbAAAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"zonotrichia-albicollis":{"w":93,"h":58,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAP/AAAAAAAAAAAAAH/+AAAAAAAAAAAAB//8AAAAAAAAAAAAf//wAAAAAAAAAAAD///AAAAAAAAAAAA///8AAAAAAAAAAAf///4AAAAAAAAAAH////8AAAAAAAAAB/////8AAAAAAAAAB/////4AAAAAAAAAH/////wAAAAAAAAA//////AAAAAAAAAD/////+AAAAAAAAAf/////8AAAAAAAAD//////4AAAAAAAAf//////wAAAAAAAB///////gAAAAAAAP//////+AAAAAAAB///////8AAAAAAAP///////4AAAAAAB////////8AAAAAAH////////8AAAAAA///////////4AAAH////////////wAAf////////////4AD///////+f///+AAP///////A////4AB///////8gAP//gAH///////wAAAfwAAf///////AAAAAAAD//////78AAAAAAAP/////+AAAAAAAAAf/////AAAAAAAAAB/////wAAAAAAAAAH////4AAAAAAAAAAP///+AAAAAAAAAAAf///gAAAAAAAAAAA///gAAAAAAAAAAAA//wAAAAAAAAAAAAA/wAAAAAAAAAAAAAfgAAAAAAAAAAAAB/4AAAAAAAAAAAAAf/AAAAAAAAAAAAAH+MAAAAAAAAAAAAA/gAAAAAAAAAAAAAP/wAAAAAAAAAAAAD8HgAAAAAAAAAAAA3AGAAAAAAAAAAAAMgAAAAAAAAAAAAACIAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},"zonotrichia-leucophrys-2":{"w":93,"h":72,"bits":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAADwAAAAAAAAAAAAAB8cAAAAAAAAAAAAA/fAAAAAAAAAAAAAf/wAAAAAAAAAAAAP//wAAAAAAAAAAAH//8AAAAAAAAAAAD//+AAAAAAAAAAAB///8AAAAAAAAAAAf///AAAAAAAAAAAP///gAAAAAAAAAAH///4AAAAAAAAAAD////gAAAAAAAAAB////4AAAAAAAAAAf///8AAAAAAD/gAH////gAAAAAA/+AD////4AAAAAAP/4A////8AAAAAAD//gP////AAAAAAA//+D////wAAAAAAf//9////4AAAAAAD///////8AAAAAAAH///////AAAAAAAAf//////gAAAAAAAB//////+AAAAAAAAH//////gAAAAAAAA//////+AAAAAAAD///////wAAAAAAD///////+AAAAAAB////////wAAAAAA////////+AAAAAAP////////gAAAAAP////////8AAAAAH/////////gAAAAD/////////4AAAAB//////////AAAAA//////////wAAAAf////////8YAAAAP/////////wAAAAD//////////AAAAB//////////4AAAAB//////////AAAAA//////////8AAAAP//////////gAAADv///wf////+AAAAD3//8Af9///wAAAA57/8AAAD///AAAAAc92AAAAH//4AAAACOcgAAAH///gAAAABCAAAAB3z/8AAAAAAAAAAAPyH/wAAAAAAAAAABmYP/AAAAAAAAAAAGYA/8AAAAAAAAAAAxAD/wAAAAAAAAAADEAf+AAAAAAAAAAAEAB/4AAAAAAAAAAAAAH/gAAAAAAAAAAAAA/+AAAAAAAAAAAAAD/4AAAAAAAAAAAAAf/gAAAAAAAAAAAAB/+AAAAAAAAAAAAAH/4AAAAAAAAAAAAA//AAAAAAAAAAAAAD/8AAAAAAAAAAAAAP/wAAAAAAAAAAAAB//AAAAAAAAAAAAAHz8AAAAAAAAAAAAAeHgAAAAAAAAAAAADwMAAAAAAAAAAAAAMAAAAAAAAAAAAAAAAAA"},"zonotrichia-leucophrys":{"w":77,"h":93,"bits":"AAAAAAAAAAAAAAAAAAAAAAf8AAAAAAAAAAH/+AAAAAAAAAAf//AAAAAAAAAB///AAAAAAAAAH///AAAAAAAAAf///AAAAAAAAB////gAAAAAAAH////gAAAAAAAP////gAAAAAAA////8AAAAAAAD////gAAAAAAAH///+AAAAAAAAf///8AAAAAAAB////4AAAAAAAD////gAAAAAAAf////AAAAAAAB////+AAAAAAAP////4AAAAAAA/////wAAAAAAH/////gAAAAAAf/////AAAAAAB/////+AAAAAAH/////8AAAAAAf/////4AAAAAB//////wAAAAAH//////gAAAAAf//////AAAAAB//////+AAAAAD//////8AAAAAP//////wAAAAA///////gAAAAD///////AAAAAP//////8AAAAA///////4AAAAB///////wAAAAH///////AAAAAf//////8AAAAA///////4AAAAD///////gAAAAH//////+AAAAAf//////8AAAAA///////wAAAAD///////AAAAAH//////8AAAAAf//////wAAAAA///////AAAAAB//////8AAAAAD//////gAAAAAP/////+AAAAAA//////4AAAAAD//////AAAAAAP/////8AAAAAAc/////gAAAAABz/////AAAAAAHP/////gAAAAAM//////gAAAAAx//w+H+AAAAAAH//AAf+AAAAAAP/8AD/8AAAAAAH/wAO/wAAAAAAP/AAY/gAAAAAA/8AAn+AAAAAAB/gABD8AAAAAAH+AABDgAAAAAAP4AAAAAAAAAAA/wAAAAAAAAAAB/AAAAAAAAAAAH+AAAAAAAAAAAf4AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAH+AAAAAAAAAAAf4AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAH+AAAAAAAAAAAf4AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAH+AAAAAAAAAAAf4AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAH+AAAAAAAAAAAf4AAAAAAAAAAA/wAAAAAAAAAAD/AAAAAAAAAAAH+AAAAAAAAAAAf4AAAAAAAAAAANwAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAA="}};

  // Tunables - Galliformes-poster-inspired. Raster-mask nesting.
  //
  // Layout discipline: tile areas are NORMALISED against a viewport
  // budget (sum of areas ≈ packingBudgetFrac × vpArea) rather than
  // each tile being clamped to a per-tile maxArea. The old per-tile
  // cap made every loud bird look identical (Anna n=398, Crow n=31
  // and Phoebe n=26 all hit ceiling and rendered the same size) AND
  // it allowed total area to overflow narrow viewports so birds got
  // dropped off-screen. Normalising fixes both - relative size
  // tracks the relative call ratio, and total area can never exceed
  // what the iterative shrink loop is willing to scale into the
  // viewport.
  function tuning(n) {
    return {
      // Soft area budget the whole cluster aims to fill, as a
      // fraction of viewport area. Lower = sparser collage with more
      // breathing room (and more headroom for packing efficiency).
      // Steps down as species count grows so a busy plate doesn't
      // try to claim the entire viewport.
      packingBudgetFrac: n <= 4  ? 0.46 :
                          n <= 12 ? 0.40 :
                          n <= 24 ? 0.34 :
                                    0.28,
      // Count -> area exponent. ~0.65 keeps the visual hierarchy
      // legible (n=400 reads ~5× bigger than n=30) without the
      // loudest bird drowning everything else.
      countExp: 0.65,
      // Floor: every species in the dataset must be visible, even
      // n=1. Tracks species count so a tiny rare bird stays
      // recognisable on a crowded plate.
      minTileAreaFrac: n <= 8 ? 0.0100 :
                        n <= 20 ? 0.0075 :
                                  0.0055,
      // Wider clusters for landscape viewports, more so as n grows.
      ellipseAspectBias: 2.1,
    };
  }
  var GRID_STRIDE = 4; // viewport px per occupancy cell; smaller = slower
  var COLLAGE_PAD = 3; // breathing room (grid cells) around each bird;
                       // eased on narrow screens where birds are smaller.
  var FLY_PROB = 0.15; // chance a bird shows in its flight pose (rare); perched
                       // otherwise. Rolled once per window appearance.
  var collagePose = {}; // sci -> 1 perched | 2 flight, persisted across polls;
                        // cleared when a bird leaves the window so it rerolls.

  // Decode and cache each mask once. Sparse cell-list form (only "on"
  // cells) makes collision tests linear in opaque area, not total area.
  var maskCache = {};
  function loadMask(slug) {
    if (maskCache[slug]) return maskCache[slug];
    var rec = MASKS[slug];
    if (!rec) return null;
    var bytes = atob(rec.bits);
    var w = rec.w, h = rec.h;
    var cells = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var b = bytes.charCodeAt(i >> 3);
        if ((b >> (7 - (i & 7))) & 1) cells.push([x, y]);
      }
    }
    return (maskCache[slug] = { w: w, h: h, cells: cells });
  }

  function slugify(sci) {
    return sci.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  function aspect(sci) {
    var d = DIMS[slugify(sci)];
    return d ? d[0] / d[1] : 1.4;
  }

  // Mask-aware nester. tiles: { fullW, fullH, mask, data }. Returns the
  // same tiles with .x, .y assigned (top-left in viewport coords).
  function maskPack(tiles, W, H, xBias, yBias, pad) {
    var GW = Math.ceil(W / GRID_STRIDE) + 2;
    var GH = Math.ceil(H / GRID_STRIDE) + 2;
    var grid = new Uint8Array(GW * GH);

    function cellRange(tile, tx, ty, c) {
      // For mask cell (c[0], c[1]), return [gx0, gy0, gx1, gy1] (inclusive)
      // in grid coords, clamped to the grid.
      var sx = tile.fullW / tile.mask.w;
      var sy = tile.fullH / tile.mask.h;
      var x0 = (tx + c[0] * sx) / GRID_STRIDE | 0;
      var y0 = (ty + c[1] * sy) / GRID_STRIDE | 0;
      var x1 = (tx + (c[0] + 1) * sx) / GRID_STRIDE | 0;
      var y1 = (ty + (c[1] + 1) * sy) / GRID_STRIDE | 0;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 >= GW) x1 = GW - 1; if (y1 >= GH) y1 = GH - 1;
      return [x0, y0, x1, y1];
    }
    function collides(tile, tx, ty) {
      var cells = tile.mask.cells;
      for (var i = 0; i < cells.length; i++) {
        var r = cellRange(tile, tx, ty, cells[i]);
        for (var gy = r[1]; gy <= r[3]; gy++) {
          var off = gy * GW;
          for (var gx = r[0]; gx <= r[2]; gx++) {
            if (grid[off + gx]) return true;
          }
        }
      }
      return false;
    }
    function stamp(tile, tx, ty) {
      var cells = tile.mask.cells;
      for (var i = 0; i < cells.length; i++) {
        var r = cellRange(tile, tx, ty, cells[i]);
        // Dilate the stamped footprint by `pad` cells so the next bird can't
        // pack right up against this one - a uniform gap around every
        // silhouette. collides() stays unpadded, so the gap is added once.
        var gy0 = r[1] - pad, gy1 = r[3] + pad;
        var gx0 = r[0] - pad, gx1 = r[2] + pad;
        if (gy0 < 0) gy0 = 0; if (gx0 < 0) gx0 = 0;
        if (gy1 >= GH) gy1 = GH - 1; if (gx1 >= GW) gx1 = GW - 1;
        for (var gy = gy0; gy <= gy1; gy++) {
          var off = gy * GW;
          for (var gx = gx0; gx <= gx1; gx++) grid[off + gx] = 1;
        }
      }
    }
    function offGrid(tile, tx, ty) {
      // True if the rendered tile bbox extends past the viewport.
      return tx < 0 || ty < 0 || tx + tile.fullW > W || ty + tile.fullH > H;
    }

    var cx = W / 2, cy = H / 2;
    // Largest first so the cluster grows around the anchor.
    tiles.sort(function (a, b) { return (b.fullW * b.fullH) - (a.fullW * a.fullH); });
    var placed = [];
    // Seeded PRNG keeps the layout stable across resizes.
    var seed = 0x9E3779B9;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];
      var tx, ty;
      if (i === 0) {
        tx = cx - t.fullW / 2;
        ty = cy - t.fullH / 2;
        t.x = tx; t.y = ty;
        stamp(t, tx, ty);
        placed.push(t);
        continue;
      }
      // Spiral outward. Stop the first ring that yields any non-colliding
      // position - that ring is the tightest possible distance from
      // centre. Within the ring, pick the position closest to the centre
      // of mass of already-placed tiles (so cluster grows organically,
      // not in fixed directions).
      var comX = 0, comY = 0, comW = 0;
      placed.forEach(function (p) {
        var a = p.fullW * p.fullH;
        comX += (p.x + p.fullW / 2) * a;
        comY += (p.y + p.fullH / 2) * a;
        comW += a;
      });
      comX /= comW; comY /= comW;

      var best = null, bestCost = Infinity;
      var step = Math.max(GRID_STRIDE, Math.min(t.fullW, t.fullH) * 0.05);
      var maxR = Math.max(W, H);
      var foundRing = -1;
      var phase = rand() * Math.PI * 2;
      for (var r = 0; r <= maxR; r += step) {
        if (foundRing >= 0 && r > foundRing + step * 2) break;
        var samples = Math.max(36, Math.floor(r / 1.6));
        for (var k = 0; k < samples; k++) {
          var theta = phase + (k / samples) * Math.PI * 2;
          // Elliptical ring - stretched per axis: xBias>yBias gives a wide
          // (landscape) cluster, yBias>xBias a tall (portrait) one.
          var px = cx + r * xBias * Math.cos(theta) - t.fullW / 2;
          var py = cy + r * yBias * Math.sin(theta) - t.fullH / 2;
          if (offGrid(t, px, py)) continue;
          if (collides(t, px, py)) continue;
          // Distance to existing cluster centre of mass + small noise.
          var dxx = (px + t.fullW / 2 - comX);
          var dyy = (py + t.fullH / 2 - comY);
          var cost = Math.hypot(dxx / xBias, dyy / yBias) + rand() * step * 0.5;
          if (cost < bestCost) { bestCost = cost; best = { x: px, y: py }; }
        }
        if (best && foundRing < 0) foundRing = r;
      }
      if (best) {
        t.x = best.x; t.y = best.y;
        stamp(t, best.x, best.y);
        placed.push(t);
      } else {
        // Couldn't fit anywhere - hide off-screen rather than overlap.
        t.x = -99999; t.y = -99999;
        placed.push(t);
      }
    }
    return placed;
  }

  function renderCollage(items, animate) {
    collage.innerHTML = '';
    if (!items.length) {
      collage.innerHTML = '<p class="empty">no birds heard in this window.</p>';
      return;
    }
    var W = collage.clientWidth, H = collage.clientHeight;
    if (!W || !H) { setTimeout(function () { renderCollage(items, animate); }, 80); return; }

    // Tuning depends on bird count - same viewport, very different
    // pack densities for 6 vs 48 birds.
    var T = tuning(items.length);
    var vpArea = W * H;
    var budget  = vpArea * T.packingBudgetFrac;
    var minArea = vpArea * T.minTileAreaFrac;

    // Step 1: build tiles + assign each a count-weighted SCORE (not a
    // final area yet). area-from-count uses a sub-linear exponent so
    // a 400-detection bird is visibly larger than a 30-detection bird
    // without dwarfing it.
    var tiles = items.map(function (s) {
      var base = slugify(s.sci);
      // Pose: perched by default, rarely flight (FLY_PROB), and only if a
      // flight render exists. Flight uses the <slug>-2 mask/aspect/image so
      // the wings-spread silhouette nests correctly.
      var pose = collagePose[s.sci];
      if (pose === undefined) {
        pose = (DIMS[base + '-2'] && Math.random() < FLY_PROB) ? 2 : 1;
        collagePose[s.sci] = pose;
      }
      var slug = pose === 2 ? base + '-2' : base;
      var mask = loadMask(slug);
      if (!mask && pose === 2) { pose = 1; slug = base; mask = loadMask(slug); collagePose[s.sci] = 1; }
      if (!mask) return null;
      var d = DIMS[slug];
      var n = +s.n; if (!n || isNaN(n)) n = 1;
      return {
        mask: mask, data: s, pose: pose,
        ar: d ? d[0] / d[1] : 1.4,
        score: Math.pow(Math.max(1, n), T.countExp),
      };
    }).filter(Boolean);
    // Reroll on re-entry: forget pose choices for species no longer in window.
    var present = {}; items.forEach(function (s) { present[s.sci] = 1; });
    Object.keys(collagePose).forEach(function (k) { if (!present[k]) delete collagePose[k]; });

    // Step 2: normalise so sum(area) ≈ budget. Then floor each tile
    // at minArea so even a 1-call bird stays legible.
    var sumScore = tiles.reduce(function (a, t) { return a + t.score; }, 0) || 1;
    tiles.forEach(function (t) {
      t.area = Math.max(minArea, budget * t.score / sumScore);
    });
    // After flooring, total may exceed budget; squeeze the over-budget
    // remainder out of the LARGER tiles (the ones above minArea) so
    // the floor on rare birds stays intact.
    var sumA = tiles.reduce(function (a, t) { return a + t.area; }, 0);
    if (sumA > budget) {
      var fixedSum = tiles.filter(function (t) { return t.area <= minArea + 1e-9; })
        .reduce(function (a, t) { return a + t.area; }, 0);
      var flexSum  = sumA - fixedSum;
      var flexBudget = Math.max(0, budget - fixedSum);
      var shrink = flexSum > 0 ? Math.min(1, flexBudget / flexSum) : 1;
      tiles.forEach(function (t) {
        if (t.area > minArea + 1e-9) t.area *= shrink;
      });
    }
    // Step 3: derive width/height from area + per-species aspect.
    tiles.forEach(function (t) {
      t.fullW = Math.sqrt(t.area * t.ar);
      t.fullH = t.fullW / t.ar;
    });

    // Width-responsive: wide screens get a horizontal ellipse at full padding;
    // narrow/portrait screens a vertical ellipse with slightly tighter padding.
    var narrow = W <= 700;
    var xBias = narrow ? 1 : T.ellipseAspectBias;
    var yBias = narrow ? 1.7 : 1;   // gentler than the desktop bias so the
                                    // portrait cluster stays a bit wider / less tall
    var pad = narrow ? Math.max(1, COLLAGE_PAD - 1) : COLLAGE_PAD;
    var placed = maskPack(tiles, W, H, xBias, yBias, pad);

    // Scale-to-fit: iterate shrink + repack until every tile lands on
    // screen. The old single-pass version dropped birds when one pass
    // wasn't enough (narrow viewports + many species). Capped at 10
    // iterations - by then the linear scale is ~0.5 of original, more
    // than enough headroom for any viewport.
    function clusterBounds(arr) {
      var L = Infinity, R = -Infinity, T2 = Infinity, B = -Infinity;
      arr.forEach(function (t) {
        if (t.x < -1000) return;
        if (t.x < L) L = t.x;
        if (t.x + t.fullW > R) R = t.x + t.fullW;
        if (t.y < T2) T2 = t.y;
        if (t.y + t.fullH > B) B = t.y + t.fullH;
      });
      return { L: L, R: R, T: T2, B: B };
    }
    var b = clusterBounds(placed);
    for (var iter = 0; iter < 10; iter++) {
      var missing  = placed.some(function (t) { return t.x < -1000; });
      var overflow = b.L < 0 || b.T < 0 || b.R > W || b.B > H;
      if (!missing && !overflow) break;
      // Base 0.93 linear shrink (≈ 0.86 area). If overflow, take the
      // tighter of cluster-to-viewport ratios so we converge fast.
      var scale = 0.93;
      if (overflow) {
        var clW = b.R - b.L, clH = b.B - b.T;
        var sx = (W * 0.96) / Math.max(clW, W * 0.96);
        var sy = (H * 0.94) / Math.max(clH, H * 0.94);
        scale = Math.min(scale, sx, sy);
      }
      tiles.forEach(function (t) { t.fullW *= scale; t.fullH *= scale; });
      placed = maskPack(tiles, W, H, xBias, yBias, pad);
      b = clusterBounds(placed);
    }

    // Re-centre the cluster in the viewport so a small cluster doesn't
    // drift to one side from the spiral's center-of-mass bias.
    var dx = W / 2 - (b.L + b.R) / 2;
    var dy = H / 2 - (b.T + b.B) / 2;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
      placed.forEach(function (t) { if (t.x > -1000) { t.x += dx; t.y += dy; } });
    }

    placed.forEach(function (r) {
      var s = r.data;
      // com flows through so the worker's JIT Gemini job uses the right
      // common name in its prompt for a freshly-detected species.
      // &v=IMG_VERSION busts CF edge cache when we re-render any species.
      var img = './avian/api/cutout.php?sci=' + encodeURIComponent(s.sci) +
        (s.com ? '&com=' + encodeURIComponent(s.com) : '') +
        (r.pose === 2 ? '&pose=2' : '') +
        '&v=' + IMG_VERSION;
      var btn = document.createElement('button');
      btn.className = 'gtile';
      btn.type = 'button';
      btn.setAttribute('data-sci', s.sci);
      btn.setAttribute('aria-label', s.com);
      // Fallback for keyboard / screen-reader users - the visible hover
      // pill below is the primary affordance for sighted mouse users.
      // "calls" (not "heard") because one bird can rack up dozens of
      // detections in a session; "heard" implies distinct individuals.
      var titleN = +s.n || 0;
      btn.title = (s.com || s.sci) + ' · ' + fmtN(titleN) + ' ' +
        (titleN === 1 ? 'call' : 'calls') + ' ' + windowLabel(currentHours);
      btn.style.left   = r.x + 'px';
      btn.style.top    = r.y + 'px';
      btn.style.width  = r.fullW + 'px';
      btn.style.height = r.fullH + 'px';
      btn.innerHTML = '<img loading="lazy" decoding="async" src="' + img + '" alt="' + s.com + '">';
      r.el = btn;
      collage.appendChild(btn);
    });
    // Hover pill - created once per render so collage.innerHTML='' at
    // the top of this function doesn't strand a stale node. mousemove
    // populates its text from hit.data so the count is whatever the
    // current window's data says.
    var tip = document.createElement('div');
    tip.id = 'collageTip';
    tip.className = 'collage-tip';
    tip.setAttribute('aria-hidden', 'true');
    collage.appendChild(tip);
    // Stash the placed tiles so the alpha-mask hit-tester (below) can
    // resolve which silhouette the cursor is actually over.
    collagePlaced = placed.filter(function (t) { return t.x > -1000; });

    // Bloom the birds in from the centre outward, but only when asked
    // (first load, window change, view switch) - never on the silent 30s
    // poll or a resize, which render without the animate flag.
    if (animate) playCollageEntrance();
  }

  // Staggered centre-out entrance: each tile fades + scales in, delayed by
  // its distance from the collage centre, so the flock blooms from the
  // middle out. Re-applied with a reflow reset so it can replay on demand
  // (e.g. switching back to the collage view).
  var collageEntranceT = null;
  function playCollageEntrance() {
    var tiles = [].slice.call(collage.querySelectorAll('.gtile'));
    if (!tiles.length) return;
    var cx = collage.clientWidth / 2, cy = collage.clientHeight / 2;
    var maxD = 1;
    var info = tiles.map(function (t) {
      var d = Math.hypot((t.offsetLeft + t.offsetWidth / 2) - cx,
                         (t.offsetTop + t.offsetHeight / 2) - cy);
      if (d > maxD) maxD = d;
      return { el: t, d: d };
    });
    var SPREAD = 520;   // ms from the centre bird to the outermost
    info.forEach(function (o) {
      o.el.classList.remove('entering');
      o.el.style.animationDelay = ((o.d / maxD) * SPREAD).toFixed(0) + 'ms';
    });
    void collage.offsetWidth;   // commit the reset so the animation replays
    info.forEach(function (o) { o.el.classList.add('entering'); });
    // Safety net: the keyframe starts the tiles hidden (backwards fill), so
    // if the animation never advances (a backgrounded/throttled tab where
    // CSS animation time is frozen), strip the class after the bloom's
    // worst-case duration so the birds always end visible. A no-op when the
    // animation ran normally - it's already at the base (visible) state.
    clearTimeout(collageEntranceT);
    collageEntranceT = setTimeout(function () {
      info.forEach(function (o) { o.el.classList.remove('entering'); o.el.style.animationDelay = ''; });
    }, SPREAD + 520);
  }

  // Atlas entrance: cards rise + fade in row by row, top to bottom. Cards
  // sharing an offsetTop are one row, so they appear together; each row
  // down adds a small delay (capped so a long lifelist doesn't crawl).
  var atlasEntranceT = null;
  // lead: ms to hold every card hidden before the cascade starts. On a view
  // switch this is set to ~the view-slide duration so the row-by-row load-in
  // begins as the view settles (not while it's still sliding in). The cards'
  // `backwards` fill keeps them hidden during the lead, so there's no flash.
  // In-place re-renders (sort change) pass no lead - they fire immediately.
  function playAtlasEntrance(lead) {
    lead = lead || 0;
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    var cards = [].slice.call(grid.querySelectorAll('.bird-card'));
    if (!cards.length) return;
    var uniqTops = cards.map(function (c) { return c.offsetTop; })
      .sort(function (a, b) { return a - b; })
      .filter(function (v, i, a) { return i === 0 || v !== a[i - 1]; });
    var rowOf = {}; uniqTops.forEach(function (t, i) { rowOf[t] = i; });
    // Each row trails the one above by PER_ROW ms. At 90ms against the 480ms
    // card animation the rows clearly cascade top-to-bottom (a row starts when
    // the one above is ~1/5 in) instead of reading as one simultaneous fade.
    // MAX_ROW caps the stagger so a long lifelist's off-screen rows don't crawl.
    var PER_ROW = 90, MAX_ROW = 10;
    cards.forEach(function (c) {
      c.classList.remove('entering');
      c.style.animationDelay = (lead + Math.min(rowOf[c.offsetTop] || 0, MAX_ROW) * PER_ROW) + 'ms';
    });
    void grid.offsetWidth;
    cards.forEach(function (c) { c.classList.add('entering'); });
    clearTimeout(atlasEntranceT);
    atlasEntranceT = setTimeout(function () {
      cards.forEach(function (c) { c.classList.remove('entering'); c.style.animationDelay = ''; });
    }, lead + MAX_ROW * PER_ROW + 540);
  }

  // Stats entrance: timeline columns fade in left -> right (by their x
  // position), with the side panel fading in just behind. Opacity only.
  var statsEntranceT = null;
  // lead: see playAtlasEntrance. On a view switch the whole graph is held
  // hidden until the slide settles, then populates left-to-right; in-place
  // re-renders (window-picker change) pass no lead and animate immediately.
  function playStatsEntrance(lead) {
    lead = lead || 0;
    var plot = document.querySelector('.stats-tl-plot');
    if (!plot) return;
    var SPREAD = 460;
    // The whole graph populates left-to-right: columns, gridlines and
    // x-ticks stagger by their x%; the y-axis leads (delay 0) and the side
    // panel trails. animationDelay carries the per-element offset.
    var items = [].slice.call(plot.querySelectorAll('.stats-tl-col, .stats-tl-gridline, .stats-tl-xtick'))
      .map(function (el) { return { el: el, d: ((parseFloat(el.style.left) || 0) / 100) * SPREAD }; });
    var yaxis = document.querySelector('.stats-tl-yaxis');
    if (yaxis) items.push({ el: yaxis, d: 0 });
    // Side panel loads in tandem: section headers + captions lead, then
    // their rows populate top-to-bottom over the same window as the graph.
    var side = document.querySelector('.stats-side');
    if (side) {
      [].slice.call(side.querySelectorAll('h3, small')).forEach(function (el) { items.push({ el: el, d: 40 }); });
      var rows = [].slice.call(side.querySelectorAll('li'));
      rows.forEach(function (el, i) { items.push({ el: el, d: 80 + (i / Math.max(1, rows.length - 1)) * SPREAD }); });
    }
    items.forEach(function (o) { o.el.classList.remove('entering'); o.el.style.animationDelay = Math.round(lead + o.d) + 'ms'; });
    void plot.offsetWidth;
    items.forEach(function (o) { o.el.classList.add('entering'); });
    clearTimeout(statsEntranceT);
    statsEntranceT = setTimeout(function () {
      items.forEach(function (o) { o.el.classList.remove('entering'); o.el.style.animationDelay = ''; });
    }, lead + SPREAD + 560);
  }

  // ---- Alpha-mask hover/click hit-testing ----
  // The .gtile buttons are rectangles and their bounding boxes overlap
  // (tight nesting). A plain :hover would light up whichever rectangle
  // is on top - often not the bird under the cursor. So we hit-test
  // the cursor against each tile's binary alpha mask and only the
  // genuinely-hit silhouette gets .is-hover / receives the click.
  var collagePlaced = [];
  var collageHovered = null;
  function maskHitTest(clientX, clientY) {
    var box = collage.getBoundingClientRect();
    var px = clientX - box.left, py = clientY - box.top;
    // Iterate topmost-first (later in DOM = painted on top).
    for (var i = collagePlaced.length - 1; i >= 0; i--) {
      var t = collagePlaced[i];
      if (px < t.x || py < t.y || px > t.x + t.fullW || py > t.y + t.fullH) continue;
      var mx = ((px - t.x) / t.fullW * t.mask.w) | 0;
      var my = ((py - t.y) / t.fullH * t.mask.h) | 0;
      // Build a fast lookup set once per mask.
      if (!t.mask._set) {
        var set = {};
        var cells = t.mask.cells;
        for (var c = 0; c < cells.length; c++) set[cells[c][0] + '|' + cells[c][1]] = 1;
        t.mask._set = set;
      }
      if (t.mask._set[mx + '|' + my]) return t;
    }
    return null;
  }
  collage.addEventListener('mousemove', function (ev) {
    var hit = maskHitTest(ev.clientX, ev.clientY);
    if (hit === collageHovered) return;
    if (collageHovered && collageHovered.el) collageHovered.el.classList.remove('is-hover');
    collageHovered = hit;
    if (hit && hit.el) hit.el.classList.add('is-hover');
    collage.style.cursor = hit ? 'pointer' : 'default';
    var tip = document.getElementById('collageTip');
    if (tip) {
      if (hit) {
        var s = hit.data;
        var n = +s.n || 0;
        var noun = (n === 1) ? 'call' : 'calls';
        tip.innerHTML = '<span class="ct-name">' + (s.com || s.sci) + '</span>'
          + '<span class="ct-w"> - </span>'
          + '<span class="ct-n">' + fmtN(n) + '</span>'
          + '<span class="ct-w"> ' + noun + ' ' + windowLabel(currentHours) + '</span>';
        tip.setAttribute('aria-hidden', 'false');
      } else {
        tip.setAttribute('aria-hidden', 'true');
      }
    }
  });
  collage.addEventListener('mouseleave', function () {
    if (collageHovered && collageHovered.el) collageHovered.el.classList.remove('is-hover');
    collageHovered = null;
    var tip = document.getElementById('collageTip');
    if (tip) tip.setAttribute('aria-hidden', 'true');
  });
  collage.addEventListener('click', function (ev) {
    var hit = maskHitTest(ev.clientX, ev.clientY);
    if (!hit) return;
    location.hash = '#sci=' + encodeURIComponent(hit.data.sci);
    go(2);
  });

  // Debug hook - call __layout({ slugs, weights, n }) from devtools to
  // re-render the collage with a custom item set. Lets us prove the
  // nester handles 6/12/24/48 birds and varied size hierarchies without
  // touching the source.
  window.__layout = function (opts) {
    opts = opts || {};
    var allSlugs = Object.keys({"acanthis-flammea":[560,372],"accipiter-cooperii":[558,560],"accipiter-gentilis":[558,560],"accipiter-striatus":[375,560],"actitis-macularius":[560,409],"aechmophorus-occidentalis":[525,560],"aegolius-acadicus":[560,558],"aeronautes-saxatalis":[560,439],"agelaius-phoeniceus":[276,560],"aix-sponsa":[560,378],"ammodramus-savannarum":[560,436],"amphispiza-bilineata":[560,559],"anas-crecca":[560,288],"anas-platyrhynchos":[558,560],"anser-albifrons":[560,439],"anthus-rubescens":[375,560],"aphelocoma-californica":[560,373],"aphelocoma-woodhouseii":[468,560],"aquila-chrysaetos":[437,560],"archilochus-alexandri":[560,344],"ardea-alba":[560,465],"ardea-herodias":[560,373],"artemisiospiza-belli":[560,435],"asio-flammeus":[560,560],"asio-otus":[404,560],"athene-cunicularia":[560,373],"aythya-affinis":[560,372],"aythya-americana":[560,553],"aythya-collaris":[560,373],"aythya-valisineria":[560,373],"baeolophus-inornatus":[560,311],"bombycilla-cedrorum":[339,560],"bombycilla-garrulus":[560,559],"branta-canadensis":[560,559],"bubo-virginianus":[373,560],"bubulcus-ibis":[267,560],"bucephala-albeola":[560,408],"bucephala-clangula":[560,242],"buteo-jamaicensis":[560,374],"buteo-lagopus":[560,244],"buteo-lineatus":[463,560],"buteo-regalis":[408,560],"buteo-swainsoni":[560,408],"butorides-virescens":[555,560],"calamospiza-melanocorys":[560,374],"calidris-alba":[560,371],"calidris-alpina":[560,374],"callipepla-californica":[560,372],"calothorax-lucifer":[465,560],"calypte-anna":[560,344],"calypte-costae":[560,409],"cardellina-pusilla":[560,281],"cardellina-rubrifrons":[527,560],"cathartes-aura":[376,560],"catharus-guttatus":[560,333],"catharus-ustulatus":[560,408],"catherpes-mexicanus":[320,560],"certhia-americana":[201,560],"chaetura-vauxi":[560,374],"charadrius-vociferus":[560,408],"chondestes-grammacus":[560,559],"chordeiles-minor":[560,319],"cinclus-mexicanus":[560,465],"circus-hudsonius":[372,560],"cistothorus-palustris":[437,560],"coccothraustes-vespertinus":[560,466],"colaptes-auratus":[560,560],"columba-livia":[560,327],"columbina-passerina":[560,559],"contopus-sordidulus":[560,502],"coragyps-atratus":[560,557],"corvus-brachyrhynchos":[560,503],"corvus-corax":[343,560],"cyanocitta-stelleri":[363,560],"cygnus-buccinator":[560,370],"cypseloides-niger":[560,356],"dryobates-nuttallii":[560,321],"dryobates-pubescens":[560,558],"dryobates-villosus":[268,560],"dryocopus-pileatus":[492,560],"egretta-caerulea":[560,321],"egretta-thula":[560,374],"elanus-leucurus":[560,378],"empidonax-difficilis":[268,560],"empidonax-hammondii":[558,560],"empidonax-oberholseri":[495,560],"empidonax-traillii":[371,560],"empidonax-wrightii":[560,527],"eremophila-alpestris":[560,529],"euphagus-cyanocephalus":[560,371],"falco-columbarius":[560,408],"falco-mexicanus":[349,560],"falco-peregrinus":[465,560],"falco-sparverius":[560,370],"gavia-immer":[560,374],"geothlypis-tolmiei":[560,406],"geothlypis-trichas":[560,316],"glaucidium-gnoma":[560,560],"gymnogyps-californianus":[466,560],"haemorhous-mexicanus":[523,560],"haemorhous-purpureus":[560,387],"haliaeetus-leucocephalus":[560,434],"himantopus-mexicanus":[458,560],"hirundo-rustica":[560,410],"hydroprogne-caspia":[560,373],"icteria-virens":[560,293],"icterus-bullockii":[560,214],"icterus-cucullatus":[391,560],"icterus-galbula":[560,528],"icterus-parisorum":[560,266],"ixoreus-naevius":[560,558],"junco-hyemalis":[560,320],"lanius-ludovicianus":[408,560],"larus-californicus":[560,437],"larus-delawarensis":[560,376],"larus-glaucescens":[560,374],"larus-heermanni":[560,436],"larus-occidentalis":[560,412],"leiothlypis-celata":[522,560],"leiothlypis-lucidae":[351,560],"leucophaeus-atricilla":[560,373],"leucophaeus-pipixcan":[560,560],"leucosticte-tephrocotis":[560,465],"limosa-fedoa":[560,556],"lophodytes-cucullatus":[560,409],"loxia-curvirostra":[560,319],"mareca-americana":[560,375],"mareca-strepera":[560,372],"megaceryle-alcyon":[560,409],"megascops-kennicottii":[560,374],"melanerpes-formicivorus":[351,560],"melanerpes-lewis":[372,560],"meleagris-gallopavo":[560,373],"melospiza-georgiana":[320,560],"melospiza-lincolnii":[560,245],"melospiza-melodia":[560,352],"melozone-aberti":[560,268],"melozone-crissalis":[560,538],"melozone-fusca":[560,495],"mergus-merganser":[560,374],"mimus-polyglottos":[560,310],"mniotilta-varia":[560,351],"molothrus-ater":[560,505],"myadestes-townsendi":[560,436],"myiarchus-cinerascens":[560,532],"nucifraga-columbiana":[560,373],"numenius-americanus":[558,560],"nycticorax-nycticorax":[560,465],"oreothlypis-ruficapilla":[372,560],"pandion-haliaetus":[560,371],"passer-domesticus":[560,444],"passerculus-sandwichensis":[560,542],"passerella-iliaca":[560,350],"passerina-amoena":[560,465],"passerina-cyanea":[560,560],"patagioenas-fasciata":[560,500],"pelecanus-erythrorhynchos":[560,316],"pelecanus-occidentalis":[560,406],"perisoreus-canadensis":[560,349],"petrochelidon-pyrrhonota":[558,560],"phainopepla-nitens":[560,464],"phalacrocorax-auritus":[490,560],"phalaenoptilus-nuttallii":[560,373],"phasianus-colchicus":[560,409],"pheucticus-melanocephalus":[559,560],"pica-nuttalli":[560,320],"picoides-arcticus":[374,560],"pinicola-enucleator":[560,372],"pipilo-chlorurus":[560,318],"pipilo-erythrophthalmus":[352,560],"pipilo-maculatus":[443,560],"piranga-ludoviciana":[293,560],"piranga-rubra":[560,495],"plegadis-chihi":[560,372],"podiceps-nigricollis":[560,374],"podilymbus-podiceps":[560,374],"poecile-gambeli":[560,350],"poecile-rufescens":[560,339],"polioptila-caerulea":[560,557],"pooecetes-gramineus":[560,436],"progne-subis":[313,560],"psaltriparus-minimus":[560,428],"quiscalus-mexicanus":[560,269],"recurvirostra-americana":[268,560],"regulus-calendula":[496,560],"regulus-satrapa":[464,560],"riparia-riparia":[560,494],"rynchops-niger":[560,374],"salpinctes-obsoletus":[560,465],"sayornis-nigricans":[308,560],"sayornis-saya":[463,560],"selasphorus-platycercus":[560,497],"selasphorus-rufus":[560,436],"selasphorus-sasin":[434,560],"setophaga-coronata":[461,560],"setophaga-magnolia":[560,268],"setophaga-nigrescens":[560,350],"setophaga-occidentalis":[560,367],"setophaga-palmarum":[438,560],"setophaga-petechia":[560,268],"setophaga-ruticilla":[560,293],"setophaga-townsendi":[560,416],"sialia-currucoides":[558,560],"sialia-mexicana":[560,371],"sitta-canadensis":[560,379],"sitta-carolinensis":[436,560],"sitta-pygmaea":[560,407],"spatula-clypeata":[560,408],"spatula-discors":[560,493],"sphyrapicus-ruber":[560,558],"sphyrapicus-thyroideus":[374,560],"spinus-lawrencei":[560,373],"spinus-pinus":[560,516],"spinus-psaltria":[560,548],"spinus-tristis":[536,560],"spizella-atrogularis":[246,560],"spizella-breweri":[560,557],"spizella-passerina":[560,320],"spizelloides-arborea":[560,436],"stelgidopteryx-serripennis":[558,560],"sterna-forsteri":[560,373],"sterna-hirundo":[560,411],"streptopelia-decaocto":[560,393],"strix-occidentalis":[560,553],"sturnella-neglecta":[320,560],"sturnus-vulgaris":[560,545],"tachycineta-bicolor":[375,560],"tachycineta-thalassina":[560,435],"thalasseus-elegans":[560,407],"thryomanes-bewickii":[560,263],"toxostoma-redivivum":[560,298],"tringa-semipalmata":[560,464],"troglodytes-aedon":[560,494],"troglodytes-pacificus":[560,407],"turdus-migratorius":[560,402],"tyrannus-verticalis":[559,560],"tyrannus-vociferans":[495,560],"tyto-alba":[560,464],"urile-penicillatus":[296,560],"vireo-bellii":[560,559],"vireo-cassinii":[560,319],"vireo-gilvus":[464,560],"vireo-huttoni":[410,560],"xanthocephalus-xanthocephalus":[293,560],"zenaida-asiatica":[560,558],"zenaida-macroura":[522,560],"zonotrichia-atricapilla":[560,238],"zonotrichia-leucophrys":[560,313],"zonotrichia-querula":[560,294]});
    var slugs = opts.slugs || allSlugs.slice(0, opts.n || 12);
    var weights = opts.weights;
    var items = slugs.map(function (slug, i) {
      // Recover a sci name from the slug - capitalize first segment.
      var parts = slug.split('-');
      var sci = parts.slice(0, 2).map(function (p, j) { return j === 0 ? p[0].toUpperCase() + p.slice(1) : p; }).join(' ');
      var n;
      if (weights === 'uniform') n = 10;
      else if (weights === 'extreme') n = i === 0 ? 500 : 1;
      else if (Array.isArray(weights)) n = weights[i] || 1;
      else n = Math.pow(0.55, i) * 100; // default hierarchy
      return { sci: sci, com: sci, n: n };
    });
    renderCollage(items);
    return { rendered: items.length, mode: weights || 'hierarchy' };
  };

  // Collage renders whatever is in DATA.recent.species. When the picker
  // changes, refreshRecent() refetches and re-renders. Empty state shows
  // a "no detections in this window" message.
  function renderCollageFromData(animate) {
    var items = (DATA.recent && DATA.recent.species) || [];
    renderCollage(items, animate);
  }
  var rTimer;
  window.addEventListener('resize', function () {
    clearTimeout(rTimer);
    rTimer = setTimeout(function () {
      renderCollageFromData();
      drawHistograms();
    }, 120);
  });

  // ---- Stats / Atlas data ----
  function setRow(id, label, val) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = '<span>' + label + '</span><span>' + (val == null || val === '' ? '-' : val) + '</span>';
  }
  function liRow(yr, label, ct, sci) {
    var attr = sci ? ' data-sci="' + sci.replace(/"/g, '&quot;') + '"' : '';
    return '<li' + attr + '><span class="yr">' + yr + '</span><span>' + label + '</span><span class="ct">' + (ct == null ? '-' : ct) + '</span></li>';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtN(n) {
    if (n == null) return '-';
    if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
    return n.toLocaleString();
  }
  // Human label for the current time-window picker selection - replaces
  // a bare "window" with the span it actually covers. Thresholds match
  // the winPick buttons (1H / 12H / 24H / 7D / ALL).
  function windowLabel(h) {
    if (h <= 1) return 'this hour';
    if (h <= 12) return 'past 12h';
    if (h <= 24) return 'today';
    if (h <= 168) return 'this week';
    return 'all time';
  }

  // ---- Live Pi data layer ----
  // All views read from this DATA object. Populated by fetchAll() on page
  // load and by refreshRecent() when the window picker changes.
  var STATS_DAYS = 30;
  var DATA = {
    stats: null,        // ./avian/api/birdnet-api.php?action=stats (totals/today/week/last_hour/started)
    lifelist: null,     // ./avian/api/birdnet-api.php?action=lifelist (every species ever detected)
    timeseries: null,   // ./avian/api/birdnet-api.php?action=timeseries (daily + hourly aggregates)
    firstseen: null,    // ./avian/api/birdnet-api.php?action=firstseen (newest lifelist additions)
    recent: null,       // ./avian/api/birdnet-api.php?action=recent&hours=N (refetched on picker change)
  };

  // Derived chart arrays, backfilled so 30 buckets always exist.
  var STATS = {
    detPerDay:  new Array(STATS_DAYS).fill(0), // [day] total detections
    specPerDay: new Array(STATS_DAYS).fill(0), // [day] unique species
    byHour:     new Array(24).fill(0),         // [hour-of-day] detections
  };

  // Map sci -> all-time detection count, populated from lifelist for atlas.
  var speciesTotals = {};

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function backfillDaily(daily, days) {
    // Build a continuous array of (days) length, ending today.
    var byDate = {};
    (daily || []).forEach(function (row) { byDate[row.date] = row; });
    var out = new Array(days).fill(null).map(function () { return { detections: 0, species: 0 }; });
    var today = new Date();
    for (var i = 0; i < days; i++) {
      var d = new Date(today);
      d.setDate(today.getDate() - (days - 1 - i));
      var key = d.toISOString().slice(0, 10);
      if (byDate[key]) {
        out[i].detections = +byDate[key].detections || 0;
        out[i].species    = +byDate[key].species    || 0;
      }
    }
    return out;
  }

  function recomputeDerived() {
    var ts = DATA.timeseries || { daily: [], by_hour: [] };
    var ll = DATA.lifelist || { species: [] };
    var rows = backfillDaily(ts.daily, STATS_DAYS);
    STATS.detPerDay  = rows.map(function (r) { return r.detections; });
    STATS.specPerDay = rows.map(function (r) { return r.species; });
    var byHour = new Array(24).fill(0);
    (ts.by_hour || []).forEach(function (r) { byHour[+r.hour] = +r.detections; });
    STATS.byHour = byHour;
    speciesTotals = {};
    (ll.species || []).forEach(function (s) { speciesTotals[s.sci] = +s.n; });
  }

  // Editorial detection timeline. One evenly-spaced column per species,
  // ordered oldest -> newest by last detection (x = time). Each species
  // owns a cell, so the black squares never overlap and a square fills
  // its column width - neighbours touch at the shared gridline. The
  // square's height up the column encodes detection count; a small
  // rotated label (common + scientific name) sits at the column's
  // bottom, and each column carries its own timestamp on the x-axis.
  function drawHistograms(animate) {
    var tl = document.getElementById('statsTimeline');
    if (!tl) return;
    var all = ((DATA.recent && DATA.recent.species) || []).slice();
    if (!all.length) {
      tl.innerHTML = '<div class="stats-tl-empty">no detections in this window</div>';
      return;
    }

    // Discrete columns. On a phone the columns are fixed-width and wider
    // (legible squares + labels for touch) and the plot grows past the
    // viewport to scroll horizontally - so we show ALL species rather than
    // trimming. On desktop, cap to whatever fits the available width.
    var isMobile = (window.innerWidth || 800) <= 700;
    var containerW = Math.max(140, (tl.clientWidth || window.innerWidth || 800) - 34);
    var MIN_COL = isMobile ? 52 : 22;
    var cap = isMobile ? all.length : Math.max(3, Math.floor(containerW / MIN_COL));
    var trimmed = all.length > cap;
    var species = all.slice();
    if (trimmed) {
      species.sort(function (a, b) { return (+b.n || 0) - (+a.n || 0); });
      species = species.slice(0, cap);
    }
    // X-axis is time: order the chosen columns oldest -> newest.
    function parseTs(s) { return s ? Date.parse(s.replace(' ', 'T')) : NaN; }
    species.sort(function (a, b) {
      var ta = parseTs(a.last_seen), tb = parseTs(b.last_seen);
      if (isNaN(ta)) return 1;
      if (isNaN(tb)) return -1;
      return ta - tb;
    });

    var C = species.length;
    var maxN = species.reduce(function (m, s) { return Math.max(m, +s.n || 0); }, 1);
    // Mobile: fixed wide columns -> plot can exceed the viewport and scroll.
    // Desktop: columns split the available width evenly.
    var colW = isMobile ? MIN_COL : (containerW / C);
    var plotW = isMobile ? Math.max(containerW, C * colW) : containerW;
    // Square fills its column so adjacent squares touch at the shared
    // gridline; capped so a few species don't render as giant blocks.
    var sq = Math.max(6, Math.min(colW, isMobile ? 60 : 48));
    var LABEL_GAP = 6;       // px between a square's top and its label
    var SPAN = 0.55;         // squares occupy the bottom this fraction of
                             // the plot by count (y = quantity); the
                             // rotated label floats just above each square.

    // Y-axis quantity ticks: 0..maxN, with maxN pinned on the top tick.
    var ticks = [];
    if (maxN <= 8) {
      for (var v = 0; v <= maxN; v++) ticks.push(v);
    } else {
      var divs = 4;
      for (var di = 0; di <= divs; di++) ticks.push(Math.round(maxN * di / divs));
      ticks[ticks.length - 1] = maxN;
    }
    var yaxis = ticks.map(function (v) {
      return '<span class="stats-tl-ytick" style="bottom:' + ((v / maxN) * SPAN * 100).toFixed(1) + '%">' + v + '</span>';
    }).join('');

    // One timestamp under each column - format follows the window length.
    function fmtTs(ms) {
      if (isNaN(ms)) return '';
      var d = new Date(ms);
      var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
      if (currentHours <= 36) return p2(d.getHours()) + ':' + p2(d.getMinutes());
      if (currentHours <= 75 * 24) return (d.getMonth() + 1) + '/' + d.getDate();
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Faint gridlines at every column boundary. Start at gi=1: the gi=0
    // line would sit on top of the y-axis rule (double line), so skip it.
    var gridlines = '';
    for (var gi = 1; gi <= C; gi++) {
      gridlines += '<i class="stats-tl-gridline" style="left:' + (gi / C * 100).toFixed(3) + '%"></i>';
    }

    var cols = '', xaxis = '';
    species.forEach(function (s, i) {
      var centerPct = (i + 0.5) / C * 100;
      var n = +s.n || 0;
      var bottomPct = (n / maxN) * SPAN * 100;   // square height = quantity
      cols += ''
        + '<div class="stats-tl-col" data-sci="' + s.sci + '" style="left:' + centerPct.toFixed(3) + '%;width:' + colW.toFixed(2) + 'px">'
        +   '<div class="stats-tl-square" style="bottom:' + bottomPct.toFixed(1) + '%;width:' + sq.toFixed(1) + 'px;height:' + sq.toFixed(1) + 'px"></div>'
        +   '<div class="stats-tl-label" style="bottom:calc(' + bottomPct.toFixed(1) + '% + ' + (sq + LABEL_GAP) + 'px)"><span class="com">' + (s.com || s.sci) + '</span><span class="sci">' + s.sci + '</span></div>'
        + '</div>';
      var lab = fmtTs(parseTs(s.last_seen));
      if (lab) xaxis += '<span class="stats-tl-xtick" style="left:' + centerPct.toFixed(3) + '%">' + lab + '</span>';
    });

    var note = trimmed
      ? '<div class="stats-tl-cap">' + C + ' most-heard of ' + all.length + '</div>'
      : '';
    tl.innerHTML =
      '<div class="stats-tl-yaxis">' + yaxis + '</div>'
      + '<div class="stats-tl-plot"' + (isMobile ? ' style="width:' + Math.round(plotW) + 'px"' : '') + '>'
      +   gridlines + cols + xaxis
      + '</div>'
      + note;
    if (animate) playStatsEntrance();
  }

  // Cross-highlight between the timeline squares and the right-side
  // species lists. Delegated off the stats view so it survives the
  // periodic re-render of both halves.
  (function wireStatsHighlight() {
    var v1 = document.getElementById('v1');
    if (!v1) return;
    function setHi(sci, on) {
      if (!sci) return;
      var esc = sci.replace(/"/g, '\"');
      v1.querySelectorAll('.stats-tl-col[data-sci="' + esc + '"], .stats-side li[data-sci="' + esc + '"]')
        .forEach(function (el) { el.classList.toggle('sync-hi', on); });
    }
    v1.addEventListener('mouseover', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-sci]');
      if (el) setHi(el.getAttribute('data-sci'), true);
    });
    v1.addEventListener('mouseout', function (ev) {
      var el = ev.target.closest && ev.target.closest('[data-sci]');
      if (el) {
        // Only clear if we're actually leaving the element (not moving
        // to a child).
        var to = ev.relatedTarget;
        if (to && el.contains(to)) return;
        setHi(el.getAttribute('data-sci'), false);
      }
    });
  })();

  // ---- Side text lists (real Pi data) ----
  function renderStatsLists() {
    var stats = DATA.stats || {};
    var recent = DATA.recent || { species: [] };
    var firstseen = DATA.firstseen || { species: [] };

    // By Period - pulled directly from ./avian/api/birdnet-api.php?action=stats so the numbers
    // are authoritative (BirdNET-Pi's own counts).
    var last_hour = (stats.last_hour && stats.last_hour.detections) || 0;
    var today_det = (stats.today && stats.today.detections) || 0;
    var week_det = (stats.week && stats.week.detections) || 0;
    var all_det = (stats.totals && stats.totals.detections) || 0;
    document.getElementById('statsByPeriod').innerHTML =
        liRow('NOW',   'last hour',   fmtN(last_hour))
      + liRow('TODAY', 'today',       fmtN(today_det))
      + liRow('WEEK',  'last 7 days', fmtN(week_det))
      + liRow('ALL',   'all time',    fmtN(all_det));

    // Top Species - top 5 species in the current window. ./avian/api/birdnet-api.php?action=recent
    // already returns species sorted by last_seen DESC; re-sort by count.
    var ranked = (recent.species || [])
      .slice()
      .sort(function (a, b) { return (+b.n) - (+a.n); })
      .slice(0, 5);
    document.getElementById('statsTopSpec').innerHTML = ranked.length
      ? ranked.map(function (s, i) { return liRow(pad(i + 1), s.com, fmtN(+s.n), s.sci); }).join('')
      : liRow('-', 'no detections in window', '');
    document.getElementById('statsTopSpecCap').textContent =
      'most-heard, ' + windowLabel(currentHours);

    // First Detections - newest additions to the life list, with a
    // "Xd ago" label computed from first_seen.
    var fs = (firstseen.species || []).slice(0, 5);
    var now = Date.now();
    document.getElementById('statsFirstSeen').innerHTML = fs.length
      ? fs.map(function (s) {
          var t = Date.parse((s.first_seen || '').replace(' ', 'T'));
          var label = '-';
          if (!isNaN(t)) {
            var daysAgo = Math.floor((now - t) / 86400000);
            label = daysAgo === 0 ? 'today' : daysAgo + 'd ago';
          }
          return liRow(label, s.com, '', s.sci);
        }).join('')
      : liRow('-', 'no detections yet', '');
  }

  // ---- Atlas: field-guide card grid ----
  // eBird species codes for placeholder birds. eBird's URL scheme is
  // https://ebird.org/species/<code>/, where <code> is a stable 6-char
  // taxonomy code. Hardcoded here for the local-California demo set;
  // a real implementation can look these up via the eBird taxon API.
  var EBIRD_CODES = {
    'Calypte anna':           'annhum',
    'Passer domesticus':      'houspa',
    'Haemorhous mexicanus':   'houfin',
    'Turdus migratorius':     'amerob',
    'Zenaida macroura':       'moudov',
    'Spinus psaltria':        'lesgol',
    'Zonotrichia leucophrys': 'whcspa',
    'Aphelocoma californica': 'cascj1',
    'Mimus polyglottos':      'normoc',
    'Sayornis nigricans':     'blkpho',
    'Larus occidentalis':     'wegull',
    'Corvus brachyrhynchos':  'amecro'
  };

  function wikiUrl(sci) {
    return 'https://en.wikipedia.org/wiki/' + encodeURIComponent(sci.replace(/ /g, '_'));
  }
  function ebirdUrl(sci) {
    var code = EBIRD_CODES[sci];
    return code ? 'https://ebird.org/species/' + code : 'https://ebird.org/explore';
  }

  // Tiny inline icons - monochrome, ink-only, match the page palette.
  var ICON_PLAY = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 12 12" fill="currentColor"><rect x="3" y="2" width="2.5" height="8"/><rect x="6.5" y="2" width="2.5" height="8"/></svg>';

  function renderAtlas(animate) {
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;

    var lifelist = (DATA.lifelist && DATA.lifelist.species) || [];
    var recent = (DATA.recent && DATA.recent.species) || [];
    // Window count lookup: sci -> count in current window.
    var winBySci = {};
    recent.forEach(function (s) { winBySci[s.sci] = +s.n; });

    if (!lifelist.length) {
      grid.innerHTML = '<div class="atlas-empty">' +
        '<p>No birds detected yet.</p>' +
        '<p class="hint">The atlas fills up as BirdNET-Pi identifies new species.</p>' +
        '</div>';
      return;
    }

    // Time-window filter: when a windowed view is selected, only show
    // species heard in that window. ALL preserves the full lifelist.
    var isAllWindow = currentHours >= 1000000;
    var filtered = isAllWindow
      ? lifelist
      : lifelist.filter(function (s) { return (winBySci[s.sci] || 0) > 0; });
    if (!filtered.length) {
      grid.innerHTML = '<div class="atlas-empty">' +
        '<p>No detections in this window.</p>' +
        '<p class="hint">Try a longer time window - the lifelist is still here under ALL.</p>' +
        '</div>';
      return;
    }

    // Sort by the atlas-sort segmented control (defaults to "count" =
    // most-heard all time).
    var sortMode = (window.__atlasSort) || 'count';
    var species = filtered.slice();
    if (sortMode === 'count') {
      species.sort(function (a, b) { return (+b.n) - (+a.n); });
    } else if (sortMode === 'recent') {
      species.sort(function (a, b) {
        return (b.last_seen || '').localeCompare(a.last_seen || '');
      });
    } else if (sortMode === 'alpha') {
      species.sort(function (a, b) {
        return (a.com || a.sci || '').localeCompare(b.com || b.sci || '');
      });
    }

    // A species is a "lifer" in the current view if its all-time first
    // detection falls inside the selected window - i.e. it was newly added
    // to the life list this 1h / 12h / 24h / 7d. Never shown for the ALL
    // window (every species would qualify against an open-ended span).
    var now = Date.now();
    var windowStartMs = now - currentHours * 3600000;
    grid.innerHTML = species.map(function (s) {
      var total = +s.n || 0;
      var win = winBySci[s.sci] || 0;
      var firstMs = Date.parse((s.first_seen || '').replace(' ', 'T'));
      var isLifer = !isAllWindow && !isNaN(firstMs) && firstMs >= windowStartMs;
      var sketchSrc = './avian/api/cutout.php?sci=' + encodeURIComponent(s.sci) +
        (s.com ? '&com=' + encodeURIComponent(s.com) : '') +
        '&v=' + SKETCH_VERSION;
      var audioSrc = './avian/api/recording.php?sci=' + encodeURIComponent(s.sci);
      // The "all time" window makes the windowed count identical to the
      // all-time count - collapse to a single stat rather than print the
      // same number twice. Otherwise label the count with its span.
      var statRows = currentHours >= 1000000
        ? '<div><span class="n">' + fmtN(total) + '</span><span class="lbl-inline">all time</span></div>'
        : '<div><span class="n">' + fmtN(win) + '</span><span class="lbl-inline">' + windowLabel(currentHours) + '</span></div>'
          + '<div><span class="n">' + fmtN(total) + '</span><span class="lbl-inline">all time</span></div>';
      return ''
        + '<article class="bird-card" data-sci="' + s.sci + '" data-audio="' + audioSrc + '">'
        +   (isLifer ? '<span class="lifer-badge" title="new to the life list in this window">lifer</span>' : '')
        +   '<div class="stat">' + statRows + '</div>'
        +   '<div class="img-wrap">'
        +     '<img loading="lazy" decoding="async" src="' + sketchSrc + '" alt="' + s.com + '">'
        +   '</div>'
        +   '<h3>' + s.com + '</h3>'
        +   '<div class="sci">' + s.sci + '</div>'
        +   '<div class="spectro-wrap" aria-hidden="true"></div>'
        +   '<div class="actions">'
        +     '<button type="button" class="chip play" data-action="play" aria-label="play recording">'
        +       ICON_PLAY + '<span>play</span>'
        +     '</button>'
        +     '<a class="chip ext" href="' + wikiUrl(s.sci) + '" target="_blank" rel="noopener" aria-label="Wikipedia">wiki</a>'
        +     '<a class="chip ext" href="' + ebirdUrl(s.sci) + '" target="_blank" rel="noopener" aria-label="eBird">ebird</a>'
        +   '</div>'
        + '</article>';
    }).join('');

    // Wire audio playback + spectrogram load.
    // - Only one card plays at a time. Clicking play on a different card
    //   stops the current one first.
    // - The spectrogram is lazily fetched on first play (saves a Pi hit
    //   for every card visible on initial render).
    // - If the recording endpoint 404s (no detection yet for this
    //   species), the button reverts and shows "no audio".
    var currentAudio = null;
    var currentBtn = null;
    function setBtnState(btn, state) {
      btn.setAttribute('data-state', state);
      if (state === 'playing') {
        btn.setAttribute('data-active', 'true');
        btn.innerHTML = ICON_PAUSE + '<span>stop</span>';
      } else if (state === 'loading') {
        btn.setAttribute('data-active', 'true');
        btn.innerHTML = ICON_PLAY + '<span>...</span>';
      } else if (state === 'missing') {
        btn.setAttribute('data-active', 'false');
        btn.innerHTML = ICON_PLAY + '<span>no audio</span>';
        setTimeout(function () {
          if (btn.getAttribute('data-state') === 'missing') {
            btn.innerHTML = ICON_PLAY + '<span>play</span>';
            btn.setAttribute('data-state', 'idle');
          }
        }, 2200);
      } else {
        btn.setAttribute('data-active', 'false');
        btn.innerHTML = ICON_PLAY + '<span>play</span>';
      }
    }
    function clearProgressOn(card) {
      if (!card) return;
      var sw = card.querySelector('.spectro-wrap');
      if (sw) sw.style.setProperty('--prog', '0%');
      card.removeAttribute('data-playing');
    }
    function stopCurrent() {
      audioRelease(stopCurrent);
      if (currentAudio) {
        try { currentAudio.pause(); } catch (e) {}
        currentAudio = null;
      }
      if (currentBtn) {
        var card = currentBtn.closest('.bird-card');
        clearProgressOn(card);
        setBtnState(currentBtn, 'idle');
        currentBtn = null;
      }
    }
    grid.querySelectorAll('[data-action="play"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.bird-card');
        if (btn === currentBtn) { stopCurrent(); return; }
        stopCurrent();
        audioClaim(stopCurrent);   // stop any modal-recording / live-stream audio
        setBtnState(btn, 'loading');
        currentBtn = btn;
        // Render the spectrogram client-side from the recording's audio so
        // it matches the active theme. paintSpectrogram paints with the
        // --paper/--ink palette per data-theme (the same canvas the modal
        // recordings use), instead of a fixed-colour PNG that can't follow
        // light/dark mode. Decoded buffers are cached per URL.
        var spectroWrap = card.querySelector('.spectro-wrap');
        if (spectroWrap && !spectroWrap.firstChild) {
          var canvas = document.createElement('canvas');
          spectroWrap.appendChild(canvas);
          var aurl = card.dataset.audio;
          if (_decodedCache[aurl]) {
            paintSpectrogram(canvas, _decodedCache[aurl]);
          } else {
            var actx = getSpecCtx();
            if (actx) {
              fetch(aurl)
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
                .then(function (b) { return actx.decodeAudioData(b); })
                .then(function (buf) {
                  _decodedCache[aurl] = buf;
                  // Guard on document containment, not spectroWrap.contains:
                  // a 30s refreshAll() poll can rebuild the atlas and detach
                  // this card mid-decode. The detached wrap still "contains"
                  // its canvas, but a detached node measures 0x0, which would
                  // trap paintSpectrogram in its size-retry loop forever.
                  if (document.contains(canvas)) paintSpectrogram(canvas, buf);
                })
                .catch(function () { if (spectroWrap.contains(canvas)) spectroWrap.removeChild(canvas); });
            } else {
              spectroWrap.removeChild(canvas);
            }
          }
        }
        // Start audio.
        var audio = new Audio(card.dataset.audio);
        audio.addEventListener('canplay', function () {
          if (currentBtn !== btn) return; // user clicked away
          setBtnState(btn, 'playing');
          card.setAttribute('data-playing', 'true');
          audio.play();
        });
        // Progress bar on the spectrogram strip.
        audio.addEventListener('timeupdate', function () {
          if (currentBtn !== btn) return;
          var pct = audio.duration ? (audio.currentTime / audio.duration * 100) : 0;
          if (spectroWrap) spectroWrap.style.setProperty('--prog', pct.toFixed(1) + '%');
        });
        audio.addEventListener('ended', function () {
          if (currentBtn === btn) stopCurrent();
        });
        audio.addEventListener('error', function () {
          if (currentBtn === btn) {
            setBtnState(btn, 'missing');
            clearProgressOn(card);
            currentAudio = null; currentBtn = null;
          }
        });
        currentAudio = audio;
        audio.load();
      });
    });

    // Spectrogram click = scrub to that position (if playing) or restart.
    grid.addEventListener('click', function (ev) {
      var sw = ev.target.closest && ev.target.closest('.spectro-wrap');
      if (!sw || !sw.firstChild) return;
      var card = sw.closest('.bird-card');
      var btn = card.querySelector('[data-action="play"]');
      // If this card is the active one, scrub.
      if (currentBtn === btn && currentAudio && currentAudio.duration) {
        var rect = sw.getBoundingClientRect();
        var pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        currentAudio.currentTime = pct * currentAudio.duration;
      } else {
        // Otherwise start playback from the top.
        btn.click();
      }
    });
    if (animate) playAtlasEntrance();
  }

  function renderWindowDependent(animate) {
    // renderStatsLists runs BEFORE drawHistograms so the stats entrance
    // (fired at the end of drawHistograms) can stagger the side-panel rows
    // that were just built, in tandem with the graph populating.
    renderCollageFromData(animate);
    renderStatsLists();
    drawHistograms(animate);
    renderAtlas(animate);
  }
  function renderTimeIndependent(animate) {
    // Lists first, then the graph (see renderWindowDependent).
    renderStatsLists();
    drawHistograms(animate);
    renderAtlas(animate);
  }

  function refreshRecent(animate) {
    // Capture the window this fetch was issued for. If the user
    // changes the picker again before it resolves - or a slower poll
    // lands later - we discard the stale response so the collage
    // never reverts to a different window.
    var forHours = currentHours;
    return fetchJson('./avian/api/birdnet-api.php?action=recent&hours=' + forHours)
      .then(function (j) {
        if (forHours !== currentHours) return; // window changed mid-flight
        DATA.recent = j; renderWindowDependent(animate);
      })
      .catch(function (e) { console.warn('recent fetch failed', e); });
  }
  function refreshAll(animate) {
    var forHours = currentHours;
    return Promise.all([
      fetchJson('./avian/api/birdnet-api.php?action=stats').catch(function () { return null; }),
      fetchJson('./avian/api/birdnet-api.php?action=lifelist').catch(function () { return null; }),
      fetchJson('./avian/api/birdnet-api.php?action=timeseries&days=30').catch(function () { return null; }),
      fetchJson('./avian/api/birdnet-api.php?action=firstseen&limit=10').catch(function () { return null; }),
      fetchJson('./avian/api/birdnet-api.php?action=recent&hours=' + forHours).catch(function () { return null; }),
    ]).then(function (parts) {
      DATA.stats = parts[0];
      DATA.lifelist = parts[1];
      DATA.timeseries = parts[2];
      DATA.firstseen = parts[3];
      // Only accept the recent slice if the window hasn't changed
      // since this poll started - otherwise keep what's there.
      if (forHours === currentHours && parts[4]) DATA.recent = parts[4];
      recomputeDerived();
      renderTimeIndependent(animate);
      renderCollageFromData(animate);
    });
  }

  // Kick off the initial fetch. Renders pull from DATA as soon as it
  // populates; until then the page sits with empty histograms + lists.
  // animate=true so the collage blooms in on first load.
  refreshAll(true);

  // Hook into the window picker so the data refetches on change. Pass
  // animate=true so the collage blooms (the silent poll passes nothing).
  winBtns.forEach(function (b) {
    b.addEventListener('click', function () { refreshRecent(true); });
  });

  // ---- Realtime polling ----
  // Every POLL_MS the page refetches the live data set so the collage,
  // stats, and atlas reflect new detections without a manual reload.
  // We use refreshAll() (cheap: 5 small JSON fetches) so the dependent
  // text/charts update too. Polling pauses when the tab is hidden and
  // resumes (with an immediate fetch) when it becomes visible again.
  var POLL_MS = 30 * 1000;
  var pollTimer = null;
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshAll();
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopPolling();
    } else {
      // Force an immediate refresh on return so the user sees fresh
      // data right away, then resume normal polling cadence.
      refreshAll();
      startPolling();
    }
  });
  startPolling();

  // ---- Menu dropdown ----
  var dd = document.getElementById('menu-dd');
  var menuBtn = document.getElementById('menuBtn');
  var locked  = document.getElementById('dd-locked');
  var items   = document.getElementById('dd-items');
  var lockHint= document.getElementById('lockHint');
  function openDd()  { dd.classList.add('open'); dd.setAttribute('aria-hidden','false'); setTimeout(function () { document.getElementById('lockPass').focus(); }, 100); }
  function closeDd() { dd.classList.remove('open'); dd.setAttribute('aria-hidden','true'); }
  function toggleDd(){ dd.classList.contains('open') ? closeDd() : openDd(); }
  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleDd(); });
  document.addEventListener('click', function (e) { if (!dd.contains(e.target) && e.target !== menuBtn) closeDd(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDd(); });

  // Probe menu.php with no Authorization header. On a LAN deploy
  // (AV_REQUIRE_AUTH=0) it returns 200 immediately so the drawer
  // renders directly. On a forwarded deploy with Caddy basic_auth in
  // front, Caddy will already have validated credentials before this
  // request reaches PHP - so a 200 here means we're authed, a 401
  // means Caddy rejected and we need the lock-screen flow.
  function tryAutoUnlock() {
    fetch('./avian/api/menu.php', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 200) {
        return r.json().then(function (j) { renderMenu(j.items || []); });
      }
    }).catch(function () {});
  }
  tryAutoUnlock();

  document.getElementById('unlockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    // BirdNET-Pi's upstream Caddyfile basicauth user is `birdnet`.
    // If your install changed it (custom Caddyfile), set window.AV_AUTH_USER
    // before this script loads - e.g. an inline <script> in index.html.
    var u = (window.AV_AUTH_USER || 'birdnet');
    var p = document.getElementById('lockPass').value;
    var hdr = 'Basic ' + btoa(u + ':' + p);
    // POST to menu.php with the header so the browser caches the basic
    // creds for every subsequent request. If Caddy basic_auth accepts
    // them we get a 200 and the drawer renders; 401 means wrong password.
    fetch('./avian/api/menu.php', {
      method: 'POST',
      headers: { 'Authorization': hdr },
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 200) {
        return r.json().then(function (j) { renderMenu(j.items || []); });
      } else if (r.status === 401) {
        lockHint.textContent = 'wrong password.';
        lockHint.classList.add('lock-err');
      } else {
        lockHint.textContent = 'auth unavailable.';
        lockHint.classList.add('lock-err');
      }
    }).catch(function () {
      lockHint.textContent = 'network error.';
      lockHint.classList.add('lock-err');
    });
  });

  // Render the unlocked drawer:
  //   - inline LIVE AUDIO player (streams icecast through the worker tunnel)
  //   - collapsible SETTINGS section (closed by default to avoid mis-clicks)
  //   - small ADVANCED TOOLS grid for the rest of BirdNET-Pi (still
  //     opens externally; rebuilding all of these in our design is on
  //     the follow-up list)
  function renderMenu(menu) {
    locked.style.display = 'none';
    items.classList.add('show');
    var liveAudioIcon = '<svg viewBox="0 0 12 12" fill="currentColor"><path d="M3 2 L10 6 L3 10 Z"/></svg>';
    var stopIcon = '<svg viewBox="0 0 12 12" fill="currentColor"><rect x="3" y="3" width="6" height="6"/></svg>';
    var specOnIcon = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 9 L4 5 L6 8 L8 3 L10 7"/></svg>';
    // Build the diagnostic shortcuts (system / logs / tools). With
    // native:true they navigate in-page; otherwise they keep the old
    // open-in-new-tab behavior for the legacy BirdNET-Pi screens.
    var linksHtml = menu.map(function (it) {
      var label = (it.label || '');
      var attrs = it.native ? '' : ' target="_blank" rel="noopener"';
      var cls = it.native ? '' : ' class="ext"';
      return '<a' + cls + ' href="' + it.href + '"' + attrs + '><span>' + label + '</span></a>';
    }).join('');
    items.innerHTML =
      '<div class="live-audio" id="liveAudio" data-on="false">'
      + '  <div class="pulse"></div>'
      + '  <div class="label">Live audio<span class="hint">stream from the mic</span></div>'
      + '  <button type="button" id="liveAudioBtn">'
      +     liveAudioIcon + '<span>listen</span>'
      + '  </button>'
      + '</div>'
      // Spectrogram canvas is always present; it stays a dark inert
      // strip until the stream is on, then the FFT loop paints it in
      // real time. No separate toggle.
      + '<canvas class="live-spectro" id="liveSpectro" width="600" height="120" aria-label="live spectrogram"></canvas>'
      + '<div class="live-status" id="liveStatus"></div>'
      + '<div class="menu-links">' + linksHtml + '</div>';

    // Clicking a nav link (settings / system / logs / tools) collapses the
    // menu back into the button - it has opened (or navigated to) its page,
    // so leaving the drawer open is just clutter. The listen button and the
    // built-by / GitHub links deliberately DON'T close it (you stay in the
    // drawer to keep the stream going; those links open a new tab).
    var menuLinks = items.querySelector('.menu-links');
    if (menuLinks) menuLinks.addEventListener('click', function (ev) {
      if (ev.target.closest('a')) closeDd();
    });

    // Live audio + realtime spectrogram. The audio element and the
    // FFT analyser share one AudioContext; once .play() is called the
    // analyser starts painting the canvas via rAF. No timeout - we
    // surface the natural error event or success ("playing") only.
    var liveBox = document.getElementById('liveAudio');
    var liveBtn = document.getElementById('liveAudioBtn');
    var spectroEl = document.getElementById('liveSpectro');
    var statusEl = document.getElementById('liveStatus');
    var liveEl = null, audioCtx = null, srcNode = null, analyser = null;
    var specRaf = null;

    function setStatus(msg, isErr) {
      statusEl.textContent = msg || '';
      statusEl.className = 'live-status' + (isErr ? ' err' : '');
    }
    function startAudio() {
      // Create the Audio element and resolve on the first "playing"
      // event (success). The browser will hang the network request
      // open for an icecast stream - that's normal - and "playing"
      // fires as soon as the first audio frame is decoded. We don't
      // race a timeout because icecast can take 1-10s to warm up
      // depending on tunnel + bitrate.
      return new Promise(function (resolve, reject) {
        liveEl = new Audio('/stream?t=' + Date.now());
        // No crossOrigin - the stream is same-origin via the worker
        // and crossOrigin='anonymous' would require CORS headers
        // icecast doesn't send.
        var settled = false;
        liveEl.addEventListener('playing', function () {
          if (settled) return;
          settled = true; resolve();
        });
        liveEl.addEventListener('error', function () {
          if (settled) return;
          settled = true;
          reject(new Error('stream error - check /#admin=system'));
        });
        audioClaim(stopAudio);   // stop any card / modal-recording audio
        liveEl.play().catch(function (e) {
          if (settled) return;
          settled = true; reject(e);
        });
      });
    }
    function stopAudio() {
      audioRelease(stopAudio);
      if (specRaf) { cancelAnimationFrame(specRaf); specRaf = null; }
      if (liveEl) { try { liveEl.pause(); } catch (e) {} liveEl.src = ''; liveEl = null; }
      if (srcNode) { try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
      if (analyser) { try { analyser.disconnect(); } catch (e) {} analyser = null; }
      liveBox.setAttribute('data-on', 'false');
      liveBtn.innerHTML = liveAudioIcon + '<span>listen</span>';
      // Clear the spectrogram canvas so it returns to its quiet state.
      var ctx = spectroEl.getContext('2d');
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue('--paper-2').trim() || '#efe8d8';
      ctx.fillRect(0, 0, spectroEl.width, spectroEl.height);
    }
    function attachSpectrogram() {
      if (!liveEl) return;
      if (!audioCtx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      try {
        srcNode = audioCtx.createMediaElementSource(liveEl);
      } catch (e) {
        // MediaElementSource throws if the Audio is already wired up
        // (e.g. user toggled listen off then on). Best effort - let
        // the audio still play, just skip the spectrogram.
        return;
      }
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      srcNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      drawSpectrogram();
    }
    // Convert a CSS colour token (hex or rgb()) to [r,g,b] by letting the 2d
    // context normalise whatever form the variable is authored in.
    function toRGB(str, fallback) {
      var c = spectroEl.getContext('2d');
      c.fillStyle = fallback; c.fillStyle = str;   // invalid str leaves fallback
      var s = c.fillStyle;
      if (s.charAt(0) === '#') return [parseInt(s.substr(1, 2), 16), parseInt(s.substr(3, 2), 16), parseInt(s.substr(5, 2), 16)];
      var m = s.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
      return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
    }
    function drawSpectrogram() {
      var ctx = spectroEl.getContext('2d');
      var W = spectroEl.width, H = spectroEl.height;
      // Read palette tokens so the live spectrogram follows the theme - a
      // charcoal ground with a light trace in dark mode, not a hardcoded
      // light-mode ramp - matching the recording-row + card spectrograms.
      var cs = getComputedStyle(document.documentElement);
      var paper = cs.getPropertyValue('--paper-2').trim() || '#efe8d8';
      var bg = toRGB(paper, '#efe8d8');
      var fg = toRGB(cs.getPropertyValue('--ink').trim() || '#1a1612', '#1a1612');
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, W, H);
      var bins = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        if (!analyser) return;
        var img = ctx.getImageData(1, 0, W - 1, H);
        ctx.putImageData(img, 0, 0);
        ctx.clearRect(W - 1, 0, 1, H);
        analyser.getByteFrequencyData(bins);
        var n = bins.length;
        var lo = Math.floor(n * 250 / 24000);
        var hi = Math.floor(n * 12000 / 24000);
        for (var y = 0; y < H; y++) {
          var t = 1 - y / H;
          var idx = Math.round(lo + (hi - lo) * Math.pow(t, 1.6));
          var v = (bins[idx] || 0) / 255;
          var e = v * v * (3 - 2 * v);
          // Ground (paper) -> trace (ink) ramp, per the active theme.
          var r = bg[0] + Math.round((fg[0] - bg[0]) * e);
          var g = bg[1] + Math.round((fg[1] - bg[1]) * e);
          var b = bg[2] + Math.round((fg[2] - bg[2]) * e);
          ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
          ctx.fillRect(W - 1, y, 1, 1);
        }
        specRaf = requestAnimationFrame(tick);
      }
      tick();
    }

    // Paint the spectrogram in its quiet/initial state.
    (function () {
      var ctx = spectroEl.getContext('2d');
      var paper = getComputedStyle(document.documentElement)
        .getPropertyValue('--paper-2').trim() || '#efe8d8';
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, spectroEl.width, spectroEl.height);
    })();

    liveBtn.addEventListener('click', function (ev) {
      // Important: stop the click from propagating up to the
      // document-level "click outside drawer" handler, which would
      // close the dropdown.
      ev.stopPropagation();
      var on = liveBox.getAttribute('data-on') === 'true';
      if (on) { setStatus(''); stopAudio(); return; }
      liveBox.setAttribute('data-on', 'true');
      liveBtn.innerHTML = stopIcon + '<span>stop</span>';
      setStatus('connecting...');
      startAudio()
        .then(function () { setStatus('streaming from pi'); attachSpectrogram(); })
        .catch(function (err) {
          stopAudio();
          var msg = (err && err.message) || 'stream unavailable';
          if (msg.indexOf('NotAllowed') !== -1 || msg.indexOf('user') !== -1) {
            setStatus('browser blocked autoplay - tap listen again', true);
          } else {
            setStatus(msg, true);
          }
        });
    });
  }

  // Pending changes (key -> value), saved on click of the Save button.
  var pending = {};

  function setSaveState(msg, cls) {
    var el = document.getElementById('saveState');
    if (el) { el.textContent = msg || ''; el.className = 'save-state' + (cls ? ' ' + cls : ''); }
    var btn = document.getElementById('saveBtn');
    if (btn) btn.disabled = Object.keys(pending).length === 0;
  }

  function loadSettings() {
    fetch('./avian/api/config.php', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (cfg) {
        var v = cfg.values || {};
        var preserve = cfg.preserve;
        var html = ''
          + settingsToggle('preserve', 'Preserve all recordings', "don't auto-delete", preserve)
          + settingsSlider('CONFIDENCE',  'Confidence threshold', 'min score to log a detection', v.CONFIDENCE,  0.1, 0.95, 0.05, 2)
          + settingsSlider('SENSITIVITY', 'Sensitivity',          'analyzer sensitivity',          v.SENSITIVITY, 0.5, 1.5,  0.05, 2)
          + settingsSlider('OVERLAP',     'Chunk overlap',        'seconds analyzed per pass',     v.OVERLAP,     0,   2.5,  0.1,  1)
          + settingsSegmented('FULL_DISK', 'When disk fills', '', v.FULL_DISK, [
              { v: 'keep',  label: 'keep' },
              { v: 'purge', label: 'purge' },
            ])
          + '<div class="menu-save-row">'
          + '  <span class="save-state" id="saveState"></span>'
          + '  <button type="button" id="saveBtn" disabled>save</button>'
          + '</div>';
        var body = document.getElementById('settingsBody');
        if (body) body.innerHTML = html;
        wireSettingsControls();
        var saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveSettings);
      })
      .catch(function (err) {
        var body = document.getElementById('settingsBody');
        if (body) body.innerHTML =
          '<div class="menu-row"><span class="label">Failed to load <small class="hint">' + err + '</small></span></div>';
      });
  }

  function settingsToggle(key, label, hint, on) {
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">' + label + '</span>'
      +     (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '  </div>'
      + '  <button type="button" class="switch" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" data-key="' + key + '"></button>'
      + '</div>';
  }
  function settingsSlider(key, label, hint, val, min, max, step, digits) {
    return ''
      + '<div class="slider-row">'
      + '  <div class="head">'
      + '    <div class="label-block">'
      + '      <span class="label">' + label + '</span>'
      +       (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '    </div>'
      + '    <span class="value" data-value-for="' + key + '">' + (+val).toFixed(digits) + '</span>'
      + '  </div>'
      + '  <div class="slider-track">'
      + '    <input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" data-key="' + key + '" data-digits="' + digits + '">'
      + '  </div>'
      + '</div>';
  }
  function settingsSegmented(key, label, hint, val, opts) {
    var btns = opts.map(function (o) {
      return '<button type="button" data-v="' + o.v + '" aria-current="' + (o.v === val ? 'true' : 'false') + '">' + o.label + '</button>';
    }).join('');
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">' + label + '</span>'
      +     (hint ? '<span class="hint">' + hint + '</span>' : '')
      + '  </div>'
      + '  <div class="seg" data-key="' + key + '">' + btns + '</div>'
      + '</div>';
  }
  // Client-side theme switcher row. Reuses the .seg look but is tagged
  // data-theme-seg so wireSettingsControls skips it - it applies instantly
  // and is NOT part of the Pi config save flow.
  function themeRow() {
    var cur = currentTheme();
    var btn = function (v, label) {
      return '<button type="button" data-theme="' + v + '" aria-current="' + (cur === v ? 'true' : 'false') + '">' + label + '</button>';
    };
    return ''
      + '<div class="menu-row">'
      + '  <div><span class="label">Theme</span><span class="hint">saved on this device</span></div>'
      + '  <div class="seg" data-theme-seg>' + btn('light', 'light') + btn('dark', 'dark') + '</div>'
      + '</div>';
  }
  function wireSettingsControls(scope) {
    scope = scope || document;
    scope.querySelectorAll('.switch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', on ? 'true' : 'false');
        pending[sw.dataset.key] = on;
        setSaveState('change pending');
      });
    });
    scope.querySelectorAll('input[type="range"]').forEach(function (sl) {
      sl.addEventListener('input', function () {
        var v = +sl.value;
        var digits = +sl.dataset.digits || 2;
        var label = scope.querySelector('[data-value-for="' + sl.dataset.key + '"]');
        if (label) label.textContent = v.toFixed(digits);
        pending[sl.dataset.key] = v;
        setSaveState('change pending');
      });
    });
    scope.querySelectorAll('.seg:not([data-theme-seg])').forEach(function (seg) {
      seg.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
          pending[seg.dataset.key] = b.dataset.v;
          setSaveState('change pending');
        });
      });
    });
  }

  function saveSettings() {
    if (Object.keys(pending).length === 0) return;
    var body = JSON.stringify(pending);
    setSaveState('saving...');
    fetch('./avian/api/config.php', {
      method: 'POST', body: body,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j.ok) {
          pending = {};
          setSaveState('saved ✓', 'ok');
          setTimeout(function () { setSaveState(''); }, 1800);
        } else {
          setSaveState('save failed', 'err');
        }
      })
      .catch(function () { setSaveState('network error', 'err'); });
  }

  // ---- Hash routing + atlas detail modal ----
  // When a collage tile or stats row is clicked it sets
  // location.hash = '#sci=<name>'. On arrival we switch to the atlas
  // view, highlight the matching card, AND open the detail modal with
  // expanded info (Wikipedia summary, taxonomy, all past recordings).
  function readHash() {
    var m = location.hash.match(/^#sci=([^&]+)/);
    if (!m) return null;
    return decodeURIComponent(m[1]);
  }
  function highlightAtlas(sci) {
    var grid = document.getElementById('atlasGrid');
    if (!grid) return;
    grid.querySelectorAll('.bird-card[data-active="true"]').forEach(function (c) {
      c.removeAttribute('data-active');
    });
    if (!sci) return;
    var attempts = 0;
    (function find() {
      var card = grid.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]');
      if (!card) {
        if (attempts++ < 10) return setTimeout(find, 80);
        return;
      }
      card.setAttribute('data-active', 'true');
      card.setAttribute('data-pulse', 'true');
      setTimeout(function () { card.removeAttribute('data-pulse'); }, 520);
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    })();
  }

  // ---- Detail modal ----
  // Caches per-sci species info so opening the same modal twice doesn't
  // re-fetch. Wikipedia + per-species endpoints are slow over the
  // tunnel; one fetch per session is plenty.
  var SPECIES_CACHE = {};
  var WIKI_CACHE = {};
  var modalAudio = null;
  var modalRecBtn = null;
  function fmtRecTime(d, t) {
    // d="2026-05-15", t="20:25:29"
    if (!d) return '-';
    var date = new Date((d || '') + 'T' + (t || '00:00:00'));
    if (isNaN(date.getTime())) return d + ' ' + (t || '');
    var now = Date.now();
    var ago = Math.floor((now - date.getTime()) / 1000);
    if (ago < 60) return ago + 's ago';
    if (ago < 3600) return Math.floor(ago / 60) + 'm ago';
    if (ago < 86400) return Math.floor(ago / 3600) + 'h ago';
    return Math.floor(ago / 86400) + 'd ago';
  }
  function fmtDateLine(d, t) {
    if (!d) return '';
    try {
      var date = new Date(d + 'T' + (t || '00:00:00'));
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' · ' + (t ? t.slice(0, 5) : '');
    } catch (e) { return d + ' ' + (t || ''); }
  }
  function rarityLabel(total, firstSeenIso) {
    if (!total) return '-';
    var days = 1;
    if (firstSeenIso) {
      var t = Date.parse((firstSeenIso || '').replace(' ', 'T'));
      if (!isNaN(t)) days = Math.max(1, Math.ceil((Date.now() - t) / 86400000));
    }
    var perDay = total / days;
    if (perDay >= 5) return 'common';
    if (perDay >= 1) return 'regular';
    if (perDay >= 0.2) return 'occasional';
    return 'rare';
  }
  // rAF-driven cursor smoothing. timeupdate fires ~4Hz which feels
  // janky; we sample audio.currentTime every animation frame and
  // interpolate to a 60Hz update so the playback knob glides.
  var modalCursorRaf = null;
  function startCursorLoop() {
    if (modalCursorRaf) return;
    var tick = function () {
      if (!modalAudio || !modalRecBtn) { modalCursorRaf = null; return; }
      var row = modalRecBtn.closest('.rec-row');
      if (row && modalAudio.duration) {
        var strip = row.querySelector('.rec-spectro');
        var played = strip && strip.querySelector('.rec-spectro-played');
        var cursor = strip && strip.querySelector('.rec-spectro-cursor');
        var pct = (modalAudio.currentTime / modalAudio.duration) * 100;
        if (played) played.style.width = pct.toFixed(3) + '%';
        if (cursor) cursor.style.left = pct.toFixed(3) + '%';
      }
      modalCursorRaf = requestAnimationFrame(tick);
    };
    modalCursorRaf = requestAnimationFrame(tick);
  }
  function stopCursorLoop() {
    if (modalCursorRaf) { cancelAnimationFrame(modalCursorRaf); modalCursorRaf = null; }
  }

  // Pause the currently-playing modal recording but KEEP the audio
  // element alive so the user can scrub (audio.currentTime is still
  // mutable on a paused element) and then resume from the same spot.
  // The cursor stays visible at its last position.
  function pauseModalAudio() {
    stopCursorLoop();
    if (modalAudio) { try { modalAudio.pause(); } catch (e) {} }
    if (modalRecBtn) {
      modalRecBtn.removeAttribute('data-active');
      modalRecBtn.innerHTML = ICON_PLAY;
    }
  }
  // Hard-stop: pause + tear down the audio + clear cursor. Used when
  // switching rows or closing the modal.
  function stopModalAudio() {
    audioRelease(stopModalAudio);
    stopCursorLoop();
    if (modalAudio) { try { modalAudio.pause(); } catch (e) {} modalAudio = null; }
    if (modalRecBtn) {
      var prevRow = modalRecBtn.closest('.rec-row');
      if (prevRow) {
        var strip = prevRow.querySelector('.rec-spectro');
        if (strip) {
          strip.classList.remove('armed');
          var played = strip.querySelector('.rec-spectro-played');
          var cur = strip.querySelector('.rec-spectro-cursor');
          if (played) played.style.width = '0%';
          if (cur) cur.style.left = '0%';
        }
      }
      modalRecBtn.removeAttribute('data-active');
      modalRecBtn.innerHTML = ICON_PLAY;
      modalRecBtn = null;
    }
  }

  function sketchSrc(sci, pose) {
    // Look up the common name from the lifelist so the worker's JIT
    // Gemini prompt is right for a never-pre-rendered species.
    var sp = ((DATA.lifelist && DATA.lifelist.species) || [])
      .find(function (s) { return s.sci === sci; });
    var com = sp ? (sp.com || '') : '';
    var base = './avian/api/cutout.php?sci=' + encodeURIComponent(sci) +
      (com ? '&com=' + encodeURIComponent(com) : '') +
      '&v=' + SKETCH_VERSION;
    var n = +pose || 1;
    return n > 1 ? base + '&pose=' + n : base;
  }
  function openDetailModal(sci) {
    if (!sci) return;
    var modal = document.getElementById('detail-modal');
    var img = document.getElementById('modalImg');
    var poseToggle = document.getElementById('modalPoseToggle');
    var poseBtns = [].slice.call(poseToggle.querySelectorAll('button'));

    // Reset the toggle: assume nothing's available, set pose 1 (perched
    // cutout - every species has it) as the optimistic default. HEAD
    // probes below toggle each button on/off and pick the best default.
    poseToggle.removeAttribute('data-unavailable');
    poseBtns.forEach(function (b) {
      b.setAttribute('data-unavailable', 'true');
      b.setAttribute('aria-current', 'false');
    });
    var p1 = poseToggle.querySelector('button[data-pose="1"]');
    if (p1) {
      p1.removeAttribute('data-unavailable');
      p1.setAttribute('aria-current', 'true');
    }
    img.src = sketchSrc(sci, 1);
    img.alt = sci;

    // Probe each pose's image with HEAD. Build a list of available
    // poses, then pick the highest-numbered as the default (in-flight
    // > perched, etc.). When only one pose remains, hide the toggle
    // entirely - no choice means no UI.
    var probes = poseBtns.map(function (b) {
      var pose = +b.dataset.pose;
      return fetch(sketchSrc(sci, pose), { method: 'HEAD', cache: 'no-store' })
        .then(function (r) { return { pose: pose, btn: b, ok: r.ok }; })
        .catch(function () { return { pose: pose, btn: b, ok: false }; });
    });
    Promise.all(probes).then(function (results) {
      var available = results.filter(function (r) { return r.ok; });
      available.forEach(function (r) { r.btn.removeAttribute('data-unavailable'); });
      results.filter(function (r) { return !r.ok; }).forEach(function (r) {
        r.btn.setAttribute('data-unavailable', 'true');
      });
      // Default to the highest-numbered available pose (in-flight if
      // present, else fall back to perched).
      var pick = available.sort(function (a, b) { return b.pose - a.pose; })[0];
      if (pick) {
        poseBtns.forEach(function (b) {
          b.setAttribute('aria-current', b === pick.btn ? 'true' : 'false');
        });
        img.src = sketchSrc(sci, pick.pose);
      }
      // Single-option => hide the chrome.
      if (available.length <= 1) {
        poseToggle.setAttribute('data-unavailable', 'true');
      }
      // Slide the white pill to the active button.
      syncPill(poseToggle);
    });
    document.getElementById('modalSci').textContent = sci;
    document.getElementById('modalGenus').textContent = (sci.split(' ')[0] || '-');
    document.getElementById('modalCommon').textContent = '-';
    document.getElementById('modalAllTime').textContent = '-';
    document.getElementById('modalWindow').textContent = '-';
    // Window stat label tracks the picker; the whole stat is hidden for
    // the "all time" window since it would just echo the all-time count.
    var modalWinStat = document.getElementById('modalWindowStat');
    if (currentHours >= 1000000) {
      modalWinStat.style.display = 'none';
    } else {
      modalWinStat.style.display = '';
      document.getElementById('modalWindowLbl').textContent = windowLabel(currentHours);
    }
    document.getElementById('modalFirstSeen').textContent = '-';
    document.getElementById('modalRarity').textContent = '-';
    document.getElementById('modalRarity').classList.remove('rare');
    document.getElementById('modalDesc').textContent = 'Loading description...';
    document.getElementById('modalDesc').classList.add('placeholder');
    document.getElementById('modalRecordings').innerHTML = '<li class="rec-empty">Loading recordings...</li>';
    document.getElementById('modalRecCount').textContent = '';
    document.getElementById('modalWiki').href = wikiUrl(sci);
    document.getElementById('modalEbird').href = ebirdUrl(sci);
    // FLIP-style morph: scale + translate the modal-card from the
    // clicked atlas card's position to its natural centered size, so
    // the card *expands* into the detail view instead of just fading
    // in. The outer modal MUST become visible (aria-hidden=false)
    // before we apply the initial transform - the browser skips
    // layout for opacity-0 trees, which would freeze the morph at the
    // starting frame.
    var sourceCard = atlasGridEl
      ? atlasGridEl.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]')
      : null;
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    morphModalOpen(modal.querySelector('.modal-card'), sourceCard);

    // Species detail (lifelist row + every detection).
    var loadSpecies = SPECIES_CACHE[sci]
      ? Promise.resolve(SPECIES_CACHE[sci])
      : fetchJson('./avian/api/birdnet-api.php?action=species&sci=' + encodeURIComponent(sci)).then(function (j) {
          SPECIES_CACHE[sci] = j;
          return j;
        });
    loadSpecies.then(function (j) {
      var s = j.summary || {};
      document.getElementById('modalCommon').textContent = s.com || sci;
      document.getElementById('modalAllTime').textContent = fmtN(+s.total || 0);
      var winRow = ((DATA.recent && DATA.recent.species) || []).filter(function (x) { return x.sci === sci; })[0];
      document.getElementById('modalWindow').textContent = fmtN(winRow ? +winRow.n : 0);
      document.getElementById('modalFirstSeen').textContent = s.first_seen ? fmtRecTime(s.first_seen.split(' ')[0], s.first_seen.split(' ')[1]) : '-';
      var rar = rarityLabel(+s.total || 0, s.first_seen);
      var rarEl = document.getElementById('modalRarity');
      rarEl.textContent = rar;
      if (rar === 'rare') rarEl.classList.add('rare');
      var dets = j.detections || [];
      document.getElementById('modalRecCount').textContent = dets.length + ' captured';
      document.getElementById('modalRecordings').innerHTML = dets.length
        ? dets.map(function (d) {
            return '<li class="rec-row" data-file="' + (d.file || '') + '" data-date="' + (d.d || '') + '">'
              + '<button class="play" type="button" aria-label="play">' + ICON_PLAY + '</button>'
              + '<span class="when">' + fmtRecTime(d.d, d.t) + '<small>' + fmtDateLine(d.d, d.t) + '</small></span>'
              + '<span class="conf">' + ((+d.conf || 0) * 100).toFixed(0) + '%</span>'
              + '<div class="rec-spectro" aria-hidden="true">'
              +   '<div class="rec-spectro-loading">loading spectrogram...</div>'
              +   '<div class="rec-spectro-played"></div>'
              +   '<div class="rec-spectro-cursor"></div>'
              +   '<div class="rec-spectro-scrub" role="slider" aria-label="scrub" tabindex="0"></div>'
              + '</div>'
              + '</li>';
          }).join('')
        : '<li class="rec-empty">No recordings yet.</li>';
    }).catch(function () {
      document.getElementById('modalRecordings').innerHTML = '<li class="rec-empty">Failed to load recordings.</li>';
    });

    // Wikipedia summary (description + genus / family).
    var loadWiki = WIKI_CACHE[sci]
      ? Promise.resolve(WIKI_CACHE[sci])
      : fetchJson('./avian/api/wiki.php?sci=' + encodeURIComponent(sci)).then(function (j) {
          WIKI_CACHE[sci] = j; return j;
        });
    loadWiki.then(function (j) {
      var desc = document.getElementById('modalDesc');
      desc.textContent = j.extract || 'No description available.';
      desc.classList.toggle('placeholder', !j.extract);
    }).catch(function () {
      var desc = document.getElementById('modalDesc');
      desc.textContent = 'No description available.';
      desc.classList.add('placeholder');
    });
  }
  function closeDetailModal() {
    var modal = document.getElementById('detail-modal');
    stopModalAudio();
    // Reverse-morph back into the source atlas card so the modal
    // appears to *retract* to where it came from. Look the card up
    // fresh - the user may have switched the time window or sort
    // since opening the modal, so the source card may have moved.
    var sci = (document.getElementById('modalSci').textContent || '').trim();
    var sourceCard = sci && atlasGridEl
      ? atlasGridEl.querySelector('.bird-card[data-sci="' + sci.replace(/"/g, '\"') + '"]')
      : null;
    morphModalClose(modal.querySelector('.modal-card'), sourceCard, function () {
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    });
  }

  // Shared-element morph: the modal-card scales+translates from the
  // clicked atlas card's exact rect to its natural centred rect, so the
  // little card appears to expand into the big one (and retract on
  // close). Only the card transforms; the container's opacity does the
  // single fade for backdrop + card together - no double-fade, and the
  // transform is cleared only once hidden so there's no mid-close snap.
  var atlasGridEl = document.getElementById('atlasGrid');
  function morphTransform(modalCard, sourceCard) {
    if (!modalCard || !sourceCard) return null;
    var s = sourceCard.getBoundingClientRect();
    // Source off-screen (opened from stats mid-slide, or scrolled away)
    // -> skip the morph and just fade, rather than fly in from nowhere.
    if (!s.width || s.bottom < 0 || s.top > window.innerHeight ||
        s.right < 0 || s.left > window.innerWidth) return null;
    var m = modalCard.getBoundingClientRect();
    if (!m.width) return null;
    var scale = Math.max(0.1, s.width / m.width);
    var dx = (s.left + s.width / 2) - (m.left + m.width / 2);
    var dy = (s.top + s.height / 2) - (m.top + m.height / 2);
    return 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0) scale(' + scale.toFixed(4) + ')';
  }
  // Run cb once the transform transition finishes, with a timeout
  // fallback for environments where transitionend doesn't fire.
  function onceTransformEnd(el, cb, fallbackMs) {
    var fired = false;
    function handler(ev) {
      if (ev && ev.propertyName && ev.propertyName !== 'transform') return;
      if (fired) return;
      fired = true;
      el.removeEventListener('transitionend', handler);
      cb();
    }
    el.addEventListener('transitionend', handler);
    setTimeout(handler, fallbackMs);
  }
  function morphModalOpen(modalCard, sourceCard) {
    var modal = document.getElementById('detail-modal');
    if (!modalCard) { modal.classList.add('is-open'); return; }
    // Identity first so we can measure the card's natural rect, then jump
    // it (no transition) to the source card's position + scale.
    modalCard.classList.remove('is-morphing');
    modalCard.style.transform = '';
    void modalCard.offsetWidth;
    var start = morphTransform(modalCard, sourceCard);
    if (start) {
      modalCard.style.transform = start;
      void modalCard.offsetWidth;
    }
    // Next tick: fade the container in and glide the card to identity.
    // setTimeout (not rAF) - rAF can stall in non-painting/headless
    // contexts; the forced reflow above already commits the start
    // transform so the transition interpolates cleanly from it.
    setTimeout(function () {
      modal.classList.add('is-open');
      if (start) {
        modalCard.classList.add('is-morphing');
        modalCard.style.transform = 'translate3d(0,0,0) scale(1)';
      }
    }, 0);
    if (start) {
      onceTransformEnd(modalCard, function () {
        modalCard.classList.remove('is-morphing');
        modalCard.style.transform = '';
      }, 360);
    }
  }
  function morphModalClose(modalCard, sourceCard, done) {
    var modal = document.getElementById('detail-modal');
    // Fade the container out (backdrop + card) and retract the card to
    // the source rect at the same time.
    modal.classList.remove('is-open');
    var end = modalCard ? morphTransform(modalCard, sourceCard) : null;
    var finish = function () {
      if (modalCard) {
        modalCard.classList.remove('is-morphing');
        modalCard.style.transform = '';
      }
      if (done) done();
    };
    if (modalCard && end) {
      modalCard.classList.add('is-morphing');
      void modalCard.offsetWidth;
      modalCard.style.transform = end;
      onceTransformEnd(modalCard, finish, 360);
    } else {
      // No morph -> let the container opacity fade run, then hide.
      setTimeout(finish, 280);
    }
  }

  // Pose toggle inside the modal - swaps the sketch between perched
  // (default) and in-flight alt pose. A short opacity transition makes
  // the swap feel intentional rather than a hard cut.
  document.getElementById('modalPoseToggle').addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('button');
    if (!btn || btn.getAttribute('data-unavailable') === 'true') return;
    var pose = +btn.dataset.pose;
    var toggle = document.getElementById('modalPoseToggle');
    [].slice.call(toggle.querySelectorAll('button')).forEach(function (b) {
      b.setAttribute('aria-current', b === btn ? 'true' : 'false');
    });
    syncPill(toggle);
    var img = document.getElementById('modalImg');
    var sci = document.getElementById('modalSci').textContent;
    img.classList.add('swapping');
    setTimeout(function () {
      img.src = sketchSrc(sci, pose);
      img.addEventListener('load', function once() {
        img.classList.remove('swapping');
        img.removeEventListener('load', once);
      });
    }, 180);
  });

  // Expose for debugging during dev - also lets the modal be opened
  // from outside the IIFE if needed.
  window.__openDetailModal = openDetailModal;
  window.__closeDetailModal = closeDetailModal;

  // ===== Admin overlay (settings / system / logs / tools) =====
  // Lives in the same shell as the rest of the app - the menu button
  // and return-to-atlas pill stay put. The slider hides; this overlay
  // takes over the body. Navigation is via the drawer menu, NOT
  // internal tabs (the drawer is the canonical nav surface).
  var adminEl = document.getElementById('adminScreen');
  var adminBody = document.getElementById('adminBody');
  var adminTitle = document.getElementById('adminTitle');
  var adminPollT = null;
  var adminSect = null;
  var ADMIN_TITLES = {
    settings: 'Settings',
    system: 'System',
    logs: 'Logs',
    tools: 'Tools',
  };
  function adminEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function adminFmtBytes(n) {
    if (!n) return '0 B';
    var u = ['B','KB','MB','GB','TB'];
    var i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  }
  function adminFmtAge(s) {
    if (s == null) return '-';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  // Admin endpoints rely on the session cookie set by /api/auth/login -
  // no Authorization header needed (and nothing sensitive in JS-readable
  // storage). credentials: 'same-origin' is the default but spelled out
  // for clarity.
  function adminApi(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  }
  function openAdmin(section) {
    document.body.classList.add('admin-on');
    adminEl.setAttribute('aria-hidden', 'false');
    adminTitle.textContent = ADMIN_TITLES[section] || section;
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    adminSect = section;
    if (section === 'settings') renderAdminSettings();
    else if (section === 'system') renderAdminSystem();
    else if (section === 'logs') renderAdminLogs();
    else if (section === 'tools') renderAdminTools();
  }
  function closeAdmin() {
    document.body.classList.remove('admin-on');
    adminEl.setAttribute('aria-hidden', 'true');
    if (adminPollT) { clearInterval(adminPollT); adminPollT = null; }
    adminSect = null;
  }

  function adminCard(title, value, sub, cls) {
    return '<div class="admin-card ' + (cls || '') + '">'
      + '<h3>' + adminEsc(title) + '</h3>'
      + '<div class="v">' + adminEsc(value) + '</div>'
      + (sub ? '<div class="sub">' + adminEsc(sub) + '</div>' : '')
      + '</div>';
  }
  function adminUnreachableHtml(reason) {
    return '<div class="admin-unreachable">Pi unreachable - ' + adminEsc(reason || 'no data') + '</div>';
  }

  function renderAdminSettings() {
    adminBody.innerHTML = '<p style="font:11px ui-monospace,monospace;color:var(--ink-soft);text-align:center">loading settings...</p>';
    fetch('./avian/api/config.php', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (cfg) {
        var v = cfg.values || {};
        var preserve = cfg.preserve;
        adminBody.innerHTML =
          '<div class="admin-settings">'
          + themeRow()
          + settingsToggle('preserve', 'Preserve all recordings', "don't auto-delete", preserve)
          + settingsSlider('CONFIDENCE',  'Confidence threshold', 'min score to log a detection', v.CONFIDENCE,  0.1, 0.95, 0.05, 2)
          + settingsSlider('SENSITIVITY', 'Sensitivity',          'analyzer sensitivity',          v.SENSITIVITY, 0.5, 1.5,  0.05, 2)
          + settingsSlider('OVERLAP',     'Chunk overlap',        'seconds analyzed per pass',     v.OVERLAP,     0,   2.5,  0.1,  1)
          + settingsSegmented('FULL_DISK', 'When disk fills', '', v.FULL_DISK, [
              { v: 'keep',  label: 'keep' },
              { v: 'purge', label: 'purge' },
            ])
          + '<div class="menu-save-row">'
          + '  <span class="save-state" id="saveState"></span>'
          + '  <button type="button" id="saveBtn" disabled>save</button>'
          + '</div>'
          + '</div>';
        wireSettingsControls(adminBody);
        adminBody.querySelectorAll('.seg').forEach(wireToggleAdvance);   // open-space advance
        // Theme switcher applies + persists immediately (separate from the
        // Pi config save below).
        var themeSeg = adminBody.querySelector('[data-theme-seg]');
        if (themeSeg) themeSeg.addEventListener('click', function (ev) {
          var b = ev.target.closest('button[data-theme]');
          if (!b) return;
          applyTheme(b.getAttribute('data-theme'));
          [].forEach.call(themeSeg.querySelectorAll('button'), function (x) {
            x.setAttribute('aria-current', x === b ? 'true' : 'false');
          });
        });
        var saveBtn = document.getElementById('saveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveSettings);
      })
      .catch(function (err) {
        adminBody.innerHTML = adminUnreachableHtml('settings load failed (' + err + ')');
      });
  }

  function renderAdminSystem() {
    adminBody.innerHTML = '<p style="font:11px ui-monospace,monospace;color:var(--ink-soft);text-align:center">loading...</p>';
    function tick() {
      adminApi('./avian/api/birdnet-status.php?action=diag')
        .then(function (r) { return r.text().then(function (raw) { return { status: r.status, raw: raw }; }); })
        .then(function (res) {
          var j = null;
          try { j = JSON.parse(res.raw); } catch (e) {}
          if (res.status !== 200 || !j) {
            adminBody.innerHTML = adminUnreachableHtml(
              !j ? 'birdnet-status.php not installed on the pi' : (j.error || 'HTTP ' + res.status)
            );
            return;
          }
          adminBody.innerHTML = adminSystemMarkup(j);
          wireAdminRestarts();
        })
        .catch(function (e) { adminBody.innerHTML = adminUnreachableHtml(e.message); });
    }
    tick();
    adminPollT = setInterval(tick, 6000);
  }
  function adminSystemMarkup(j) {
    var sys = j.system || {}, svc = j.services || {}, recLogs = j.recent_logs || {};
    var stream = sys.stream_data || {}, db = sys.birds_db || {};
    var streamAlert = !stream.exists || stream.newest_age_s == null || stream.newest_age_s > 600;
    var dbAlert = db.exists && db.modified_s > 3600;
    var keySvcs = ['birdnet_recording', 'birdnet_analysis', 'birdnet_log'];
    var dead = keySvcs.filter(function (n) { return svc[n] && svc[n].active !== 'active'; });
    var html = '<div class="admin-grid">';
    html += adminCard('recording pipeline', dead.length === 0 ? 'live' : (dead.length + ' down'),
      dead.length === 0 ? 'all services active' : dead.join(', '),
      dead.length === 0 ? '' : 'alert');
    html += adminCard('newest live audio',
      stream.newest_age_s == null ? 'no chunks' : adminFmtAge(stream.newest_age_s) + ' ago',
      stream.newest_name || '',
      streamAlert ? 'alert' : '');
    html += adminCard('birds.db updated',
      db.exists ? adminFmtAge(db.modified_s) + ' ago' : 'missing',
      db.mtime || '',
      dbAlert ? 'warn' : '');
    html += adminCard('uptime', (sys.uptime || {}).pretty || '-',
      'load ' + ((sys.uptime || {}).load || []).map(function (n) { return n.toFixed(2); }).join(' / '));
    html += adminCard('cpu temp',
      sys.temp_c != null ? sys.temp_c.toFixed(1) + '°C' : '-',
      sys.hostname + ' · ' + sys.kernel,
      sys.temp_c != null && sys.temp_c > 75 ? 'warn' : '');
    html += adminCard('memory used', sys.mem ? sys.mem.used_pct + '%' : '-',
      sys.mem ? adminFmtBytes(sys.mem.used_bytes) + ' / ' + adminFmtBytes(sys.mem.total_bytes) : '',
      sys.mem && sys.mem.used_pct > 92 ? 'warn' : '');
    html += adminCard('disk (birdsongs)', sys.disk_birds ? sys.disk_birds.used_pct + '%' : '-',
      sys.disk_birds ? adminFmtBytes(sys.disk_birds.total_bytes - sys.disk_birds.free_bytes) + ' / ' + adminFmtBytes(sys.disk_birds.total_bytes) : '',
      sys.disk_birds && sys.disk_birds.used_pct > 92 ? 'warn' : '');
    var audio = sys.audio || {}, cards = audio.arecord_l || [];
    var mic = cards.find ? cards.find(function (c) { return /usb-audio|microphone|mic/i.test(c); }) : null;
    // Without a USB mic, /proc/asound/cards only lists the Pi's HDMI
    // audio outputs - which aren't an input source. Flag that clearly
    // rather than showing "audio device: vc4hdmi0" as if it were a mic.
    html += adminCard('audio device',
      mic || (cards.length ? 'no microphone attached' : 'no audio devices'),
      mic ? '' : (cards[0] || ''),
      mic ? '' : 'warn');
    html += '</div>';

    html += '<h2 class="admin-section-head">services</h2>';
    html += '<table class="admin-tbl"><thead><tr><th>unit</th><th>state</th><th>enabled</th><th>since</th><th></th></tr></thead><tbody>';
    Object.keys(svc).forEach(function (name) {
      var s = svc[name];
      var pill = (s.active === 'active') ? 'active' : (s.active === 'failed' ? 'failed' : 'inactive');
      html += '<tr>'
        + '<td>' + adminEsc(name) + '</td>'
        + '<td><span class="pill ' + pill + '">' + adminEsc(s.active) + '</span></td>'
        + '<td>' + adminEsc(s.enabled) + '</td>'
        + '<td>' + adminEsc(s.since || '-') + '</td>'
        + '<td><button class="restart" data-unit="' + adminEsc(name) + '">restart</button></td>'
        + '</tr>';
    });
    html += '</tbody></table>';

    var conf = (sys.conf || {}).values || {};
    var rows = Object.keys(conf).map(function (k) {
      return '<tr><td>' + adminEsc(k) + '</td><td>' + adminEsc(conf[k]) + '</td></tr>';
    }).join('');
    if (rows) {
      html += '<h2 class="admin-section-head">birdnet.conf</h2>';
      html += '<table class="admin-tbl"><tbody>' + rows + '</tbody></table>';
    }
    if (Object.keys(recLogs).length) {
      html += '<h2 class="admin-section-head">recent journal</h2>';
      Object.keys(recLogs).forEach(function (u) {
        html += '<h3 style="font:9.5px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);margin:12px 0 6px">' + adminEsc(u) + '</h3>';
        html += '<div class="admin-logs-pane">' + adminEsc(recLogs[u] || '(empty)') + '</div>';
      });
    }
    return html;
  }
  function wireAdminRestarts() {
    adminBody.querySelectorAll('button.restart').forEach(function (b) {
      b.addEventListener('click', function () {
        var unit = b.dataset.unit;
        if (!confirm('Restart ' + unit + '?')) return;
        b.disabled = true; var old = b.textContent; b.textContent = '...';
        fetch('./avian/api/birdnet-status.php?action=restart&unit=' + encodeURIComponent(unit), {
          method: 'POST', credentials: 'same-origin',
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            b.textContent = j.ok ? 'ok' : 'fail';
            setTimeout(function () { b.disabled = false; b.textContent = old; renderAdminSystem(); }, 1200);
          })
          .catch(function () { b.textContent = 'err'; b.disabled = false; setTimeout(function () { b.textContent = old; }, 1500); });
      });
    });
  }

  function renderAdminLogs() {
    var unit = 'birdnet_recording', lines = 120, autoScroll = true;
    adminBody.innerHTML =
      '<div class="admin-logs-toolbar">'
      + '  <label>unit</label><select id="adminLogsUnit">'
      // php-fpm unit name differs per Debian version (8.2 on Bookworm,
      // 8.4 on Trixie). List all three so the dropdown has the right one
      // regardless of host - birdnet-status.php's ALLOWED_UNITS already
      // skips ones systemd doesn't know about.
      + ['birdnet_recording','birdnet_analysis','birdnet_log','birdnet_stats','spectrogram_viewer','livestream','icecast2','caddy','php8.4-fpm','php8.3-fpm','php8.2-fpm']
          .map(function (u) { return '<option value="' + u + '">' + u + '</option>'; }).join('')
      + '  </select>'
      + '  <label>lines</label><input id="adminLogsLines" type="number" value="120" min="20" max="500" step="20">'
      + '</div>'
      + '<div class="admin-logs-pane" id="adminLogsOut">loading...</div>';
    var pane = document.getElementById('adminLogsOut');
    var sel = document.getElementById('adminLogsUnit');
    var linesIn = document.getElementById('adminLogsLines');
    sel.addEventListener('change', function () { unit = sel.value; tick(); });
    linesIn.addEventListener('change', function () { lines = +linesIn.value || 120; tick(); });
    pane.addEventListener('scroll', function () {
      autoScroll = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 20;
    });
    function tick() {
      adminApi('./avian/api/birdnet-status.php?action=logs&unit=' + encodeURIComponent(unit) + '&lines=' + lines)
        .then(function (r) { return r.text().then(function (raw) { return { status: r.status, raw: raw }; }); })
        .then(function (res) {
          var j = null;
          try { j = JSON.parse(res.raw); } catch (e) {}
          if (res.status !== 200 || !j) {
            pane.textContent = 'pi unreachable - ' + (j && j.error ? j.error : 'no data');
            return;
          }
          pane.textContent = j.text || '(empty)';
          if (autoScroll) pane.scrollTop = pane.scrollHeight;
        });
    }
    tick();
    adminPollT = setInterval(tick, 4000);
  }

  function renderAdminTools() {
    var actions = [
      ['restart birdnet_recording', 'picks up live audio from the mic. restart this first if detections stall.', 'birdnet_recording'],
      ['restart birdnet_analysis',  'runs the neural net on recorded chunks. restart if detections are stuck.', 'birdnet_analysis'],
      ['restart birdnet_log',       'writes the sqlite db. restart if api/stats stops updating.', 'birdnet_log'],
      ['restart spectrogram_viewer','live fft view (legacy) - used by /birdnet/spectrogram.', 'spectrogram_viewer'],
      ['restart livestream',        'icecast feed for the drawer live-audio button.', 'livestream'],
      ['restart icecast2',          'web audio streaming server (fronts livestream).', 'icecast2'],
    ];
    var html = '<div class="admin-actions-grid">';
    actions.forEach(function (a) {
      html += '<div class="admin-action">'
        + '<h4>' + adminEsc(a[0]) + '</h4>'
        + '<p>' + adminEsc(a[1]) + '</p>'
        + '<button class="run" type="button" data-unit="' + adminEsc(a[2]) + '">run</button>'
        + '<div class="out" data-out="' + adminEsc(a[2]) + '"></div>'
        + '</div>';
    });
    html += '</div>';
    html += '<h2 class="admin-section-head">heal / update</h2>';
    html += '<div class="admin-actions-grid">';
    function deployCard(title, desc, lines) {
      return '<div class="admin-action deploy">'
        + '<h4>' + adminEsc(title) + '</h4>'
        + '<p>' + adminEsc(desc) + '</p>'
        + '<pre>' + adminEsc(lines.join('\n')) + '</pre>'
        + '<button class="copy" type="button">copy</button>'
        + '</div>';
    }
    html += deployCard('pull latest from github',
      'fetches the newest AvianVisitors + BirdNET-Pi changes; the symlinks already in /BirdSongs/Extracted/ pick up new code on the next request.',
      [
        'cd ~/BirdNET-Pi && git pull',
        '# substitute the right php-fpm unit if your debian ships a different version:',
        'sudo systemctl reload caddy "$(systemctl list-unit-files \'php*-fpm.service\' --no-legend | awk \'{print $1; exit}\')"',
      ]);
    html += deployCard('rerun install_services.sh',
      'refreshes every symlink + service file. safe to run anytime; only takes ~10 seconds.',
      [
        'cd ~/BirdNET-Pi && ./scripts/install_services.sh',
      ]);
    html += '</div>';
    adminBody.innerHTML = html;
    // Wire restart buttons + copy buttons.
    adminBody.querySelectorAll('.admin-action button.run').forEach(function (b) {
      b.addEventListener('click', function () {
        var unit = b.dataset.unit;
        if (!confirm('restart ' + unit + '?')) return;
        b.disabled = true; var old = b.textContent; b.textContent = '...';
        var out = adminBody.querySelector('.out[data-out="' + unit.replace(/[^a-z0-9_.-]/gi,'_') + '"]');
        fetch('./avian/api/birdnet-status.php?action=restart&unit=' + encodeURIComponent(unit), {
          method: 'POST', credentials: 'same-origin',
        })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            b.textContent = j.ok ? 'restarted' : 'failed';
            if (out) out.textContent = (j.ok ? 'ok' : 'rc=' + j.rc) + (j.out ? '\n' + j.out : '');
            setTimeout(function () { b.disabled = false; b.textContent = old; }, 2000);
          })
          .catch(function (e) {
            b.textContent = 'error'; b.disabled = false;
            if (out) out.textContent = e.message || 'request failed';
            setTimeout(function () { b.textContent = old; }, 2000);
          });
      });
    });
    adminBody.querySelectorAll('.admin-action button.copy').forEach(function (b) {
      b.addEventListener('click', function () {
        var pre = b.previousElementSibling;
        if (!pre) return;
        navigator.clipboard.writeText(pre.textContent).then(function () {
          var old = b.textContent; b.textContent = 'copied ✓';
          setTimeout(function () { b.textContent = old; }, 1400);
        });
      });
    });
  }

  // Initial load: if URL has a sci hash, jump to atlas, highlight, and
  // open the modal.
  if (readHash()) { go(2); highlightAtlas(readHash()); openDetailModal(readHash()); }
  // Admin overlay routing: #admin=system|logs|tools opens the admin
  // screen with that sub-tab. Clearing the hash closes it.
  function readAdminHash() {
    var m = location.hash.match(/^#admin=([a-z]+)/);
    return m ? m[1] : null;
  }
  // #about - brief explainer popup; reached via /about (302 -> /#about)
  // or the masthead eyebrow. aria-hidden drives the CSS fade/slide.
  function openAbout()  { document.getElementById('about-modal').setAttribute('aria-hidden', 'false'); }
  function closeAbout() { document.getElementById('about-modal').setAttribute('aria-hidden', 'true'); }
  function syncRouter() {
    window.__lastHashchange = Date.now();
    var sci = readHash();
    var adm = readAdminHash();
    if (location.hash === '#about') openAbout(); else closeAbout();
    if (adm) { openAdmin(adm); return; }
    closeAdmin();
    if (sci) { go(2); highlightAtlas(sci); openDetailModal(sci); }
    else     { highlightAtlas(null); closeDetailModal(); }
  }
  if (readAdminHash()) openAdmin(readAdminHash());
  if (location.hash === '#about') openAbout();
  window.addEventListener('hashchange', syncRouter);

  // Modal interactions: backdrop / close button -> clear the hash.
  document.getElementById('detail-modal').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close === '1') {
      if (location.hash) { location.hash = ''; } else { closeDetailModal(); }
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' &&
        document.getElementById('detail-modal').getAttribute('aria-hidden') === 'false') {
      if (location.hash) { location.hash = ''; } else { closeDetailModal(); }
    }
  });

  // About popup: backdrop / close / explore button all carry data-close,
  // which clears the hash and routes through syncRouter -> closeAbout.
  // The masthead eyebrow opens it; Escape dismisses it.
  document.getElementById('about-modal').addEventListener('click', function (ev) {
    if (ev.target.dataset && ev.target.dataset.close === '1') {
      if (location.hash) { location.hash = ''; } else { closeAbout(); }
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' &&
        document.getElementById('about-modal').getAttribute('aria-hidden') === 'false') {
      if (location.hash) { location.hash = ''; } else { closeAbout(); }
    }
  });
  document.getElementById('aboutLink').addEventListener('click', function () {
    location.hash = '#about';
  });

  // Shared decode context for spectrogram generation. Lives once for
  // the page; lazily created on first expand to avoid bootstrapping
  // WebAudio if no one ever opens a row.
  var _specAudioCtx = null;
  function getSpecCtx() {
    if (!_specAudioCtx) {
      var C = window.AudioContext || window.webkitAudioContext;
      if (C) _specAudioCtx = new C();
    }
    return _specAudioCtx;
  }

  // Cache decoded AudioBuffers per file so repeated expand/collapse on
  // the same row doesn't re-fetch + re-decode the mp3.
  var _decodedCache = {};

  // Minimal in-place Cooley-Tukey radix-2 FFT (n must be a power of 2).
  // Operates on parallel real/imag Float32Array buffers. ~30 lines and
  // fast enough for our ~1024-sample windows of 3-second clips.
  function _fft(real, imag) {
    var n = real.length;
    var j = 0;
    for (var i = 0; i < n - 1; i++) {
      if (i < j) {
        var tr = real[i]; real[i] = real[j]; real[j] = tr;
        var ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      var k = n >> 1;
      while (k <= j) { j -= k; k >>= 1; }
      j += k;
    }
    for (var stage = 2; stage <= n; stage *= 2) {
      var half = stage >> 1;
      var ang = -2 * Math.PI / stage;
      var wR = Math.cos(ang), wI = Math.sin(ang);
      for (var sBase = 0; sBase < n; sBase += stage) {
        var cR = 1, cI = 0;
        for (var sb = 0; sb < half; sb++) {
          var a = sBase + sb;
          var b = a + half;
          var trA = real[b] * cR - imag[b] * cI;
          var tiA = real[b] * cI + imag[b] * cR;
          real[b] = real[a] - trA;
          imag[b] = imag[a] - tiA;
          real[a] = real[a] + trA;
          imag[a] = imag[a] + tiA;
          var nR = cR * wR - cI * wI;
          cI = cR * wI + cI * wR;
          cR = nR;
        }
      }
    }
  }

  // Paint an STFT spectrogram onto the strip's canvas. y-axis is the
  // bird audible band (~200 Hz - ~10 kHz) on a mildly compressed log
  // scale; x-axis is time across the whole clip; colour is dB
  // magnitude mapped to our warm ink palette over the dark paper-ink
  // ground.
  function paintSpectrogram(canvas, audioBuffer) {
    // Defer to the next animation frame so the canvas has been laid out
    // (the parent strip may still be mid-transition expanding from 0).
    // Without this, subsequent expansions paint onto a zero-sized canvas.
    requestAnimationFrame(function () {
      _paintSpectrogramNow(canvas, audioBuffer);
    });
  }
  function _paintSpectrogramNow(canvas, audioBuffer) {
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    // Read parent strip's box, not the canvas (canvas might be 0-sized
    // briefly during expansion). The strip's expanded height is 88px;
    // width is the row width.
    var strip = canvas.parentElement;
    var cssW = strip ? strip.clientWidth : (canvas.clientWidth || 600);
    var cssH = strip ? strip.clientHeight : (canvas.clientHeight || 88);
    if (cssW < 32 || cssH < 32) {
      // Strip still collapsing in. Retry a frame later.
      requestAnimationFrame(function () { _paintSpectrogramNow(canvas, audioBuffer); });
      return;
    }
    var W = Math.max(1, Math.floor(cssW * dpr));
    var H = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = W; canvas.height = H;

    var ctx = canvas.getContext('2d');
    var samples = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var FFT_SIZE = 1024;
    var bins = FFT_SIZE >> 1;
    var nyquist = sr / 2;

    // Frequency-band mapping (Hz -> bin) for the bird-relevant band.
    // Most North American songbirds + corvids range 250 Hz - 8 kHz, but
    // hummingbirds, kinglets, and warblers reach 12 kHz. Push the cap
    // up so we don't miss the high-frequency tail.
    var fLo = 200, fHi = Math.min(12000, nyquist);
    var binLo = Math.max(1, Math.floor(fLo / nyquist * bins));
    var binHi = Math.min(bins - 1, Math.ceil(fHi / nyquist * bins));

    // Hann window
    var win = new Float32Array(FFT_SIZE);
    for (var i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }

    // Choose a hop that lays exactly W columns over the whole clip.
    var hop = Math.max(1, Math.floor((samples.length - FFT_SIZE) / Math.max(1, W - 1)));
    var real = new Float32Array(FFT_SIZE);
    var imag = new Float32Array(FFT_SIZE);

    var imgData = ctx.createImageData(W, H);
    var data = imgData.data;

    // Paper ground; ink intensifies where there's audio energy. Theme-
    // aware so dark mode gets a charcoal ground with a light trace instead
    // of a glaring light rectangle (matches --paper / --ink per theme).
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var BG_R = dark ? 23  : 245, BG_G = dark ? 24  : 240, BG_B = dark ? 28  : 230;
    var FG_R = dark ? 236 : 26,  FG_G = dark ? 232 : 22,  FG_B = dark ? 225 : 18;
    for (var p = 0; p < data.length; p += 4) {
      data[p] = BG_R; data[p + 1] = BG_G; data[p + 2] = BG_B; data[p + 3] = 255;
    }

    // Precompute row -> bin map (log-ish so low freqs get more space).
    var rowToBin = new Int32Array(H);
    for (var row = 0; row < H; row++) {
      var t = 1 - row / (H - 1); // 1 at top, 0 at bottom
      var bin = Math.round(binLo + (binHi - binLo) * Math.pow(t, 1.55));
      rowToBin[row] = Math.max(binLo, Math.min(binHi, bin));
    }

    for (var col = 0; col < W; col++) {
      var start = col * hop;
      if (start + FFT_SIZE > samples.length) break;
      for (var s = 0; s < FFT_SIZE; s++) {
        real[s] = samples[start + s] * win[s];
        imag[s] = 0;
      }
      _fft(real, imag);
      for (var row2 = 0; row2 < H; row2++) {
        var bin2 = rowToBin[row2];
        var re = real[bin2], im = imag[bin2];
        var mag = Math.sqrt(re * re + im * im);
        // log compress; -75 .. -10 dB -> 0 .. 1
        var db = 20 * Math.log10(mag + 1e-9);
        var v = (db + 75) / 65;
        if (v < 0) v = 0; else if (v > 1) v = 1;
        // Ink-on-paper palette: low energy -> paper, high energy -> ink.
        // Smoothstep for a softer falloff between the two extremes.
        var e = v * v * (3 - 2 * v);
        var r = BG_R + Math.round((FG_R - BG_R) * e);
        var g = BG_G + Math.round((FG_G - BG_G) * e);
        var b = BG_B + Math.round((FG_B - BG_B) * e);
        var px = (row2 * W + col) * 4;
        data[px] = r; data[px + 1] = g; data[px + 2] = b; data[px + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    canvas.classList.add('ready');
  }

  // Lazy-add + paint the canvas-based spectrogram for a row's strip.
  // Decoded buffers are cached per file so re-expanding is instant.
  function ensureSpectroImage(row) {
    var file = row && row.dataset.file;
    if (!file) return;
    var strip = row.querySelector('.rec-spectro');
    if (!strip) return;
    var loadingEl = strip.querySelector('.rec-spectro-loading');
    var canvas = strip.querySelector('canvas');
    if (canvas && canvas.classList.contains('ready')) {
      if (loadingEl) loadingEl.style.display = 'none';
      return;
    }
    if (!canvas) {
      canvas = document.createElement('canvas');
      var played = strip.querySelector('.rec-spectro-played');
      strip.insertBefore(canvas, played);
    }
    if (loadingEl) {
      loadingEl.style.display = '';
      loadingEl.textContent = 'rendering spectrogram...';
    }

    function done() {
      if (loadingEl) loadingEl.style.display = 'none';
    }
    function fail(reason) {
      if (loadingEl) {
        loadingEl.style.display = '';
        loadingEl.textContent = reason || 'spectrogram unavailable';
      }
    }

    if (_decodedCache[file]) {
      paintSpectrogram(canvas, _decodedCache[file]);
      done();
      return;
    }
    var ctx = getSpecCtx();
    if (!ctx) { fail('WebAudio not available'); return; }
    fetch('./avian/api/recording.php?file=' + encodeURIComponent(file))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) { return ctx.decodeAudioData(buf); })
      .then(function (audioBuffer) {
        _decodedCache[file] = audioBuffer;
        paintSpectrogram(canvas, audioBuffer);
        done();
      })
      .catch(function (e) {
        fail('spectrogram failed: ' + (e && e.message ? e.message : ''));
      });
  }

  // Per-recording row interactions in the modal:
  //   - Clicking anywhere on the row toggles the spectrogram strip
  //     (independent of playback). Click again to collapse.
  //   - Clicking the play button toggles audio playback. Playback shows
  //     the moving cursor on whatever strip is already expanded; if the
  //     strip is collapsed, playing also expands it.
  //   - Clicking on the spectrogram itself scrubs (handled in the
  //     mousedown/touchstart wiring further down).
  document.getElementById('modalRecordings').addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    // Scrub-region clicks are handled by the mousedown wiring below.
    if (ev.target.closest('.rec-spectro-scrub')) return;

    var playBtn = ev.target.closest('.play');
    if (playBtn) {
      // Play / pause toggle. Three cases:
      //   (a) clicking the playing row's button -> pause (KEEP audio
      //       alive so the user can scrub then resume).
      //   (b) clicking a paused row's button (it's still modalRecBtn,
      //       audio still alive, just paused) -> resume from cursor.
      //   (c) clicking a different row's button -> stop the old, start
      //       the new.
      var prow = playBtn.closest('.rec-row');
      var pfile = prow && prow.dataset.file;
      if (!pfile) return;

      if (modalRecBtn === playBtn && modalAudio) {
        // Same row's button - toggle pause/resume.
        if (modalAudio.paused) {
          playBtn.setAttribute('data-active', 'true');
          playBtn.innerHTML = ICON_PAUSE;
          audioClaim(stopModalAudio);   // stop any card / live-stream audio
          modalAudio.play().catch(function () {});
        } else {
          pauseModalAudio();
        }
        return;
      }

      // Different row (or no current playback) - stop any current,
      // start fresh.
      stopModalAudio();
      audioClaim(stopModalAudio);   // stop any card / live-stream audio
      playBtn.setAttribute('data-active', 'true');
      playBtn.innerHTML = ICON_PAUSE;
      modalRecBtn = playBtn;
      prow.classList.add('expanded');
      ensureSpectroImage(prow);
      var strip = prow.querySelector('.rec-spectro');
      var audio = new Audio('./avian/api/recording.php?file=' + encodeURIComponent(pfile));
      modalAudio = audio;
      audio.addEventListener('loadedmetadata', function () {
        strip.classList.add('armed');
      });
      audio.addEventListener('playing', startCursorLoop);
      audio.addEventListener('pause', stopCursorLoop);
      audio.addEventListener('ended', function () {
        // Natural end: rewind cursor + keep audio so user can replay.
        stopCursorLoop();
        var p = strip.querySelector('.rec-spectro-played');
        var c = strip.querySelector('.rec-spectro-cursor');
        if (p) p.style.width = '0%';
        if (c) c.style.left = '0%';
        if (modalAudio) modalAudio.currentTime = 0;
        if (modalRecBtn) {
          modalRecBtn.removeAttribute('data-active');
          modalRecBtn.innerHTML = ICON_PLAY;
        }
      });
      audio.addEventListener('error', function () {
        stopModalAudio();
        playBtn.innerHTML = '<span style="font-size:8px">!</span>';
        setTimeout(function () { playBtn.innerHTML = ICON_PLAY; }, 1500);
      });
      audio.play().catch(function () { stopModalAudio(); });
      return;
    }

    // Row click anywhere else -> toggle strip open/closed.
    var row = ev.target.closest('.rec-row');
    if (!row) return;
    var willExpand = !row.classList.contains('expanded');
    if (willExpand) {
      row.classList.add('expanded');
      ensureSpectroImage(row);
    } else {
      // Collapsing the row where playback is happening also stops audio
      // (the cursor would just be hidden otherwise).
      if (modalRecBtn && modalRecBtn.closest('.rec-row') === row) stopModalAudio();
      row.classList.remove('expanded');
    }
  });

  // Scrub by clicking / dragging on the spectrogram strip.
  (function () {
    var dragRow = null;
    function seekFromEvent(row, clientX) {
      if (!modalAudio || !modalAudio.duration) return;
      var rowBtn = row.querySelector('.play');
      if (rowBtn !== modalRecBtn) return;
      var strip = row.querySelector('.rec-spectro');
      var rect = strip.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      modalAudio.currentTime = pct * modalAudio.duration;
      // Repaint cursor + played immediately so the user sees the scrub
      // even when audio is paused (rAF loop isn't running then).
      var pctStr = (pct * 100).toFixed(2) + '%';
      var played = strip.querySelector('.rec-spectro-played');
      var cur = strip.querySelector('.rec-spectro-cursor');
      if (played) played.style.width = pctStr;
      if (cur) cur.style.left = pctStr;
    }
    document.getElementById('modalRecordings').addEventListener('mousedown', function (ev) {
      var s = ev.target.closest && ev.target.closest('.rec-spectro-scrub');
      if (!s) return;
      var row = s.closest('.rec-row');
      if (!row || !row.classList.contains('expanded')) return;
      dragRow = row;
      seekFromEvent(row, ev.clientX);
      ev.preventDefault();
    });
    document.addEventListener('mousemove', function (ev) {
      if (!dragRow) return;
      seekFromEvent(dragRow, ev.clientX);
    });
    document.addEventListener('mouseup', function () { dragRow = null; });
    // Touch.
    document.getElementById('modalRecordings').addEventListener('touchstart', function (ev) {
      var s = ev.target.closest && ev.target.closest('.rec-spectro-scrub');
      if (!s) return;
      var row = s.closest('.rec-row');
      if (!row || !row.classList.contains('expanded')) return;
      dragRow = row;
      seekFromEvent(row, ev.touches[0].clientX);
      ev.preventDefault();
    }, { passive: false });
    document.addEventListener('touchmove', function (ev) {
      if (!dragRow) return;
      seekFromEvent(dragRow, ev.touches[0].clientX);
    });
    document.addEventListener('touchend', function () { dragRow = null; });
  })();

  // Any element with data-sci is a "jump to that bird's atlas card"
  // affordance: atlas cards themselves, stats list rows (top species /
  // first detections), stats timeline squares, and any future surface
  // that wants to point at a bird. Action chips inside cards stop
  // propagation themselves.
  function jumpToSci(sci) {
    if (!sci) return;
    if (location.hash !== '#sci=' + encodeURIComponent(sci)) {
      location.hash = '#sci=' + encodeURIComponent(sci);
    } else {
      // Same hash -> still re-highlight (the user clicked it again).
      go(2); highlightAtlas(sci);
    }
  }
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest) return;
    var card = ev.target.closest('.bird-card');
    if (card) {
      if (ev.target.closest('.actions, .spectro-wrap')) return;
      return jumpToSci(card.dataset.sci);
    }
    var row = ev.target.closest('li[data-sci]');
    if (row) return jumpToSci(row.dataset.sci);
    var tlCol = ev.target.closest('.stats-tl-col[data-sci]');
    if (tlCol) return jumpToSci(tlCol.dataset.sci);
  });

  // After the atlas re-renders (window change, fresh fetch), re-apply
  // any active hash so the highlight survives a rebuild.
  var _origRenderAtlas = renderAtlas;
  renderAtlas = function (animate) {
    _origRenderAtlas(animate);
    var s = readHash();
    if (s) highlightAtlas(s);
  };
})();
