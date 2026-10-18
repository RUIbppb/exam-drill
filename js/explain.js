/*
 * explain.js — AI 詳解（製作人Rui / Maker Rui）
 *
 * 官方考古題只公布答案字母、沒有任何解析，答錯只知道錯、不知道錯在哪。
 * 這支檔案負責「按下去問 AI，拿到講解，存起來下次免費又能離線看」。
 *
 * 【金鑰】程式碼裡一個字都沒有，也絕不會進 git。
 *   金鑰由使用者自己在設定頁貼上，存在這台裝置的瀏覽器裡（PQStore 管），
 *   匯出進度時不會被帶出去。這是純前端網頁唯一安全的做法：
 *   寫進程式碼的金鑰等於公開（任何人打開原始碼都看得到）。
 *
 * 【快取】詳解存在 IndexedDB，不跟進度擠在 localStorage 那 5MB 裡。
 *   一題詳解 1～2 KB，累積一千題就 2MB，擠在一起遲早爆掉。
 *   分開還有個好處：詳解快取真的出問題，清掉它不會動到作答進度。
 *   快取不是效能優化，是離線可用性的核心——沒網路時照樣看得到問過的詳解。
 *
 * 【快取綁定題目內容】一筆快取 = { id: 題號, text, model, provider, askedAt, contentFingerprint }。
 *   題庫修正題幹或選項時題號不變，用題號存的舊詳解可能是對著壞掉的題目寫的，
 *   所以新存的詳解多帶一個「題目內容指紋」，讀的時候指紋對不上就當作沒有快取、重新問。
 *   舊版存的沒有指紋，就看題號在不在 index.json 的 contentFixedIds（修正過的題號清單）。
 *   判斷規則是純函式，在 core.js 的 explainCacheVerdict，自我檢查頁有測試。
 *   作廢的舊詳解不主動刪除，重新問完直接蓋掉；沒問題的舊詳解一筆都不會被動到。
 *
 * 【分層】AI 的網路請求只在這支檔案裡，app.js 不直接碰。
 */

