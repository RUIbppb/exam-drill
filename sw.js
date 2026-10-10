/*
 * sw.js — service worker（製作人Rui / Maker Rui）
 *
 * 做兩件事：讓 App 離線也能刷題、讓它可以加到手機主畫面當獨立 App 用。
 *
 * 快取策略刻意分成兩種（這是避免「我明明改好了、手機上還是舊的」的關鍵）：
 *
 *  1. 程式本體（index.html、css、js、說明頁）＝「先問網路、拿不到才用快取」
 *     → 有網路時永遠拿到最新版，沒網路時用上次存的，照樣能刷。
 *
 *  2. 題庫 JSON ＝「先拿快取」
 *     → 題庫很大又不常動，手機不用每次重新下載。
 *       題庫版本一變，網址後面的 ?v= 就變，自然會去抓新的；
 *       舊的那份由 bank.js 在發現版本不同時整包清掉。
 *
 * 【改版注意】改了 index.html / css / js 之後，把 SHELL_CACHE 的版本號往上加一號，
 * 舊的殼快取才會被清掉。順序：app.js 的 APP_VERSION → 這裡的 SHELL_CACHE 一起改。
 */

'use strict';

var SHELL_CACHE = 'pq-shell-v2.1';  // 程式本體快取（改版要進位）
var DATA_CACHE = 'pq-data';         // 題庫快取（名稱固定，內容靠網址版本號區分）

var SHELL_TIMEOUT = 4500;           // 程式本體等網路幾毫秒，超過就先用快取頂著

/*
 * 第一次安裝就先存起來的檔案，少了任何一個離線就會缺東西。
 * 【務必保留 ./data/index.json】沒有索引，離線時連科目清單都列不出來，
 * 整個 App 會停在「題庫索引載入失敗」。各科題庫則由 bank.js 在背景補抓。
 */
var SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/core.js',
  './js/storage.js',
  './js/bank.js',
  './js/explain.js',
  './js/app.js',
  './js/exam.js',
  './js/essay.js',
  './manifest.json',
  './data/index.json',
  './使用說明.html',
  './self-test.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-maskable-512.png'
];

/* 安裝：把程式本體存進快取。個別檔案抓不到也不要讓整個安裝失敗 */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL_FILES.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {
          // 某個檔案存不進去就跳過，不要整包安裝失敗
          return null;
        });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

/* 啟用：清掉舊版的程式本體快取（題庫快取不動，不要害使用者重新下載題庫） */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf('pq-') !== 0) return null;          // 不是這個 App 的快取就別碰
        if (name === SHELL_CACHE || name === DATA_CACHE) return null;
        return caches.delete(name);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/** 這個回應能不能存進快取（只存自己站上、正常回來的東西） */
function isCacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'default');
}

/** 題庫檔：先拿快取，沒有才連網路 */
function dataFirstFromCache(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (isCacheable(response)) {
        var copy = response.clone();
        caches.open(DATA_CACHE).then(function (cache) {
          cache.put(request, copy);
        }).catch(function () { return null; });
      }
      return response;
    }).catch(function (error) {
      // 沒網路又沒這個版本的快取時，退回舊版本的同一個檔案（有舊題目可刷，勝過開不起來）
      return caches.match(request, { ignoreSearch: true }).then(function (older) {
        if (older) return older;
        throw error;
      });
    });
  });
}

/** 沒有快取可退時的最後一招：開頁的請求至少要給首頁，不可以留白 */
function fallbackFromCache(request, error) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    if (request.mode === 'navigate') {
      return caches.match('./index.html').then(function (home) {
        if (home) return home;
        throw error;
      });
    }
    throw error;
  });
}

/**
 * 程式本體：先問網路，拿不到（或太慢）才用快取。
 *
 * 【為什麼要設逾時】通勤與值班最常遇到的不是完全沒訊號，而是「訊號格數滿但資料不通」。
 * 這時 fetch 不會馬上失敗，會一路等到瀏覽器自己放棄（可能超過一分鐘），
 * 畫面就這樣白著。所以等 SHELL_TIMEOUT 毫秒沒回應就先用快取頂著，
 * 網路那邊繼續跑，回來之後照樣把新版存進快取，下次開就是新的。
 */
function shellNetworkFirst(request) {
  var settled = false;

  var fromNetwork = fetch(request).then(function (response) {
    if (isCacheable(response)) {
      var copy = response.clone();
      caches.open(SHELL_CACHE).then(function (cache) {
        cache.put(request, copy);
      }).catch(function () { return null; });
    }
    settled = true;
    return response;
  }).catch(function (error) {
    settled = true;
    return fallbackFromCache(request, error);
  });

  var fromCacheWhenSlow = new Promise(function (resolve) {
    setTimeout(function () {
      if (settled) return;              // 網路已經回來了就不用插手
      caches.match(request).then(function (cached) {
        if (cached) resolve(cached);    // 有快取就先給，網路那邊繼續在背景更新
      }).catch(function () { return null; });
    }, SHELL_TIMEOUT);
  });

  return Promise.race([fromNetwork, fromCacheWhenSlow]);
}

self.addEventListener('fetch', function (event) {
  var request = event.request;

  // 只管自己站上的 GET 請求，其他一律放行
  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  /*
   * 連線測試（網址帶 pq-ping）一律放行，讓它直接去問網路。
   * 【這段不可以拿掉】如果讓它走下面的快取邏輯，沒網路的時候會拿到快取、
   * 回報「連得上」，接著「檢查更新」就會把離線版的快取清光——
   * 使用者在沒網路的地方按一下，整個 App 就廢了。
   */
  if (url.searchParams && url.searchParams.has('pq-ping')) return;

  // 題庫索引（index.json）要先問網路，不然永遠不知道有新題庫
  var isBankIndex = /\/data\/index\.json$/.test(url.pathname);
  var isBankFile = /\/data\/.+\.json$/.test(url.pathname) && !isBankIndex;

  if (isBankFile) {
    event.respondWith(dataFirstFromCache(request));
  } else {
    event.respondWith(shellNetworkFirst(request));
  }
});
