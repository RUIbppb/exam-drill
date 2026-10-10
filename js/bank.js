/*
 * bank.js — 題庫載入層（製作人Rui / Maker Rui）
 *
 * 全 App 只有這支檔案會發網路請求。其他檔案要題目一律呼叫這裡的函式。
 *
 * 設計原則：
 *  - 題庫一科一個 JSON 檔，刷哪一科才載入哪一科，不會為了出一題就整包抓下來。
 *  - 路徑一律相對（./data/...），因為 GitHub Pages 會把網站放在網址的子路徑底下。
 *  - 科目檔的網址帶題庫版本號（?v=...），版本一變網址就變，才拿得到新題庫。
 *  - 每個請求都有逾時（通勤時最常遇到「有訊號但資料不通」，不能讓畫面無限等待）。
 *  - 錯誤訊息一律白話中文，瀏覽器的英文原文只寫進主控台，不給使用者看。
 *
 * 「離線可用」是怎麼做到的：
 *  首頁載入完索引之後，會在背景把每一科的題庫各抓一遍（warmOfflineCache），
 *  讓 service worker 把它們存進快取。這跟「按需載入」不衝突——
 *  練習時仍然是一次只解析一科，背景抓只是先把檔案存起來，沒有解析成題目物件。
 */

var PQBank = (function () {
  'use strict';

  var INDEX_URL = './data/index.json';
  var DATA_DIR = './data/';
  var DATA_CACHE_NAME = 'pq-data';   // 與 sw.js 的題庫快取同名，版本換了要清掉
  var CACHE_PREFIX = 'pq-';          // 這個 App 的快取都用這個開頭

  var REQUEST_TIMEOUT = 15000;       // 單一檔案的逾時（毫秒）
  var PING_TIMEOUT = 8000;           // 「連不連得上」的逾時

  var indexCache = null;             // 索引（index.json）載入後就留在記憶體
  var subjectCache = {};             // 已解析的科目：科目代號 → { questions, broken }

  /** 把瀏覽器的原始錯誤寫進主控台，給開發的人查，不給使用者看 */
  function logDetail(where, error) {
    if (window.console && console.warn) {
      console.warn('[題庫] ' + where, error);
    }
  }

  /**
   * 帶逾時的 fetch。時間到就中止請求，不然遇到「有訊號但資料不通」
   * 會一路等到瀏覽器自己放棄，畫面停在「載入中」超過一分鐘。
   */
  function fetchWithTimeout(url, options, timeoutMs) {
    var settings = options || {};
    var limit = timeoutMs || REQUEST_TIMEOUT;

    if (typeof AbortController !== 'function') {
      return fetch(url, settings);   // 很舊的瀏覽器沒有這個功能，就照原樣跑
    }

    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, limit);
    settings.signal = controller.signal;

    return fetch(url, settings).then(function (response) {
      window.clearTimeout(timer);
      return response;
    }, function (error) {
      window.clearTimeout(timer);
      throw error;
    });
  }

  /** 做一個帶白話訊息的錯誤，原始錯誤留在 detail 裡給主控台用 */
  function makeUserError(reason, label, detail) {
    var error = new Error(PQPure.loadErrorText(reason, label));
    error.reason = reason;
    error.detail = detail || null;
    return error;
  }

  /**
   * 抓一個 JSON 檔回來。
   * @param {string} url 網址
   * @param {string} label 這是什麼東西（用在錯誤訊息裡）
   * @returns {Promise<Object>}
   */
  function fetchJson(url, label) {
    if (window.location.protocol === 'file:') {
      return Promise.reject(makeUserError('file', label, null));
    }

    return fetchWithTimeout(url, { credentials: 'same-origin' }).then(function (response) {
      if (response.status === 404) {
        throw makeUserError('missing', label, '狀態碼 404');
      }
      if (!response.ok) {
        throw makeUserError('unknown', label, '狀態碼 ' + response.status);
      }
      return response.text();
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (e) {
        logDetail(label + ' 內容無法解析', e);
        throw makeUserError('broken', label, e.message);
      }
    }).catch(function (error) {
      if (error && error.reason) throw error;           // 已經是整理過的訊息
      logDetail(label + ' 載入失敗', error);
      throw makeUserError(PQPure.classifyLoadError(error), label, error && error.message);
    });
  }

  /** 某一科題庫的網址（帶版本號，版本一變就會重新下載） */
  function subjectUrl(index, code) {
    var info = (index && index.subjects && index.subjects[code]) || {};
    var fileName = info.file || (code + '.json');
    return DATA_DIR + fileName + '?v=' + encodeURIComponent((index && index.version) || '0');
  }

  /**
   * 題庫版本換了就清掉舊的題庫快取，免得手機一直吃舊題目。
   * 清快取失敗不影響刷題（科目檔網址已經帶版本號），所以只是盡力而為。
   */
  function dropOldDataCache(version) {
    var lastVersion = PQStore.loadBankVersion();
    if (lastVersion === String(version)) return Promise.resolve(false);

    var done = Promise.resolve(false);
    if (window.caches && typeof window.caches.delete === 'function') {
      done = window.caches.delete(DATA_CACHE_NAME).catch(function () { return false; });
    }
    return done.then(function (deleted) {
      PQStore.saveBankVersion(version);
      return deleted;
    });
  }

  /**
   * 載入索引（科目清單、每科題數與年度分布、題庫版本號）。
   * @returns {Promise<Object>}
   */
  function loadIndex() {
    if (indexCache) return Promise.resolve(indexCache);
    return fetchJson(INDEX_URL, '題庫索引').then(function (data) {
      if (!data || typeof data !== 'object' || !data.subjects || typeof data.subjects !== 'object' ||
          Object.keys(data.subjects).length === 0) {
        logDetail('題庫索引缺少科目清單', data);
        throw makeUserError('broken', '題庫索引', '缺少科目清單');
      }
      indexCache = data;
      return dropOldDataCache(data.version).then(function () { return indexCache; });
    });
  }

  /** 索引裡登記的科目清單，整理成畫面好用的陣列 */
  function listSubjects(index) {
    var subjects = index && index.subjects ? index.subjects : {};
    return Object.keys(subjects).map(function (code) {
      var item = subjects[code] || {};
      return {
        code: code,
        name: item.name || code,
        file: item.file || (code + '.json'),
        count: Number(item.count) || 0,
        years: Array.isArray(item.years) ? item.years.slice().sort(function (a, b) { return a - b; }) : [],
        targets: Array.isArray(item.targets) ? item.targets : []
      };
    });
  }

  /**
   * 載入某一科的題目。
   * 回傳時已經體檢過：questions 是可以刷的，broken 是資料異常被跳過的。
   * @param {string} code 科目代號
   * @returns {Promise<{code: string, name: string, questions: Array, broken: Array}>}
   */
  function loadSubject(code) {
    if (subjectCache[code]) return Promise.resolve(subjectCache[code]);

    return loadIndex().then(function (index) {
      var info = index.subjects[code];
      if (!info) {
        logDetail('索引裡沒有這一科：' + code, null);
        throw makeUserError('broken', '題庫索引', '找不到科目 ' + code);
      }
      var label = '「' + (info.name || code) + '」的題庫';

      return fetchJson(subjectUrl(index, code), label).then(function (data) {
        // 題庫檔本身是題目陣列；為了保險也接受 { questions: [...] } 這種包法
        var rawList = Array.isArray(data) ? data
          : (data && Array.isArray(data.questions) ? data.questions : null);
        if (!rawList || rawList.length === 0) {
          logDetail(label + ' 沒有題目或格式不符', data);
          throw makeUserError('broken', label, '沒有題目');
        }

        var report = PQPure.inspectBank(rawList);
        var result = {
          code: code,
          name: info.name || code,
          questions: report.usable,
          broken: report.broken
        };
        subjectCache[code] = result;
        return result;
      });
    });
  }

  /* ---------- 場次設定（模擬整卷用） ---------- */

  var examsCache = null;

  /** 場次設定的網址（帶版本號，才能跟題庫一起走離線快取） */
  function examsUrl(index) {
    return DATA_DIR + 'exams.json?v=' + encodeURIComponent((index && index.version) || '0');
  }

  /**
   * 載入場次設定。
   * 檔案最外層有兩個鍵：`說明`（給人看的）與 `場次`（實際資料），要照實際結構讀。
   */
  function loadExams() {
    if (examsCache) return Promise.resolve(examsCache);
    return loadIndex().then(function (index) {
      return fetchJson(examsUrl(index), '場次設定');
    }).then(function (data) {
      var sessions = data && data['場次'];
      if (!sessions || typeof sessions !== 'object') {
        logDetail('場次設定缺少「場次」區塊', data);
        throw makeUserError('broken', '場次設定', '缺少場次區塊');
      }
      examsCache = sessions;
      return sessions;
    });
  }

  /** 科目中文名 → 科目代號（用索引裡登記的名稱對照，不去拆題號） */
  function subjectCodeByName(index, name) {
    var subjects = (index && index.subjects) || {};
    var found = null;
    Object.keys(subjects).forEach(function (code) {
      if (!found && subjects[code] && subjects[code].name === name) found = code;
    });
    return found;
  }

  /**
   * 把場次攤平成「一份一份的試卷」給使用者挑。
   * 一份試卷 ＝ 某個場次的某一科（CONTEXT.md：試題是官方發布的一整份考卷，一個科目一份）。
   */
  function listPapers(exams, index) {
    var papers = [];
    Object.keys(exams || {}).forEach(function (examId) {
      var exam = exams[examId] || {};
      var official = isOfficialPaper(exam);
      (exam.subjects || []).forEach(function (subjectName) {
        var code = subjectCodeByName(index, subjectName);
        if (!code) return;                 // 索引裡沒有這一科的題目就不列
        papers.push({
          examId: examId,
          examName: exam.name || examId,
          target: exam.target || '',
          official: official,
          subjectCode: code,
          subjectName: subjectName,
          scoring: exam.scoring || 'moex-no-deduct',
          minutes: Number(exam.minutes) || 90
        });
      });
    });
    // 正式考卷排前面，再照場次由新到舊
    papers.sort(function (a, b) {
      if (a.official !== b.official) return a.official ? -1 : 1;
      if (a.examName === b.examName) return a.subjectName.localeCompare(b.subjectName);
      return b.examName.localeCompare(a.examName);
    });
    return papers;
  }

  /**
   * 這是不是這場考試的「正式考卷」。
   * 題庫為了補題量，收了考選部其他類科的卷子（例如司法四等的刑法概要），
   * 那些掛在同一個考試目標底下，但不是真的警佐班／刑事三等考卷。
   * 模擬整卷時要標出來，不然使用者會以為自己在寫真正的考古題。
   */
  function isOfficialPaper(exam) {
    var name = String((exam && exam.name) || '');
    var target = String((exam && exam.target) || '');
    if (target === '警佐班第3類') return name.indexOf('警佐班') !== -1;
    if (target === '刑事三等') return name.indexOf('刑事警察人員三等') !== -1;
    return true;
  }

  /**
   * 找出這一份試卷的逐科計分說明。
   * subjectQuestions 的鍵是科目代號，補充題源會接上官方科目代碼（例如 clawp0505），
   * 所以先找完全相同的，再找去掉尾巴數字後相同的，都沒有就用場次層的說明。
   */
  function findSubjectScoring(exam, subjectCode) {
    var table = (exam && exam.subjectQuestions) || {};
    if (table[subjectCode]) return table[subjectCode];

    var keys = Object.keys(table);
    var matched = keys.filter(function (key) {
      return key.replace(/[0-9]+$/, '') === subjectCode;
    });
    if (matched.length === 1) return table[matched[0]];
    if (keys.length === 1) return table[keys[0]];
    return { scoringNote: exam && exam.scoringNote };
  }

  /**
   * 載入一份模擬試卷：某場次某一科的全部題目。
   * 題目用 session 欄位比對（它跟場次的 name 是一模一樣的字串）。
   */
  function loadPaper(examId, subjectCode) {
    return Promise.all([loadExams(), loadIndex()]).then(function (both) {
      var exams = both[0];
      var index = both[1];
      var exam = exams[examId];
      if (!exam) {
        throw makeUserError('broken', '場次設定', '找不到場次 ' + examId);
      }
      return loadSubject(subjectCode).then(function (subject) {
        var questions = subject.questions.filter(function (question) {
          return question.session === exam.name;
        });
        if (questions.length === 0) {
          throw makeUserError('broken', '「' + subject.name + '」這一份試卷', '沒有題目');
        }
        // 照原卷順序：先單選再多選，各自照題號
        questions = questions.slice().sort(function (a, b) {
          if (a.type !== b.type) return a.type === 'single' ? -1 : 1;
          return String(a.id).localeCompare(String(b.id));
        });

        var scoringInfo = findSubjectScoring(exam, subjectCode);
        var note = (scoringInfo && scoringInfo.scoringNote) || exam.scoringNote || '';
        var singleCount = questions.filter(function (q) { return q.type === 'single'; }).length;
        var multiCount = questions.length - singleCount;

        return {
          examId: examId,
          examName: exam.name,
          target: exam.target || '',
          official: isOfficialPaper(exam),
          subjectCode: subjectCode,
          subjectName: subject.name,
          scoring: exam.scoring || 'moex-no-deduct',
          minutes: Number(exam.minutes) || 90,
          scoringNote: note,
          singleCount: singleCount,
          multiCount: multiCount,
          // 配分：警佐班固定 2／3 分，刑事三等依該科試卷封面（憲英每題 1.25 分）
          pointsPerSingle: exam.scoring === 'cpu-deduct'
            ? 2 : (PQPure.parsePointsPerQuestion(note) || 2),
          pointsPerMulti: 3,
          sectionFullScore: PQPure.parseSectionFullScore(note),
          questions: questions
        };
      });
    });
  }

  /* ---------- 申論題 ---------- */

  var essayCache = {};

  /*
   * 申論題庫還在製作中（另一位師傅負責）。
   * 正式檔案會是 essay-<科目代號>.json，索引裡會有一個區塊說明哪些科目有申論題。
   * 在那之前先用這份**示範資料**把畫面做出來，每一題都標明「示範」，
   * 絕對不會讓使用者誤以為是真的考古題。
   */
  var DEMO_ESSAYS = {
    invjur: {
      name: '偵查法學（示範）',
      demo: true,
      years: [113, 114],
      questions: [
        {
          id: 'demo-invjur-114-1', type: 'essay', no: 1, points: 25, year: 114,
          subject: '偵查法學', originalSubject: '偵查法學', session: '114 年刑事警察人員三等（示範資料）',
          demo: true,
          stem: '【這是示範題目，不是真的考古題】\n\n' +
            '警察於執行巡邏勤務時，發現甲行跡可疑而對其進行盤查，甲拒絕出示身分證件並轉身快步離去。\n\n' +
            '（一）警察得否強制甲留置？依據為何？（15 分）\n' +
            '（二）若警察於過程中搜索甲之背包並查獲毒品，該證據是否具有證據能力？（10 分）'
        },
        {
          id: 'demo-invjur-113-1', type: 'essay', no: 1, points: 25, year: 113,
          subject: '偵查法學', originalSubject: '偵查法學', session: '113 年刑事警察人員三等（示範資料）',
          demo: true,
          stem: '【這是示範題目，不是真的考古題】\n\n' +
            '試說明偵查不公開原則之法源依據、例外情形，並舉例說明實務上常見之違反態樣。（25 分）'
        }
      ]
    }
  };

  /** 索引裡有沒有登記申論題。格式以建置器寫進 docs/題庫格式.md 的為準，這裡盡量寬鬆地接 */
  function readEssayIndex(index) {
    if (!index || typeof index !== 'object') return null;
    var block = index.essays || index.essaySubjects || index['申論'] || index['申論題'];
    if (!block || typeof block !== 'object') return null;
    var source = block.subjects && typeof block.subjects === 'object' ? block.subjects : block;
    var codes = Object.keys(source);
    if (codes.length === 0) return null;

    var list = {};
    codes.forEach(function (code) {
      var item = source[code] || {};
      list[code] = {
        name: item.name || code,
        file: item.file || ('essay-' + code + '.json'),
        count: Number(item.count) || 0,
        years: Array.isArray(item.years) ? item.years.slice() : [],
        demo: false
      };
    });
    return list;
  }

  /**
   * 有哪些科目有申論題。
   * @returns {Promise<{subjects: Object, demo: boolean}>} demo 為真代表現在看到的是示範資料
   */
  function loadEssaySubjects() {
    return loadIndex().then(function (index) {
      var real = readEssayIndex(index);
      if (real) return { subjects: real, demo: false };
      var demo = {};
      Object.keys(DEMO_ESSAYS).forEach(function (code) {
        demo[code] = {
          name: DEMO_ESSAYS[code].name,
          file: null,
          count: DEMO_ESSAYS[code].questions.length,
          years: DEMO_ESSAYS[code].years,
          demo: true
        };
      });
      return { subjects: demo, demo: true };
    });
  }

  /** 載入某一科的申論題 */
  function loadEssayQuestions(code) {
    if (essayCache[code]) return Promise.resolve(essayCache[code]);

    return loadEssaySubjects().then(function (info) {
      var subject = info.subjects[code];
      if (!subject) {
        throw makeUserError('broken', '申論題庫', '找不到科目 ' + code);
      }
      if (subject.demo) {
        var demoSet = DEMO_ESSAYS[code];
        var demoResult = {
          code: code, name: subject.name, demo: true,
          questions: demoSet ? demoSet.questions.slice() : []
        };
        essayCache[code] = demoResult;
        return demoResult;
      }

      return loadIndex().then(function (index) {
        var url = DATA_DIR + subject.file + '?v=' + encodeURIComponent(index.version || '0');
        return fetchJson(url, '「' + subject.name + '」的申論題庫').then(function (data) {
          var list = Array.isArray(data) ? data
            : (data && Array.isArray(data.questions) ? data.questions : []);
          var result = { code: code, name: subject.name, demo: false, questions: list };
          essayCache[code] = result;
          return result;
        });
      });
    });
  }

  /* ---------- 法條速查 ---------- */

  var LAW_DIR = './data/laws/';
  var lawIndexCache = null;
  var lawCache = {};

  /**
   * 載入法規清單。
   * 格式見 docs/題庫格式.md：最外層有「說明」「資料來源」「版本」「法規」四個鍵。
   * 法規資料是另外建置的，版本號也獨立，所以不跟題庫共用版本。
   */
  function loadLawIndex() {
    if (lawIndexCache) return Promise.resolve(lawIndexCache);
    return fetchJson(LAW_DIR + 'index.json', '法規清單').then(function (data) {
      var table = data && (data['法規'] || data.laws);
      if (!table || typeof table !== 'object' || Object.keys(table).length === 0) {
        logDetail('法規清單缺少「法規」區塊', data);
        throw makeUserError('broken', '法規清單', '缺少法規區塊');
      }
      lawIndexCache = data;
      return lawIndexCache;
    });
  }

  /** 某一部法規的網址（帶版本號，版本一變才重抓） */
  function lawUrl(lawIndex, entry) {
    var version = (lawIndex && (lawIndex['版本'] || lawIndex.version)) || '0';
    return LAW_DIR + entry.file + '?v=' + encodeURIComponent(version);
  }

  /** 法規清單整理成陣列（含資料來源資訊，畫面要標示出處） */
  function lawCatalog() {
    return loadLawIndex().then(function (index) {
      return {
        laws: PQPure.listLaws(index),
        source: index['資料來源'] || index.source || '全國法規資料庫（法務部）',
        officialUpdatedAt: index['官方更新日期'] || index.officialUpdatedAt || '',
        categoryOrder: index['分類順序'] || index.categoryOrder || null,
        note: index['說明'] || index.note || '',
        version: index['版本'] || index.version || ''
      };
    });
  }

  /** 載入一部法規的全部條文 */
  function loadLaw(code) {
    if (lawCache[code]) return Promise.resolve(lawCache[code]);
    return loadLawIndex().then(function (index) {
      var entry = PQPure.listLaws(index).filter(function (law) { return law.code === code; })[0];
      if (!entry) {
        throw makeUserError('broken', '法規清單', '找不到法規 ' + code);
      }
      return fetchJson(lawUrl(index, entry), '「' + entry.name + '」的條文').then(function (data) {
        var articles = (data && Array.isArray(data.articles)) ? data.articles : [];
        if (articles.length === 0) {
          throw makeUserError('broken', '「' + entry.name + '」的條文', '沒有條文');
        }
        var result = {
          code: code,
          name: data.name || entry.name,
          category: entry.category,
          modified: data.modified || entry.modified || '',
          abandoned: data.abandoned === true,
          url: data.url || entry.url || '',
          recentAmendments: Array.isArray(data.recentAmendments) ? data.recentAmendments : [],
          articles: articles
        };
        lawCache[code] = result;
        return result;
      });
    });
  }

  /* ---------- 離線準備 ---------- */

  /** 等 service worker 接管這個頁面（第一次開啟時要等它裝好才接管） */
  function whenControlled(timeoutMs) {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    if (navigator.serviceWorker.controller) return Promise.resolve(true);

    return new Promise(function (resolve) {
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        resolve(!!navigator.serviceWorker.controller);
      };
      navigator.serviceWorker.addEventListener('controllerchange', finish);
      window.setTimeout(finish, timeoutMs || 20000);
    });
  }

  /** 查某一科的題庫（或指定網址的檔案）在不在離線快取裡 */
  function isCached(index, code, url) {
    if (!window.caches || typeof window.caches.open !== 'function') return Promise.resolve(false);
    var target = url || subjectUrl(index, code);
    return window.caches.open(DATA_CACHE_NAME).then(function (cache) {
      return cache.match(target);
    }).then(function (hit) {
      return !!hit;
    }).catch(function () {
      return false;
    });
  }

  /**
   * 目前有幾科可以離線用。
   * @returns {Promise<{ready: number, total: number, supported: boolean}>}
   */
  function offlineStatus() {
    return loadIndex().then(function (index) {
      var codes = Object.keys(index.subjects);
      if (!window.caches || !('serviceWorker' in navigator)) {
        return { ready: 0, total: codes.length, lawsReady: 0, lawsTotal: 0, supported: false };
      }

      // 法規清單讀不到也不要讓整個狀態壞掉（法規資料是另外建置的，可能還沒上線）
      var lawPart = loadLawIndex().then(function (lawIndex) {
        var entries = PQPure.listLaws(lawIndex);
        return Promise.all(entries.map(function (entry) {
          return isCached(null, null, lawUrl(lawIndex, entry));
        })).then(function (flags) {
          return { ready: flags.filter(Boolean).length, total: entries.length };
        });
      }).catch(function () { return { ready: 0, total: 0 }; });

      var subjectPart = Promise.all(codes.map(function (code) { return isCached(index, code); }))
        .then(function (flags) { return flags.filter(Boolean).length; });

      return Promise.all([subjectPart, lawPart]).then(function (both) {
        return {
          ready: both[0],
          total: codes.length,
          lawsReady: both[1].ready,
          lawsTotal: both[1].total,
          supported: true
        };
      });
    });
  }

  /**
   * 背景把每一科的題庫各抓一遍，讓 service worker 存進快取，之後沒網路也能刷。
   * 一次抓一科、照順序來，不要一口氣塞爆手機的網路。
   * @param {Function} onProgress 每抓完一科回報一次 { ready, total }
   * @returns {Promise<{ready: number, total: number, supported: boolean}>}
   */
  function warmOfflineCache(onProgress) {
    return loadIndex().then(function (index) {
      var codes = Object.keys(index.subjects);

      return whenControlled().then(function (controlled) {
        if (!controlled) {
          // service worker 沒接管（例如用 file 方式開、或瀏覽器不支援），離線功能本來就沒有
          return { ready: 0, total: codes.length, supported: false };
        }

        var ready = 0;
        // 場次設定也要存：少了它，離線時「模擬整卷」會打不開
        var chain = isCached(index, null, examsUrl(index)).then(function (cached) {
          if (cached) return null;
          return fetchWithTimeout(examsUrl(index), { credentials: 'same-origin' })
            .catch(function (error) {
              logDetail('背景存取場次設定失敗', error);
              return null;
            });
        });

        codes.forEach(function (code) {
          chain = chain.then(function () {
            return isCached(index, code).then(function (cached) {
              if (cached) return true;
              // 這裡只是把檔案抓回來讓 service worker 存著，不解析成題目
              return fetchWithTimeout(subjectUrl(index, code), { credentials: 'same-origin' })
                .then(function (response) { return response && response.ok; })
                .catch(function (error) {
                  logDetail('背景存取「' + code + '」失敗', error);
                  return false;
                });
            }).then(function (ok) {
              if (ok) ready += 1;
              if (typeof onProgress === 'function') {
                onProgress({ ready: ready, total: codes.length, supported: true });
              }
            });
          });
        });

        // 題庫存完之後，接著把法規一部一部存起來（41 部，不要一次全抓）
        return chain.then(function () {
          return warmLaws(function (lawProgress) {
            if (typeof onProgress === 'function') {
              onProgress({
                ready: ready, total: codes.length, supported: true,
                lawsReady: lawProgress.ready, lawsTotal: lawProgress.total
              });
            }
          });
        }).then(function (lawResult) {
          return {
            ready: ready, total: codes.length, supported: true,
            lawsReady: lawResult.ready, lawsTotal: lawResult.total
          };
        });
      });
    });
  }

  /**
   * 把法規一部一部存進離線快取。
   * 法規資料還沒上線時（檔案不存在）就安靜跳過，不要讓首頁一直顯示錯誤。
   */
  function warmLaws(onProgress) {
    return loadLawIndex().then(function (lawIndex) {
      var entries = PQPure.listLaws(lawIndex);
      var ready = 0;
      var chain = Promise.resolve();

      entries.forEach(function (entry) {
        chain = chain.then(function () {
          var url = lawUrl(lawIndex, entry);
          return isCached(null, null, url).then(function (cached) {
            if (cached) return true;
            return fetchWithTimeout(url, { credentials: 'same-origin' })
              .then(function (response) { return response && response.ok; })
              .catch(function (error) {
                logDetail('背景存取法規「' + entry.name + '」失敗', error);
                return false;
              });
          }).then(function (ok) {
            if (ok) ready += 1;
            if (typeof onProgress === 'function') {
              onProgress({ ready: ready, total: entries.length });
            }
          });
        });
      });

      return chain.then(function () {
        return { ready: ready, total: entries.length };
      });
    }).catch(function () {
      return { ready: 0, total: 0 };     // 法規資料還沒產出，不算錯
    });
  }

  /* ---------- 更新 ---------- */

  /**
   * 確認現在真的連得上網路。
   * 不能只看 navigator.onLine——「有訊號但資料不通」的時候它還是回 true，
   * 先清快取再發現連不上，離線版就被自己弄壞了。
   * @returns {Promise<boolean>}
   */
  function checkOnline() {
    if (navigator.onLine === false) return Promise.resolve(false);

    // 網址帶 pq-ping，service worker 看到就放行不插手（見 sw.js 的說明），
    // 這樣失敗才真的代表連不上網路，而不是拿到自己存的快取。
    var url = './index.html?pq-ping=' + Date.now();
    return fetchWithTimeout(url, { cache: 'no-store', credentials: 'same-origin' }, PING_TIMEOUT)
      .then(function (response) { return !!(response && response.ok); })
      .catch(function (error) {
        logDetail('連線測試失敗（判定為連不上）', error);
        return false;
      });
  }

  /** 清掉這個 App 的所有快取（更新時用）。不會動到使用者的進度 */
  function clearAppCaches() {
    if (!window.caches || typeof window.caches.keys !== 'function') return Promise.resolve(0);
    return window.caches.keys().then(function (names) {
      var mine = names.filter(function (name) { return name.indexOf(CACHE_PREFIX) === 0; });
      return Promise.all(mine.map(function (name) { return window.caches.delete(name); }))
        .then(function () { return mine.length; });
    }).catch(function (error) {
      logDetail('清快取失敗', error);
      return 0;
    });
  }

  /** 清掉記憶體裡的題庫（按「檢查更新」時用） */
  function forget() {
    indexCache = null;
    subjectCache = {};
    examsCache = null;
    essayCache = {};
    lawIndexCache = null;
    lawCache = {};
  }

  return {
    DATA_CACHE_NAME: DATA_CACHE_NAME,
    REQUEST_TIMEOUT: REQUEST_TIMEOUT,
    loadIndex: loadIndex,
    listSubjects: listSubjects,
    loadSubject: loadSubject,
    loadExams: loadExams,
    listPapers: listPapers,
    loadPaper: loadPaper,
    loadEssaySubjects: loadEssaySubjects,
    loadEssayQuestions: loadEssayQuestions,
    loadLawIndex: loadLawIndex,
    lawCatalog: lawCatalog,
    loadLaw: loadLaw,
    offlineStatus: offlineStatus,
    warmOfflineCache: warmOfflineCache,
    checkOnline: checkOnline,
    clearAppCaches: clearAppCaches,
    forget: forget
  };
}());
