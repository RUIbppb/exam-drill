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
  /*
   * 【時限要算在每個模型頭上，不是整段共用】
   * 原本整段只有一個時鐘，第一個模型卡住就把時間吃光，後面兩個根本沒機會試，
   * 使用者等滿一分多鐘換來一句「AI 想太久了」。
   * 改成一個模型最多等 30 秒，超過就當它不通、立刻換下一個。
   */
  var PER_MODEL_TIMEOUT = 30000;  // 單一模型最多等 30 秒

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
   * 兩家供應商，設定頁可以隨時切換，金鑰分開存。
   *
   * Anthropic（Claude）：官方支援瀏覽器直連，就是為了「使用者自己貼自己的金鑰」
   * 這種用法設計的，但要帶 anthropic-dangerous-direct-browser-access 標頭才放行。
   *
   * Google（Gemini）：有免費額度。
   *   ⚠️ 只能用 models/<模型>:generateContent 這個端點。
   *   2026-11-25 從 ruibppb.github.io 實測：generateContent 的 CORS 通得過
   *   （回得到可讀的 400），但官方現在主推的 /v1beta/interactions 會被 CORS 擋掉。
   *   要換端點之前先實測，不要照搬官方 quickstart。
   *   ⚠️ 免費方案的條款寫明 Google 會用送進去的內容改善產品、人工審閱者可能讀得到，
   *   而且要求不要送敏感或個人資訊。刷題送的是公開考古題，但別拿它問別的東西。
   *
   * 要再加供應商時在這裡加一筆，設定頁的下拉就會多一個選項。
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
    },

    google: {
      name: 'Google（Gemini）— 有免費額度',
      models: [
        { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash（免費額度內）' },
        { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen（免費額度內）' },
        { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite（最輕量，免費額度內）' }
      ],
      keyHint: '到 Google AI Studio（aistudio.google.com）的 API keys 頁面申請，免費額度不用綁信用卡。' +
        '⚠️ 免費方案的內容 Google 會拿去改善產品，也可能有人工審閱，所以只拿來問考古題，別問別的。',
      send: function (prompt, key, model, signal) {
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model) + ':generateContent';
        return fetch(url, {
          method: 'POST',
          signal: signal,
          headers: {
            'content-type': 'application/json',
            // 金鑰放標頭不放網址，才不會被記進瀏覽器歷史或伺服器日誌
            'x-goog-api-key': key
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1500 }
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
          var candidates = (data && data.candidates) || [];
          var parts = (candidates[0] && candidates[0].content && candidates[0].content.parts) || [];
          var answer = parts.map(function (part) { return (part && part.text) || ''; })
            .join('\n').trim();
          if (!answer) {
            // 被安全設定擋下時 candidates 會是空的或帶 finishReason，講清楚免得以為是壞掉
            var reason = (candidates[0] && candidates[0].finishReason) ||
              (data && data.promptFeedback && data.promptFeedback.blockReason) || '';
            throw new Error(reason ? ('AI 沒有回傳內容（' + reason + '）') : 'AI 沒有回傳內容');
          }
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

  /**
   * 把供應商自己回的錯誤訊息挖出來。
   *
   * 【為什麼一定要挖】不挖的話，所有沒歸類到的失敗都只會顯示「出了狀況，稍後再試」，
   * 那句話對使用者毫無幫助，對除錯的人也一樣。2026-11-25 實際踩到：Gemini 的金鑰
   * 錯誤回的是 400 不是 401，分類表認不出來，畫面就只剩那句萬用句。
   *
   * 兩家的格式都是 { error: { message } }，拿不到就回空字串，絕不讓它自己丟錯。
   */
  function apiMessage(error) {
    try {
      var body = error && error.rawBody;
      if (!body) return '';
      var data = JSON.parse(body);
      var msg = (data && data.error && data.error.message) || '';
      return String(msg).trim().slice(0, 200);
    } catch (e) {
      return '';
    }
  }

  /** 把各種失敗歸類成原因代號，再交給 core.js 翻成白話 */
  function classify(error) {
    if (!error) return 'unknown';
    if (error.name === 'AbortError') return 'timeout';
    var status = Number(error.httpStatus);
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate';
    if (status >= 500) return 'busy';
    // Gemini 的金鑰不對回的是 400 不是 401，只看狀態碼會漏掉，要連訊息一起看
    if (status === 400 && /API[ _]key|API_KEY_INVALID|api key/i.test(apiMessage(error))) {
      return 'auth';
    }
    if (status === 404) return 'model';
    if (status === 400) return 'badrequest';
    if (error.name === 'TypeError') {
      // 直連被擋跟沒網路都是 TypeError，分不出來就看瀏覽器在不在線上
      return navigator.onLine === false ? 'offline' : 'blocked';
    }
    return 'unknown';
  }

  /* ---------- 暫時性失敗自動重試 ---------- */

  /*
   * 【塞車就換模型，不要叫人等】免費額度的模型常常塞車，Google 會回
   * 「This model is currently experiencing high demand」。
   *
   * 直覺做法是「等幾秒再試同一個模型」，但那等於把人晾在那裡，
   * 而且同一個模型剛塞爆，幾秒後多半還是塞的。
   *
   * 改成**立刻換下一個模型**：每個模型的容量是分開的，這個擠不進去
   * 不代表另一個也擠不進去。塞車的回應本來就回得很快（直接回 503），
   * 所以整段流程不會比單打一個模型慢多少，使用者按下去就有反應。
   *
   * 只有「換一個就可能成功」的失敗才換（塞車、額度節流）；
   * 金鑰錯、模型不存在這種換幾個都一樣，立刻放棄比較快。
   *
   * 問 AI 是純讀取、不會改到任何東西，所以重試是安全的。
   * （會寫入的動作不重試——這條界線在記帳 App 那邊也是一樣的。）
   */
  var RETRYABLE = { busy: true, rate: true, timeout: true };

  /** 把使用者選的模型排第一，其餘依序當備胎 */
  function modelQueue(provider, model) {
    var all = (provider.models || []).map(function (m) { return m.id; });
    var queue = model ? [model] : [];
    all.forEach(function (id) { if (queue.indexOf(id) === -1) queue.push(id); });
    return queue;
  }

  function sendOnce(provider, prompt, key, model) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller
      ? window.setTimeout(function () { controller.abort(); }, PER_MODEL_TIMEOUT) : null;
    return provider.send(prompt, key, model, controller ? controller.signal : undefined)
      .then(function (text) {
        if (timer) window.clearTimeout(timer);
        return text;
      }, function (error) {
        if (timer) window.clearTimeout(timer);
        throw error;
      });
  }

  function sendWithFallback(provider, prompt, key, queue, index, onSwitch) {
    index = index || 0;
    var model = queue[index];
    return sendOnce(provider, prompt, key, model).then(function (text) {
      return { text: text, model: model };
    }).catch(function (error) {
      var reason = classify(error);
      var next = index + 1;
      if (!RETRYABLE[reason] || next >= queue.length) throw error;
      logDetail(model + ' 不通（' + reason + '），立刻改用 ' + queue[next], error);
      if (onSwitch) onSwitch(queue[next]);
      return sendWithFallback(provider, prompt, key, queue, next, onSwitch);
    });
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

      var queue = modelQueue(provider, model);
      return sendWithFallback(provider, prompt, key, queue, 0, settings.onModelSwitch)
        .then(function (sent) {
          var text = sent.text;
          // 可能是備胎模型回的，記下真正用到的那一個
          model = sent.model;
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
          logDetail('問 AI 失敗', error);
          // 把供應商自己的說法附在後面：歸類得再好，也不如對方親口講的原因精準
          var detail = apiMessage(error);
          var text = PQPure.aiErrorText(classify(error));
          throw new Error(detail ? (text + '\n（對方回報：' + detail + '）') : text);
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
