/*
 * storage.js — 進度存取層（製作人Rui / Maker Rui）
 *
 * 進度只存在這台裝置的瀏覽器裡，沒有後端、沒有帳號、沒有自動同步（見 docs/adr/0002）。
 * 瀏覽器可能停用儲存功能（無痕模式）或空間已滿，所以每一次讀寫都包 try/catch，
 * 失敗時回傳看得懂的中文訊息給畫面顯示，絕對不讓 App 當掉或畫面空白。
 *
 * 全 App 只有這支檔案會碰 localStorage，其他檔案要存取進度一律呼叫這裡的函式。
 */

var PQStore = (function () {
  'use strict';

  // localStorage 的鍵名，統一集中管理。
  // 【注意】改動這些字串會讓已經累積的進度讀不到，不可隨意更名。
  var KEY = {
    progress: 'policeQuiz.progress.v1',    // 刷題進度
    bankVersion: 'policeQuiz.bankVersion', // 上次看到的題庫版本號
    aiKey: 'policeQuiz.aiKey.v1',          // AI 金鑰（單獨存，見下方說明）
    probe: 'policeQuiz.probe'              // 只用來測試能不能寫入
  };

  /*
   * 【AI 金鑰為什麼要單獨存】
   * 它存在跟進度完全不同的一個鍵底下，而且匯出進度時是逐欄位挑出來寫檔的，
   * 不會把金鑰帶出去。這樣使用者把進度檔丟到雲端硬碟、傳到另一台裝置，
   * 都不會連金鑰一起外流。程式碼裡一個字的金鑰都沒有，一律由使用者自己貼。
   */

  /**
   * 把各種儲存失敗的原因翻成白話。
   * 瀏覽器原本丟的是「Unexpected token」這種英文，使用者看不懂，
   * 所以原文只寫進主控台，畫面上一律顯示中文（對照表在 core.js）。
   */
  function explainError(error) {
    if (window.console && console.warn) {
      console.warn('[進度] 存取失敗', error);
    }
    return PQPure.storageErrorText(error);
  }

  /** 台北時間的存檔時間戳記（專案規範一律用台北時間，不用 UTC） */
  function nowStamp() {
    return PQPure.toTaipeiStampString(new Date(), true);
  }

  /** 取得可用的 localStorage，取不到就回 null（不往外丟錯） */
  function getStore() {
    try {
      var store = window.localStorage;
      if (!store) return null;
      // 真的寫一次才知道能不能用：有些瀏覽器物件存在、但一寫就被擋
      store.setItem(KEY.probe, '1');
      store.removeItem(KEY.probe);
      return store;
    } catch (e) {
      return null;
    }
  }

  /** 這台裝置的瀏覽器能不能存進度 */
  function isAvailable() {
    return getStore() !== null;
  }

  /**
   * 空白進度。
   * notes／staleFlags／drafts／examDates 這一版用不到，先把欄位留著，
   * 之後做錯題本、筆記、申論草稿時不用改結構，舊進度才不會對不上。
   */
  /*
   * 預設設定。使用者在設定頁改過的值會蓋掉這裡，
   * 新增欄位時舊進度會自動補上預設值（見 normalizeProgress），不會因此讀不到。
   */
  function defaultSettings() {
    return {
      examDates: {
        '警佐班第3類': '2027-03-15',   // 116 年 3 月中央警察大學警佐班第 3 類
        '刑事三等': '2027-06-15'       // 116 年 6 月警察人員考試三等刑事警察人員
      },
      streakThreshold: 3,   // 連續答對幾次就從錯題本放出去
      dailyLimit: 60,       // 每天最多出幾題到期題
      yearSpan: 5,          // 預設年度範圍：近幾年
      aiProvider: 'anthropic',
      aiModel: 'claude-sonnet-4-5'
    };
  }

  function makeEmptyProgress() {
    return {
      version: 2,
      createdAt: null,  // 第一次存檔的時間（台北時間 YYYY-MM-DD HH:MM:SS）
      updatedAt: null,  // 最後一次存檔的時間（台北時間）
      questions: {},    // 每題的作答紀錄，鍵是題目編號
      notes: {},        // 筆記（預留給第三版）
      staleFlags: {},   // 使用者自己標「這題已過時」
      drafts: {},       // 申論作答草稿
      exams: [],        // 模擬整卷紀錄（只留最近 20 次）
      backup: {},       // 備份狀態（lastExportAt）
      settings: defaultSettings()
    };
  }

  /** 把讀出來的資料補成完整結構：缺的補上、多的保留（保留未來版本的欄位） */
  function normalizeProgress(raw) {
    var base = makeEmptyProgress();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

    var merged = {};
    Object.keys(raw).forEach(function (key) { merged[key] = raw[key]; });

    Object.keys(base).forEach(function (key) {
      var expected = base[key];
      var value = merged[key];
      if (Array.isArray(expected)) {
        if (!Array.isArray(value)) merged[key] = [];
      } else if (expected !== null && typeof expected === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) merged[key] = {};
      } else if (value === undefined) {
        merged[key] = expected;
      }
    });

    // 設定補預設值：舊版進度沒有的欄位（例如考試日期）自動長出來，不會讀不到
    var defaults = defaultSettings();
    Object.keys(defaults).forEach(function (key) {
      if (merged.settings[key] === undefined || merged.settings[key] === null) {
        merged.settings[key] = defaults[key];
      }
    });
    if (!merged.settings.examDates || typeof merged.settings.examDates !== 'object') {
      merged.settings.examDates = defaults.examDates;
    } else {
      Object.keys(defaults.examDates).forEach(function (name) {
        if (!merged.settings.examDates[name]) merged.settings.examDates[name] = defaults.examDates[name];
      });
    }

    // 模擬紀錄只留最近 20 次，避免無上限長大把空間吃光
    if (merged.exams.length > 20) merged.exams = merged.exams.slice(0, 20);

    merged.version = Number(merged.version) || 1;
    return merged;
  }

  /**
   * 讀進度
   * @returns {{progress: Object, error: (string|null)}}
   */
  function loadProgress() {
    var store = getStore();
    if (!store) {
      return {
        progress: makeEmptyProgress(),
        error: '這個瀏覽器不能儲存資料（可能是無痕模式），這次刷題的進度不會被記住。'
      };
    }
    try {
      var text = store.getItem(KEY.progress);
      if (!text) return { progress: makeEmptyProgress(), error: null };
      return { progress: normalizeProgress(JSON.parse(text)), error: null };
    } catch (e) {
      // 進度就這一份，壞了也不要直接砍掉：另存一份壞檔備份，再從空白開始記
      try {
        var broken = store.getItem(KEY.progress);
        if (broken) store.setItem(KEY.progress + '.broken', broken);
      } catch (ignored) { /* 連備份都失敗就算了，不要再往外丟錯 */ }
      return {
        progress: makeEmptyProgress(),
        error: '進度資料讀不出來（' + explainError(e) + '），已另存一份壞檔備份，重新開始記錄。'
      };
    }
  }

  /**
   * 存進度
   * @returns {{ok: boolean, error: (string|null)}}
   */
  function saveProgress(progress) {
    var store = getStore();
    if (!store) {
      return { ok: false, error: '這個瀏覽器不能儲存資料，剛才的作答沒有存起來。' };
    }
    try {
      var data = normalizeProgress(progress);
      var stamp = nowStamp();
      if (!data.createdAt) data.createdAt = stamp;
      data.updatedAt = stamp;
      store.setItem(KEY.progress, JSON.stringify(data));
      return { ok: true, error: null };
    } catch (e) {
      return {
        ok: false,
        error: '進度存不進去（' + explainError(e) + '），剛才的作答沒有被記住。'
      };
    }
  }

  /** 讀上次記住的題庫版本號（用來判斷要不要清掉舊的題庫快取） */
  function loadBankVersion() {
    var store = getStore();
    if (!store) return null;
    try {
      return store.getItem(KEY.bankVersion);
    } catch (e) {
      return null;
    }
  }

  /** 記住目前的題庫版本號。存不進去不影響刷題，安靜失敗即可 */
  function saveBankVersion(version) {
    var store = getStore();
    if (!store) return false;
    try {
      store.setItem(KEY.bankVersion, String(version === null || version === undefined ? '' : version));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- 匯出 ---------- */

  /**
   * 整理出要寫進匯出檔的內容。
   * 逐欄位挑出來寫，**金鑰與任何未來新增的敏感欄位都不會被順手帶出去**。
   */
  function buildExportData(progress, todayISO) {
    var data = normalizeProgress(progress);
    return {
      app: '警察考試刷題',
      maker: '製作人Rui',
      version: data.version,
      exportedAt: nowStamp(),
      exportedDate: todayISO || null,
      questions: data.questions,
      notes: data.notes,
      staleFlags: data.staleFlags,
      drafts: data.drafts,
      exams: data.exams,
      settings: data.settings
    };
  }

  /* ---------- AI 金鑰（單獨存，不進匯出檔） ---------- */

  function loadAiKey() {
    var store = getStore();
    if (!store) return '';
    try {
      return store.getItem(KEY.aiKey) || '';
    } catch (e) {
      return '';
    }
  }

  function saveAiKey(key) {
    var store = getStore();
    if (!store) return { ok: false, error: '這個瀏覽器不能儲存資料，金鑰沒有存起來。' };
    try {
      store.setItem(KEY.aiKey, String(key || ''));
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: '金鑰存不進去（' + explainError(e) + '）。' };
    }
  }

  function clearAiKey() {
    var store = getStore();
    if (!store) return false;
    try {
      store.removeItem(KEY.aiKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  function hasAiKey() {
    return loadAiKey().length > 0;
  }

  return {
    KEY: KEY,
    isAvailable: isAvailable,
    defaultSettings: defaultSettings,
    makeEmptyProgress: makeEmptyProgress,
    normalizeProgress: normalizeProgress,
    loadProgress: loadProgress,
    saveProgress: saveProgress,
    loadBankVersion: loadBankVersion,
    saveBankVersion: saveBankVersion,
    buildExportData: buildExportData,
    loadAiKey: loadAiKey,
    saveAiKey: saveAiKey,
    clearAiKey: clearAiKey,
    hasAiKey: hasAiKey
  };
}());