var PQExplain = (function () {
  'use strict';

  var DB_NAME = 'policeQuizExplain';
  var DB_VERSION = 1;
  var STORE_NAME = 'explanations';
  var ASK_TIMEOUT = 60000;        // AI 要想一下，給它一分鐘

  var memoryCache = {};           // IndexedDB 不能用時的退路（關掉分頁就沒了）
  var dbPromise = null;

  /** 原始錯誤只寫主控台，不給使用者看英文 */
  function logDetail(where, error) {
    if (window.console && console.warn) console.warn('[AI 詳解] ' + where, error);
  }

  /* ---------- IndexedDB 快取 ---------- */

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve) {
      if (!window.indexedDB) {
        resolve(null);              // 瀏覽器不支援就退回記憶體快取
        return;
      }
      var request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        logDetail('打不開快取資料庫', e);
        resolve(null);
        return;
      }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () {
        logDetail('快取資料庫開啟失敗', request.error);
        resolve(null);
      };
      request.onblocked = function () { resolve(null); };
    });

    return dbPromise;
  }

  /** 讀快取。讀不到一律回 null，不丟錯 */
  function readCache(questionId) {
    if (!questionId) return Promise.resolve(null);
    return openDb().then(function (db) {
      if (!db) return memoryCache[questionId] || null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE_NAME, 'readonly');
          var request = tx.objectStore(STORE_NAME).get(questionId);
          request.onsuccess = function () { resolve(request.result || null); };
          request.onerror = function () { resolve(null); };
        } catch (e) {
          logDetail('讀快取失敗', e);
          resolve(null);
        }
      });
    }).catch(function () { return null; });
  }

  /** 寫快取。寫不進去不影響使用（這次照樣看得到），只是下次要重問 */
  function writeCache(record) {
    memoryCache[record.id] = record;
    return openDb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(record);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) {
          logDetail('寫快取失敗', e);
          resolve(false);
        }
      });
    }).catch(function () { return false; });
  }

  /** 清掉全部詳解快取（設定頁用）。不會動到作答進度 */
  function clearCache() {
    memoryCache = {};
    return openDb().then(function (db) {
      if (!db) return true;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) {
          resolve(false);
        }
      });
    }).catch(function () { return false; });
  }

  /** 已經存了幾題詳解 */
  function countCached() {
    return openDb().then(function (db) {
      if (!db) return Object.keys(memoryCache).length;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE_NAME, 'readonly');
          var request = tx.objectStore(STORE_NAME).count();
          request.onsuccess = function () { resolve(request.result || 0); };
          request.onerror = function () { resolve(0); };
        } catch (e) {
          resolve(0);
        }
      });
    }).catch(function () { return 0; });
  }

  /* ---------- 供應商 ---------- */

  /**
   * 目前只接 Anthropic（Claude）。
   * 官方支援瀏覽器直連，就是為了「使用者自己貼自己的金鑰」這種用法設計的，
   * 但要帶 anthropic-dangerous-direct-browser-access 這個標頭它才肯放行。
   *
   * 要換供應商時在這裡加一筆，設定頁的下拉就會多一個選項。
   */
  var PROVIDERS = {
    anthropic: {
      name: 'Anthropic（Claude）',
      models: [
        { id: 'claude-opus-5-5', name: 'Claude Opus 5.5（最準，一題約 0.3 元）' },
        { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5（均衡，一題約 0.16 元）' },
        { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5（最便宜，一題約 0.01 元）' }
      ],
      keyHint: '金鑰格式是 sk-ant- 開頭，到 Anthropic 官網的 API Keys 頁面申請。',
      send: function (prompt, key, model, signal) {
        return fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal: signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            // 沒有這個標頭，瀏覽器直連會被擋掉
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }]
          })
        }).then(function (response) {
          return response.text().then(function (text) {
            return { status: response.status, ok: response.ok, text: text };
          });
        }).then(function (raw) {
          if (!raw.ok) {
            var err = new Error('AI 回應狀態 ' + raw.status);
            err.httpStatus = raw.status;
            err.rawBody = raw.text;
            throw err;
          }
          var data = JSON.parse(raw.text);
          var parts = (data && data.content) || [];
          var answer = parts.filter(function (part) { return part && part.type === 'text'; })
            .map(function (part) { return part.text; }).join('\n').trim();
          if (!answer) throw new Error('AI 沒有回傳內容');
          return answer;
        });
      }
    }
  };

  function listProviders() {
    return Object.keys(PROVIDERS).map(function (id) {
      return { id: id, name: PROVIDERS[id].name, models: PROVIDERS[id].models, keyHint: PROVIDERS[id].keyHint };
    });
  }

  function getProvider(id) {
    return PROVIDERS[id] || PROVIDERS.anthropic;
  }

  /** 把各種失敗歸類成原因代號，再交給 core.js 翻成白話 */
  function classify(error) {
    if (!error) return 'unknown';
    if (error.name === 'AbortError') return 'timeout';
    var status = Number(error.httpStatus);
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate';
    if (status >= 500) return 'busy';
    if (error.name === 'TypeError') {
      // 直連被擋跟沒網路都是 TypeError，分不出來就看瀏覽器在不在線上
      return navigator.onLine === false ? 'offline' : 'blocked';
    }
    return 'unknown';
  }

  /* ---------- 快取和題目內容對不對得上 ---------- */

  /**
   * 判斷快取能不能用（規則在 core.js 的 explainCacheVerdict）。
   * 萬一判斷過程出了意外，退回改版前的行為（有講解就用），絕不讓按鈕因此壞掉。
   */
  function checkCache(cached, question, contentFixedIds) {
    try {
      return PQPure.explainCacheVerdict(cached, question, contentFixedIds);
    } catch (e) {
      logDetail('判斷快取是否還能用時出錯，改用舊規則', e);
      var hasText = !!(cached && cached.text);
      return { usable: hasText, invalidated: false, backfill: false, fingerprint: null };
    }
  }

  /**
   * 舊版存的詳解（沒有指紋）確認可以用之後，順手補上目前題目的指紋，
   * 以後題目再修正也判斷得出來。整筆照抄、只多一個欄位，講解內容一個字都不動。
   * 補不進去也沒關係，下次打開再補，所以不等它寫完、也不往外丟錯。
   */
  function backfillFingerprint(cached, fingerprint) {
    if (!cached || !fingerprint) return;
    var updated = {};
    Object.keys(cached).forEach(function (field) { updated[field] = cached[field]; });
    updated.contentFingerprint = fingerprint;
    writeCache(updated);
  }

  /* ---------- 對外：問一題 ---------- */

  /**
   * 要一題的詳解。有快取（而且跟目前題目內容對得上）就直接給，沒有才真的去問 AI。
   * @param {Object} question 題目
   * @param {Object} options { key, provider, model, force, contentFixedIds }
   *   contentFixedIds：index.json 裡「題目內容修正過」的題號清單，沒有就不傳（照舊行為）
   * @returns {Promise<{text, fromCache, model, askedAt, contentChanged}>}
   *   contentChanged：題目內容修正過、舊講解作廢，這次是重新問的
   */
  function ask(question, options) {
    var settings = options || {};
    var id = question && question.id;
    if (!id) return Promise.reject(new Error(PQPure.aiErrorText('unknown')));

    return readCache(id).then(function (cached) {
      var verdict = checkCache(cached, question, settings.contentFixedIds);
      if (verdict.usable && !settings.force) {
        if (verdict.backfill) backfillFingerprint(cached, verdict.fingerprint);
        return { text: cached.text, fromCache: true, model: cached.model, askedAt: cached.askedAt };
      }
      var contentChanged = verdict.invalidated;

      var key = String(settings.key || '').trim();
      if (!key) throw new Error(PQPure.aiErrorText('nokey'));

      var provider = getProvider(settings.provider);
      var model = settings.model || (provider.models[0] && provider.models[0].id);
      var prompt = PQPure.buildExplainPrompt(question);

      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller
        ? window.setTimeout(function () { controller.abort(); }, ASK_TIMEOUT) : null;

      return provider.send(prompt, key, model, controller ? controller.signal : undefined)
        .then(function (text) {
          if (timer) window.clearTimeout(timer);
          var record = {
            id: id,
            text: text,
            model: model,
            provider: settings.provider || 'anthropic',
            askedAt: PQPure.toTaipeiStampString(new Date()),
            contentFingerprint: verdict.fingerprint   // 題目內容一變就對不上，舊講解自動作廢
          };
          return writeCache(record).then(function () {
            return {
              text: text,
              fromCache: false,
              model: model,
              askedAt: record.askedAt,
              contentChanged: contentChanged
            };
          });
        })
        .catch(function (error) {
          if (timer) window.clearTimeout(timer);
          logDetail('問 AI 失敗', error);
          throw new Error(PQPure.aiErrorText(classify(error)));
        });
    });
  }

  return {
    listProviders: listProviders,
    readCache: readCache,
    clearCache: clearCache,
    countCached: countCached,
    ask: ask
  };
}());
