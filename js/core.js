/*
 * core.js — 刷題純算式模組（製作人Rui / Maker Rui）
 *
 * 這支檔案只放「不碰畫面、只做判斷與計算」的函式，
 * 同一份程式碼同時給 index.html（實際刷題）與 self-test.html（自我檢查頁）使用。
 * 需要 DOM、localStorage、fetch 的東西請放 storage.js / bank.js / app.js。
 *
 * 【鐵律】
 *  1. 這裡面絕對不可以出現 document、window、fetch、localStorage 這些瀏覽器專屬的東西。
 *  2. 也不可以出現 new Date()。「今天是哪一天」一律由外面傳進來，
 *     否則測試結果會隨執行當天的日期跑掉，測了等於沒測。
 *  3. 任何參數傳 null / undefined 進來都不可以讓程式爆掉。
 *
 * 名詞對照（畫面用字依 CONTEXT.md，程式碼變數用對應英文）
 *   題目 question      題幹 stem          選項 options       正解 answers
 *   答案組 answerGroup  雙正解 多個答案組   送分題 allCorrect
 *   現行科目 subject    原始科目 originalSubject   場次 session
 *   進度 progress       盒號 box           到期日 dueAt（本版只保留欄位，不做間隔重複）
 */

var PQPure = (function () {
  'use strict';

  /** 選項字母的全部可能範圍：單選題用 A～D，多選題用 A～E。 */
  var ALL_LETTERS = ['A', 'B', 'C', 'D', 'E'];

  /** 各題型應有的選項數（依 docs/題庫格式.md 的硬性檢核第 3 條）。 */
  var OPTION_COUNT = { single: 4, multi: 5 };

  /** 題型的中文顯示名稱 */
  function typeLabel(type) {
    if (type === 'single') return '單選題';
    if (type === 'multi') return '多選題';
    return '題型不明';
  }

  /** 年度顯示用字，例如 115 → 「115 年」 */
  function yearLabel(year) {
    var value = Number(year);
    return isFinite(value) && value > 0 ? value + ' 年' : '年度不明';
  }

  // ============================================================
  // 正解的整理與題目體檢
  // ============================================================

  /**
   * 把一組正解字母整理乾淨（去空白、轉大寫、排序），並回報發現的瑕疵。
   * @param {Array} rawGroup 題庫裡的一組正解，例如 ["A","C","D"]
   * @param {Array} validLetters 這一題實際有的選項字母
   * @returns {{letters: Array, hadDuplicate: boolean, hadUnknown: boolean}}
   */
  function normalizeGroup(rawGroup, validLetters) {
    var allowed = Array.isArray(validLetters) && validLetters.length ? validLetters : ALL_LETTERS;
    var letters = [];
    var hadDuplicate = false;
    var hadUnknown = false;

    if (!Array.isArray(rawGroup)) {
      return { letters: [], hadDuplicate: false, hadUnknown: true };
    }

    rawGroup.forEach(function (item) {
      // 只接受單一個合法選項字母；中文、符號、空白一律視為題庫瑕疵
      var letter = String(item === null || item === undefined ? '' : item).trim().toUpperCase();
      if (letter.length !== 1 || allowed.indexOf(letter) === -1) {
        hadUnknown = true;
        return;
      }
      if (letters.indexOf(letter) !== -1) {
        hadDuplicate = true;
        return;
      }
      letters.push(letter);
    });

    letters.sort();
    return { letters: letters, hadDuplicate: hadDuplicate, hadUnknown: hadUnknown };
  }

  /**
   * 體檢一道題目，判斷它能不能拿出來刷。
   * 擋下來的都是「拿出來刷只會害人背錯」的情形，不是故意挑剔。
   * @param {Object} question 一道題目
   * @returns {{ok: boolean, problems: Array, groups: Array, validLetters: Array}}
   */
  function inspectQuestion(question) {
    var problems = [];

    if (!question || typeof question !== 'object') {
      return { ok: false, problems: ['題目資料不是一筆完整的紀錄'], groups: [], validLetters: [] };
    }
    if (!question.id) problems.push('缺少題目編號');
    if (!question.stem || !String(question.stem).trim()) problems.push('缺少題幹');
    if (question.type !== 'single' && question.type !== 'multi') problems.push('題型不是單選也不是多選');

    var options = question.options && typeof question.options === 'object' ? question.options : {};
    var validLetters = ALL_LETTERS.filter(function (letter) {
      return Object.prototype.hasOwnProperty.call(options, letter) &&
        String(options[letter] === null || options[letter] === undefined ? '' : options[letter]).trim() !== '';
    });

    if (validLetters.length === 0) {
      problems.push('沒有任何選項');
    } else if (OPTION_COUNT[question.type] && validLetters.length !== OPTION_COUNT[question.type]) {
      problems.push(typeLabel(question.type) + '應該有 ' + OPTION_COUNT[question.type] +
        ' 個選項，實際只有 ' + validLetters.length + ' 個');
    }

    // 送分題：官方公告一律給分，沒有正解也算正常
    var groups = [];
    if (question.allCorrect !== true) {
      var rawGroups = Array.isArray(question.answers) ? question.answers : [];
      if (rawGroups.length === 0) {
        problems.push('沒有正解，也沒有標明一律給分');
      }
      rawGroups.forEach(function (rawGroup, index) {
        var tidy = normalizeGroup(rawGroup, validLetters);
        var where = '第 ' + (index + 1) + ' 組正解';
        if (tidy.hadUnknown) problems.push(where + '含有不是選項字母的內容');
        if (tidy.hadDuplicate) problems.push(where + '有重複的字母');
        if (tidy.letters.length === 0) {
          problems.push(where + '整理後是空的');
          return;
        }
        groups.push(tidy.letters);
      });
      if (rawGroups.length > 0 && groups.length === 0) {
        problems.push('整理後沒有任何可用的正解');
      }

      /*
       * 單選題的正解組裡出現兩個以上的字母，【不是】錯誤資料。
       * 考選部的更正檔常有「第 2 題答Ａ或Ｃ或ＡＣ者均給分」這種公告，
       * 建置器會老實記成 [["A"],["C"],["A","C"]]，三組都是官方認定的給分答案。
       * 真正不能用的是另一種：整題沒有任何一組只有一個字母——
       * 單選題一次只能點一個選項，那種題目怎麼點都不會對，拿出來刷只會害人。
       */
      if (question.type === 'single' && groups.length > 0) {
        var hasSingleLetterGroup = groups.some(function (group) { return group.length === 1; });
        if (!hasSingleLetterGroup) {
          problems.push('這是單選題，但沒有任何一組正解只有一個答案，單選的情況下永遠答不對');
        }
      }
    }

    return {
      ok: problems.length === 0,
      problems: problems,
      groups: groups,
      validLetters: validLetters
    };
  }

  /**
   * 體檢一整科題庫，分成「可以刷的」與「資料異常的」兩堆。
   * 異常題不悄悄丟掉，數量會回報到畫面上，讓使用者知道有幾題被跳過。
   * @param {Array} questions 一科的題目清單
   * @returns {{usable: Array, broken: Array}}
   */
  function inspectBank(questions) {
    var usable = [];
    var broken = [];
    (Array.isArray(questions) ? questions : []).forEach(function (question, index) {
      var report = inspectQuestion(question);
      if (report.ok) {
        usable.push(question);
      } else {
        broken.push({
          id: (question && question.id) || '（第 ' + (index + 1) + ' 筆，沒有題目編號）',
          problems: report.problems
        });
      }
    });
    return { usable: usable, broken: broken };
  }

  // ============================================================
  // 判題（整個 App 最關鍵的一段）
  // ============================================================

  /** 兩組字母是否完全相同（兩邊都已排序去重） */
  function sameLetters(groupA, groupB) {
    if (groupA.length !== groupB.length) return false;
    for (var i = 0; i < groupA.length; i += 1) {
      if (groupA[i] !== groupB[i]) return false;
    }
    return true;
  }

  /**
   * 判斷作答對錯。規則：
   *   1. 題目標 allCorrect（官方公告一律給分）→ 直接算答對。
   *   2. 正解是「組的清單」，任一組完全命中就算答對（雙正解就是這樣來的）。
   *   3. 多選題必須全部選對才算答對，少選、多選都算錯。
   * @param {Object} question 一道題目
   * @param {Array} selected 使用者選的字母，例如 ["A","C"]
   * @returns {Object} 判定結果
   */
  function judge(question, selected) {
    var report = inspectQuestion(question);
    var picked = normalizeGroup(selected, report.validLetters).letters;

    var result = {
      correct: false,        // 是否答對
      allCorrect: false,     // 是否為官方送分題
      undecidable: false,    // 正解資料壞掉、無法判定
      picked: picked,        // 整理後使用者選的字母
      groups: report.groups, // 這題的全部正解組
      matchedGroup: null,    // 命中的那一組
      bestGroup: null,       // 對得最多的那一組（給多選題部分對錯用，未來間隔重複會用到）
      hitCount: 0,           // 對到幾個選項
      missCount: 0,          // 漏掉幾個選項
      wrongPickCount: 0,     // 多選了幾個不該選的
      note: ''               // 要顯示給使用者的補充說明
    };

    // 情形一：官方公告一律給分
    if (question && question.allCorrect === true) {
      result.correct = true;
      result.allCorrect = true;
      result.note = '本題官方公告一律給分';
      return result;
    }

    // 情形二：正解資料壞掉，無法判定（這種題目不會進練習池，這裡只是保險）
    if (report.groups.length === 0) {
      result.undecidable = true;
      result.note = '這題的正解資料有問題，沒辦法判定對錯';
      return result;
    }

    // 情形三：正常判定，任一組完全命中就算答對
    var bestGroup = report.groups[0];
    var bestHit = -1;
    report.groups.forEach(function (group) {
      var hit = group.filter(function (letter) { return picked.indexOf(letter) !== -1; }).length;
      if (hit > bestHit) {
        bestHit = hit;
        bestGroup = group;
      }
      if (sameLetters(group, picked)) {
        result.correct = true;
        result.matchedGroup = group;
      }
    });

    result.bestGroup = bestGroup;
    result.hitCount = bestGroup.filter(function (letter) { return picked.indexOf(letter) !== -1; }).length;
    result.missCount = bestGroup.length - result.hitCount;
    result.wrongPickCount = picked.filter(function (letter) { return bestGroup.indexOf(letter) === -1; }).length;
    return result;
  }

  /**
   * 把正解排版成人看得懂的字串。
   * 單一答案 → 「B」；多選 → 「A、C、D」；雙正解 → 「B 或 C」。
   */
  function formatGroups(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return '（沒有正解資料）';
    return groups.map(function (group) {
      return Array.isArray(group) ? group.join('、') : String(group);
    }).join(' 或 ');
  }

  // ============================================================
  // 篩選與出題順序
  // ============================================================

  /** 依年度範圍篩選題目；上下限給空值就不篩那一邊 */
  function filterByYear(questions, fromYear, toYear) {
    var lower = Number(fromYear);
    var upper = Number(toYear);
    return (Array.isArray(questions) ? questions : []).filter(function (question) {
      var year = Number(question && question.year);
      if (!isFinite(year)) return false;
      if (isFinite(lower) && year < lower) return false;
      if (isFinite(upper) && year > upper) return false;
      return true;
    });
  }

  /** 從題目清單取出有哪些年度，由小到大 */
  function collectYears(questions) {
    var seen = {};
    (Array.isArray(questions) ? questions : []).forEach(function (question) {
      var year = Number(question && question.year);
      if (isFinite(year)) seen[year] = true;
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  /**
   * 洗牌（Fisher-Yates）。隨機來源可以換掉，自我檢查頁才驗得出結果。
   * 不會改動傳進來的陣列。
   */
  function shuffle(list, randomFn) {
    var random = typeof randomFn === 'function' ? randomFn : Math.random;
    var result = (Array.isArray(list) ? list : []).slice();
    for (var i = result.length - 1; i > 0; i -= 1) {
      var j = Math.floor(random() * (i + 1));
      var temp = result[i];
      result[i] = result[j];
      result[j] = temp;
    }
    return result;
  }

  // ============================================================
  // 日期（一律台北時間 UTC+8）
  // ============================================================

  /**
   * 台北時間的日期字串（YYYY-MM-DD）。
   * 刻意用 UTC 加 8 小時算，裝置時區被改過也不會算錯。
   * @param {Date} date 外面傳進來的時間點（純函式不自己取現在時間）
   * @returns {string|null} 傳進來的不是有效時間就回 null
   */
  function toTaipeiDateString(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return null;
    var taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    var year = taipei.getUTCFullYear();
    var month = String(taipei.getUTCMonth() + 1);
    var day = String(taipei.getUTCDate());
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return year + '-' + month + '-' + day;
  }

  /**
   * 台北時間的「YYYY-MM-DD HH:MM」，用在畫面上顯示最後作答時間。
   * @param {Date} date 時間點
   * @param {boolean} withSeconds 要不要連秒數一起（存檔時間戳記用）
   */
  function toTaipeiStampString(date, withSeconds) {
    var dateText = toTaipeiDateString(date);
    if (!dateText) return null;
    var taipei = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    var pad = function (value) {
      var text = String(value);
      return text.length < 2 ? '0' + text : text;
    };
    var stamp = dateText + ' ' + pad(taipei.getUTCHours()) + ':' + pad(taipei.getUTCMinutes());
    return withSeconds ? (stamp + ':' + pad(taipei.getUTCSeconds())) : stamp;
  }

  // ============================================================
  // 錯誤訊息（一律繁體中文白話，絕不把瀏覽器的英文原文貼給使用者看）
  // ============================================================

  /**
   * 載入失敗時要顯示的訊息。
   * 瀏覽器丟出來的是「Load failed」「Failed to fetch」「Unexpected token」這種英文，
   * 使用者看不懂也不知道該怎麼辦，所以一律在這裡換成白話的中文＋下一步建議。
   * @param {string} reason 失敗原因代號
   * @param {string} label 載入的是什麼東西，例如「題庫索引」
   */
  function loadErrorText(reason, label) {
    var what = label ? label : '資料';
    var ask = '請按首頁的「檢查更新」，還是不行請聯絡製作人。';
    if (reason === 'timeout') {
      return what + '載入失敗：網路太慢，這次沒載入成功，請稍後再試。';
    }
    if (reason === 'offline') {
      return what + '載入失敗：現在連不上網路。等有訊號的時候再打開一次就好。';
    }
    if (reason === 'missing') {
      return '找不到' + what + '的檔案。' + ask;
    }
    if (reason === 'broken') {
      return what + '的檔案內容壞掉了。' + ask;
    }
    if (reason === 'file') {
      return what + '載入失敗：這個頁面是用「直接打開檔案」的方式開的，瀏覽器會擋住讀取題庫。' +
        '請改用小伺服器開啟（詳見使用說明）。';
    }
    return what + '載入失敗，請稍後再試一次。' + ask;
  }

  /**
   * 把載入失敗的錯誤物件歸類成原因代號。
   * @param {Object} error 瀏覽器丟出來的錯誤
   * @returns {string} 'timeout' / 'offline' / 'broken' / 'unknown'
   */
  function classifyLoadError(error) {
    var name = error && error.name ? String(error.name) : '';
    if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
    if (name === 'SyntaxError') return 'broken';
    if (name === 'TypeError') return 'offline';   // fetch 連不出去就是丟 TypeError
    return 'unknown';
  }

  /**
   * 進度存取失敗時要顯示的訊息（同樣不露出英文原文）。
   */
  function storageErrorText(error) {
    var name = error && error.name ? String(error.name) : '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return '這台裝置給瀏覽器的儲存空間已經滿了';
    }
    if (name === 'SecurityError') {
      return '這個瀏覽器不允許網站儲存資料，可能是無痕模式或隱私設定擋住了';
    }
    if (name === 'SyntaxError') {
      return '存在這台裝置裡的進度檔壞掉了';
    }
    return '這個瀏覽器不讓這個網站儲存資料';
  }

  // ============================================================
  // 主題統計（弱點分析、申論考點）
  // ============================================================

  var UNTAGGED = '未分類';            // 沒有標主題的題目統一歸這一類，不可以讓它們消失
  var LOW_CONFIDENCE_MIN = 5;         // 作答題數少於這個數字，答對率參考價值低

  /** 取出一題的主題；沒有標籤的歸「未分類」，不會回空陣列 */
  function topicsOf(question) {
    var list = question && question.topics;
    if (!Array.isArray(list)) return [UNTAGGED];
    var clean = list.map(function (item) { return String(item || '').trim(); })
      .filter(function (item) { return item !== ''; });
    return clean.length > 0 ? clean : [UNTAGGED];
  }

  /**
   * 讀索引裡的主題清單（建置器會附各主題題數，不用自己掃全庫）。
   * 格式可能是 { 主題: 題數 } 或 { 主題: { count: 題數 } }，兩種都接。
   * @returns {Object|null} { 主題: 題數 }
   */
  function readTopicTotals(index) {
    var block = index && (index.topics || index['主題'] || index.topicIndex);
    if (!block || typeof block !== 'object') return null;
    var source = block.topics && typeof block.topics === 'object' ? block.topics : block;

    var totals = {};
    Object.keys(source).forEach(function (topic) {
      var value = source[topic];
      var count = (value && typeof value === 'object') ? Number(value.count) : Number(value);
      if (isFinite(count)) totals[topic] = count;
    });
    return Object.keys(totals).length > 0 ? totals : null;
  }

  /** 一題有沒有作答過 */
  function hasAnswered(entry) {
    if (!entry) return false;
    return ((Number(entry.correctCount) || 0) + (Number(entry.wrongCount) || 0)) > 0;
  }

  /**
   * 依主題統計答對率（弱點分析用）。
   *
   * 【注意】一題可以掛好幾個主題，所以各主題的題數加起來會比總題數多，
   * 這是正常的，畫面上要跟使用者講清楚。
   *
   * @param {Array} questions 題目（要含 topics）
   * @param {Object} progress 進度
   * @param {Object} options { topicTotals, minAnswered }
   * @returns {Array} 由弱到強排序
   */
  function topicStats(questions, progress, options) {
    var settings = options || {};
    var map = (progress && progress.questions) || {};
    var totals = settings.topicTotals || null;
    var minAnswered = Number(settings.minAnswered) || LOW_CONFIDENCE_MIN;
    var box = {};

    (Array.isArray(questions) ? questions : []).forEach(function (question) {
      if (!question) return;
      var entry = map[question.id];
      var answered = hasAnswered(entry);
      var correct = Number(entry && entry.correctCount) || 0;
      var wrong = Number(entry && entry.wrongCount) || 0;

      topicsOf(question).forEach(function (topic) {
        if (!box[topic]) {
          box[topic] = { topic: topic, total: 0, answeredQuestions: 0, correct: 0, wrong: 0 };
        }
        box[topic].total += 1;
        if (answered) {
          box[topic].answeredQuestions += 1;
          box[topic].correct += correct;
          box[topic].wrong += wrong;
        }
      });
    });

    var rows = Object.keys(box).map(function (topic) {
      var item = box[topic];
      var times = item.correct + item.wrong;
      // 題庫總題數優先用索引給的；沒刷過的題數一定要用同一個基準算，
      // 否則會出現「題庫 120 題、還有 1 題沒刷過」這種自相矛盾的數字
      var total = totals && totals[topic] !== undefined ? totals[topic] : item.total;
      return {
        topic: topic,
        total: total,
        answered: item.answeredQuestions,          // 刷過幾題（不重複計）
        times: times,                              // 總共作答幾次
        correct: item.correct,
        wrong: item.wrong,
        accuracy: times === 0 ? null : Math.round((item.correct / times) * 100),
        untouched: Math.max(0, total - item.answeredQuestions),
        lowConfidence: item.answeredQuestions > 0 && item.answeredQuestions < minAnswered
      };
    });

    // 最弱的排最前面；還沒刷過的（沒有答對率）排最後，因為那不是「弱」是「還沒練」
    rows.sort(function (a, b) {
      if (a.accuracy === null && b.accuracy === null) return b.total - a.total;
      if (a.accuracy === null) return 1;
      if (b.accuracy === null) return -1;
      if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
      return b.answered - a.answered;              // 答對率一樣時，刷得多的排前面（比較可信）
    });
    return rows;
  }

  /** 依科目統計答對率（哪一科整體最弱） */
  function subjectStats(questions, progress) {
    var map = (progress && progress.questions) || {};
    var box = {};

    (Array.isArray(questions) ? questions : []).forEach(function (question) {
      if (!question) return;
      var name = question.subject || '不明科目';
      if (!box[name]) box[name] = { subject: name, total: 0, answered: 0, correct: 0, wrong: 0 };
      box[name].total += 1;

      var entry = map[question.id];
      if (hasAnswered(entry)) {
        box[name].answered += 1;
        box[name].correct += Number(entry.correctCount) || 0;
        box[name].wrong += Number(entry.wrongCount) || 0;
      }
    });

    var rows = Object.keys(box).map(function (name) {
      var item = box[name];
      var times = item.correct + item.wrong;
      return {
        subject: name,
        total: item.total,
        answered: item.answered,
        times: times,
        correct: item.correct,
        wrong: item.wrong,
        accuracy: times === 0 ? null : Math.round((item.correct / times) * 100),
        untouched: Math.max(0, item.total - item.answered),
        lowConfidence: item.answered > 0 && item.answered < LOW_CONFIDENCE_MIN
      };
    });

    rows.sort(function (a, b) {
      if (a.accuracy === null && b.accuracy === null) return b.total - a.total;
      if (a.accuracy === null) return 1;
      if (b.accuracy === null) return -1;
      return a.accuracy - b.accuracy;
    });
    return rows;
  }

  /**
   * 從某個主題挑題目出來練。
   * 順序：沒刷過的 → 答錯過的（錯最多次的優先）→ 其他，
   * 因為「補弱點」最該補的是沒碰過與一直錯的。
   */
  function pickTopicQuestions(questions, progress, topic, limit, randomFn) {
    var map = (progress && progress.questions) || {};
    var fresh = [];
    var wrong = [];
    var rest = [];

    (Array.isArray(questions) ? questions : []).forEach(function (question) {
      if (!question) return;
      if (topic && topicsOf(question).indexOf(topic) === -1) return;
      var entry = map[question.id];
      if (!hasAnswered(entry)) { fresh.push(question); return; }
      if ((Number(entry.wrongCount) || 0) > 0) { wrong.push(question); return; }
      rest.push(question);
    });

    fresh = shuffle(fresh, randomFn);
    wrong.sort(function (a, b) {
      return (Number(map[b.id].wrongCount) || 0) - (Number(map[a.id].wrongCount) || 0);
    });
    rest = shuffle(rest, randomFn);

    var all = fresh.concat(wrong).concat(rest);
    var max = Number(limit) > 0 ? Number(limit) : all.length;
    return all.slice(0, max);
  }

  /**
   * 申論考點統計：哪些主題年年考。
   * 申論只能押題，所以「出現幾次、哪幾年考過」比題目本身重要。
   * @returns {Array} 由考得最多的排到最少
   */
  function essayTopicStats(questions) {
    var box = {};

    (Array.isArray(questions) ? questions : []).forEach(function (question) {
      if (!question) return;
      var year = Number(question.year);
      topicsOf(question).forEach(function (topic) {
        if (!box[topic]) box[topic] = { topic: topic, count: 0, years: {}, ids: [] };
        box[topic].count += 1;
        if (isFinite(year)) box[topic].years[year] = true;
        if (question.id) box[topic].ids.push(question.id);
      });
    });

    var rows = Object.keys(box).map(function (topic) {
      var item = box[topic];
      var years = Object.keys(item.years).map(Number).sort(function (a, b) { return a - b; });
      return {
        topic: topic,
        count: item.count,
        years: years,
        yearCount: years.length,
        latestYear: years.length ? years[years.length - 1] : null,
        ids: item.ids
      };
    });

    rows.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (b.yearCount !== a.yearCount) return b.yearCount - a.yearCount;
      return a.topic.localeCompare(b.topic);
    });
    return rows;
  }

  /** 照主題篩題目（申論考點點進去看那幾題用） */
  function filterByTopic(questions, topic) {
    if (!topic) return Array.isArray(questions) ? questions.slice() : [];
    return (Array.isArray(questions) ? questions : []).filter(function (question) {
      return topicsOf(question).indexOf(topic) !== -1;
    });
  }

  // ============================================================
  // 法條速查
  // ============================================================

  /** 全形數字轉半形，順便去掉空白（使用者可能用注音輸入法打出全形數字） */
  function toHalfWidthDigits(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/[０-９]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      });
  }

  /**
   * 把條號整理成統一的鍵，方便比對。
   *   「第 185 條之 3」→「185-3」　「第1條」→「1」　「185-3」→「185-3」
   * @returns {string|null} 看不出是條號就回 null
   */
  function normalizeArticleKey(text) {
    var clean = toHalfWidthDigits(text).replace(/\s+/g, '');
    if (!clean) return null;

    /*
     * 全國法規資料庫的條號寫法是「第 185-3 條」，
     * 但使用者習慣打「第 185 條之 3」或「185-3」，兩種都要認得。
     */
    var dashInside = clean.match(/第(\d+)[-－](\d+)條/);
    if (dashInside) return dashInside[1] + '-' + dashInside[2];

    var formal = clean.match(/第(\d+)條(?:之(\d+))?/);
    if (formal) return formal[2] ? (formal[1] + '-' + formal[2]) : formal[1];

    var dashed = clean.match(/^(\d+)[-－之](\d+)$/);
    if (dashed) return dashed[1] + '-' + dashed[2];

    var bare = clean.match(/^(\d+)$/);
    if (bare) return bare[1];

    return null;
  }

  /** 把條號鍵排版成法規資料庫的寫法：'185-3' → 「第 185-3 條」 */
  function formatArticleKey(key) {
    var text = String(key || '').trim();
    return text ? ('第 ' + text + ' 條') : '';
  }

  /**
   * 拆解使用者打的搜尋字串。
   * 例如「刑法 185-3」→ 條號 185-3、關鍵字「刑法」
   *     「第 185 條」→ 條號 185
   *     「通訊監察」→ 關鍵字「通訊監察」
   * @returns {{raw, articleKey, keyword, empty}}
   */
  function parseLawQuery(text) {
    var raw = String(text === null || text === undefined ? '' : text).trim();
    if (!raw) return { raw: '', articleKey: null, keyword: '', empty: true };

    var working = toHalfWidthDigits(raw);
    var articleKey = null;

    // 1a. 法規資料庫的寫法「第 185-3 條」
    var dashInside = working.match(/第\s*(\d+)\s*[-－]\s*(\d+)\s*條/);
    if (dashInside) {
      articleKey = dashInside[1] + '-' + dashInside[2];
      working = working.replace(dashInside[0], ' ');
    }

    // 1b. 使用者習慣的寫法「第 185 條之 3」
    var formal = !articleKey && working.match(/第\s*(\d+)\s*條(?:\s*之\s*(\d+))?/);
    if (formal) {
      articleKey = formal[2] ? (formal[1] + '-' + formal[2]) : formal[1];
      working = working.replace(formal[0], ' ');
    } else if (!articleKey) {
      // 2. 再找「185-3」這種簡寫（前後要是空白或字串邊界，免得把年份切壞）
      var dashed = working.match(/(^|\s)(\d+)\s*[-－]\s*(\d+)(\s|$)/);
      if (dashed) {
        articleKey = dashed[2] + '-' + dashed[3];
        working = working.replace(dashed[0], ' ');
      } else {
        // 3. 最後才看單獨的數字
        var bare = working.match(/(^|\s)(\d+)(\s|$)/);
        if (bare) {
          articleKey = bare[2];
          working = working.replace(bare[0], ' ');
        }
      }
    }

    return {
      raw: raw,
      articleKey: articleKey,
      keyword: working.replace(/\s+/g, ' ').trim(),
      empty: false
    };
  }

  /** 法規清單整理成陣列（index.json 的「法規」區塊） */
  function listLaws(lawIndex) {
    var table = (lawIndex && (lawIndex['法規'] || lawIndex.laws)) || {};
    return Object.keys(table).map(function (code) {
      var item = table[code] || {};
      return {
        code: code,
        name: item.name || code,
        file: item.file || (code + '.json'),
        category: item.category || '其他',
        articles: Number(item.articles) || 0,
        modified: item.modified || '',
        url: item.url || ''
      };
    });
  }

  /**
   * 依分類分組（畫面上一類一區）。
   * @param {Array} laws 法規清單
   * @param {Array} categoryOrder 索引裡的「分類順序」，有給就照它排，沒給就照出現順序
   */
  function groupLawsByCategory(laws, categoryOrder) {
    var order = [];
    var groups = {};
    (Array.isArray(laws) ? laws : []).forEach(function (law) {
      var key = law.category || '其他';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(law);
    });

    if (Array.isArray(categoryOrder) && categoryOrder.length > 0) {
      var wanted = categoryOrder.filter(function (name) { return groups[name]; });
      order.forEach(function (name) {
        if (wanted.indexOf(name) === -1) wanted.push(name);   // 索引沒列到的排最後
      });
      order = wanted;
    }

    return order.map(function (name) {
      return {
        category: name,
        laws: groups[name].slice().sort(function (a, b) { return b.articles - a.articles; })
      };
    });
  }

  /**
   * 搜尋法規清單（只找法規名稱與分類，很便宜，可以邊打邊找）。
   * 空字串一律回空陣列——不可以讓「什麼都沒打」變成「列出全部」。
   */
  function searchLawList(laws, query) {
    var parsed = typeof query === 'string' ? parseLawQuery(query) : (query || {});
    var keyword = (parsed.keyword || '').trim();
    if (!keyword) return [];
    return (Array.isArray(laws) ? laws : []).filter(function (law) {
      return String(law.name).indexOf(keyword) !== -1 ||
        String(law.category).indexOf(keyword) !== -1;
    });
  }

  /**
   * 在一部法規裡面找條文。
   *   有條號 → 先給完全相同的，再給同一條的「之 N」
   *   有關鍵字 → 條文內容或條號含關鍵字
   *   兩個都有 → 先用條號篩，再用關鍵字篩
   * @returns {Array} 命中的條文（已排序，完全相符的排最前面）
   */
  function searchArticles(articles, query, limit) {
    var list = Array.isArray(articles) ? articles : [];
    var parsed = typeof query === 'string' ? parseLawQuery(query) : (query || {});
    if (parsed.empty || (!parsed.articleKey && !parsed.keyword)) return [];

    var max = Number(limit) > 0 ? Number(limit) : 200;
    var keyword = parsed.keyword || '';
    var key = parsed.articleKey;
    var exact = [];
    var related = [];

    list.forEach(function (article) {
      if (!article) return;
      var text = String(article.text || '');
      var hitKeyword = !keyword ||
        text.indexOf(keyword) !== -1 || String(article.no || '').indexOf(keyword) !== -1;
      if (!hitKeyword) return;

      if (!key) { related.push(article); return; }

      var articleKey = normalizeArticleKey(article.no);
      if (articleKey === key) {
        exact.push(article);
      } else if (articleKey && articleKey.split('-')[0] === key.split('-')[0]) {
        related.push(article);        // 同一條的「之 1」「之 2」也一起帶出來
      }
    });

    return exact.concat(related).slice(0, max);
  }

  /**
   * 用法規名稱找代號（題目跳到法條用）。
   * 建置器還沒附 lawCode 時，靠名稱對一樣找得到。
   */
  function findLawCode(laws, lawName) {
    var name = String(lawName || '').trim();
    if (!name) return null;
    var list = Array.isArray(laws) ? laws : [];

    var exact = list.filter(function (law) { return law.name === name; })[0];
    if (exact) return exact.code;

    // 名稱略有出入時（例如「刑法」對「中華民國刑法」）用包含關係找，取最短的那個
    var loose = list.filter(function (law) {
      return String(law.name).indexOf(name) !== -1 || name.indexOf(String(law.name)) !== -1;
    }).sort(function (a, b) { return String(a.name).length - String(b.name).length; });
    return loose.length ? loose[0].code : null;
  }

  // ============================================================
  // AI 詳解的提示詞與錯誤訊息
  // ============================================================

  /**
   * 組出要丟給 AI 的提示詞。
   * 一定要帶出題年度與科目，並且**明確要求 AI 指出這題是否因修法已與現行法不符**——
   * 一石二鳥，順手處理法條時效。寧可它回「不確定」，也不要它編一個法條出來。
   */
  function buildExplainPrompt(question) {
    if (!question || typeof question !== 'object') return '';
    var report = inspectQuestion(question);
    var lines = [];

    lines.push('你是台灣警察考試的解題老師。以下是一題警察考試的考古題，請用繁體中文講解。');
    lines.push('');
    lines.push('【出題年度】民國 ' + (question.year || '不明') + ' 年');
    lines.push('【科目】' + (question.subject || '不明') +
      (question.originalSubject && question.originalSubject !== question.subject
        ? '（當年的科目名稱：' + question.originalSubject + '）' : ''));
    if (question.session) lines.push('【場次】' + question.session);
    lines.push('【題型】' + typeLabel(question.type) +
      (question.type === 'multi' ? '（五個選項，要全部選對才算答對）' : ''));
    lines.push('【題幹】' + (question.stem || ''));

    lines.push('【選項】');
    report.validLetters.forEach(function (letter) {
      lines.push(letter + '. ' + String(question.options[letter]));
    });

    if (question.allCorrect === true) {
      lines.push('【官方正解】本題官方公告一律給分');
    } else {
      lines.push('【官方正解】' + formatGroups(report.groups));
    }
    if (question.revised && question.revisionNote) {
      lines.push('【官方釋疑】' + question.revisionNote);
    }

    lines.push('');
    lines.push('請依序回答這三點，用條列式、講重點、不要客套話：');
    lines.push('一、為什麼正解是這個答案？請引用相關法條條號或實務見解。');
    lines.push('二、其他選項分別錯在哪裡？');
    lines.push('三、【這一點最重要】這題涉及的法規，從民國 ' + (question.year || '當年') +
      ' 年出題到現在有沒有修正過？如果有，現在的規定是什麼？這題的官方答案是否已經不符合現行法？');
    lines.push('');
    lines.push('注意：沒有把握的地方請直說「不確定」，絕對不要編造法條或條號。全部用繁體中文作答。');
    return lines.join('\n');
  }

  /** AI 詳解失敗時的白話訊息（一樣不給使用者看英文原文） */
  function aiErrorText(reason) {
    if (reason === 'nokey') {
      return '還沒設定 AI 金鑰。請到設定頁貼上你自己的金鑰，才能請 AI 講解。';
    }
    if (reason === 'auth') {
      return 'AI 金鑰看起來不正確或已經失效，請到設定頁重新貼一次。';
    }
    if (reason === 'rate') {
      return '問得太頻繁或這個月的額度用完了，等一下再試一次。';
    }
    if (reason === 'busy') {
      return 'AI 服務現在忙線中，過一會兒再按一次。';
    }
    if (reason === 'timeout') {
      return 'AI 想太久了（超過一分鐘），這次先放棄，稍後再試一次。';
    }
    if (reason === 'offline') {
      return '現在連不上網路，沒辦法問 AI。已經問過的題目離線也看得到。';
    }
    if (reason === 'blocked') {
      return '瀏覽器擋住了連到 AI 的請求。請確認金鑰是 Anthropic 的，而且網路沒有經過會攔截的代理伺服器。';
    }
    return '問 AI 的時候出了狀況，稍後再試一次。';
  }

  /** AI 詳解下方固定要掛的免責提醒（要拿去考試的，不能照單全收） */
  var AI_DISCLAIMER = '本詳解由 AI 生成，可能有誤，以法條原文為準。';

  // ============================================================
  // AI 詳解快取綁定題目內容（題目修正過，舊詳解自動作廢）
  // ============================================================

  /*
   * 為什麼要綁：詳解快取原本只用題號當鑰匙。題庫修正題幹或選項時題號不變，
   * 舊詳解可能是對著壞掉的題目寫的（例如題組引文缺一段、選項尾巴黏到下一題的字）。
   * 所以新詳解多存一個「題目內容指紋」，題目內容一變指紋就對不上，舊詳解自動作廢。
   *
   * 指紋只看題幹、選項、正解三樣。主題標籤、過時提示、出處這些欄位每次重新建置都可能變，
   * 算進去會害沒問題的詳解被白白作廢（使用者要再花一次錢問 AI）。
   * 題幹逐字比對、不做空白整理：寧可多重問一次，也不要把針對壞題目的講解留著。
   *
   * 【注意】演算法或納入的欄位一旦改了，所有舊指紋都會對不上、全部詳解要重問。
   * 真的要改，請換一個新的欄位名稱存（例如 contentFingerprint2），不要直接改這裡。
   */

  /** 題目內容修正過、舊詳解作廢而重新問 AI 時，講解上方要顯示的一行小字 */
  var EXPLAIN_REASKED_NOTICE = '這題的題目內容修正過，之前的講解已作廢，這是重新問的';

  /**
   * FNV-1a 32 位元雜湊，回傳 8 碼 16 進位。
   * 逐個 UTF-16 字碼計算（不轉位元組），任何瀏覽器、任何裝置算出來都一樣。
   */
  function fnv1aHex(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      // 乘上 FNV 質數 16777619；拆成移位相加，避免大數相乘超出精度算錯
      hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
    var hex = hash.toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex;
  }

  /** 任何值轉成字串，null / undefined 一律當空字串 */
  function plainText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /**
   * 算一題的「題目內容指紋」。
   * 選項依字母排序、正解組內字母排序、正解組之間也排序，
   * 所以只是存放順序不同不會變；內容差一個字就會變。
   * @param {Object} question 題目
   * @returns {string|null} 8 碼 16 進位；傳進來的不是題目就回 null
   */
  function questionFingerprint(question) {
    if (!question || typeof question !== 'object') return null;

    // 用控制字元當分隔，題目文字裡不會出現，避免「AB｜C」跟「A｜BC」被串成同一串
    var FIELD_SEP = '\u001e';
    var ITEM_SEP = '\u001f';

    var options = question.options && typeof question.options === 'object' ? question.options : {};
    var optionPart = Object.keys(options).sort().map(function (letter) {
      return letter + '=' + plainText(options[letter]);
    }).join(ITEM_SEP);

    var answerPart = (Array.isArray(question.answers) ? question.answers : []).map(function (group) {
      var letters = Array.isArray(group) ? group : [group];
      return letters.map(function (item) { return plainText(item).trim().toUpperCase(); })
        .sort().join(',');
    }).sort().join(ITEM_SEP);

    return fnv1aHex(['S' + plainText(question.stem), 'O' + optionPart, 'A' + answerPart].join(FIELD_SEP));
  }

  /**
   * 判斷一筆 AI 詳解快取還能不能用。
   *   有指紋：跟目前題目的指紋相同才用，不同就作廢（要重新問）。
   *   沒指紋（舊版存的）：題號在修正清單裡就作廢；不在就照用，並且補上目前的指紋，
   *                       以後題目再修正也判斷得出來。
   *   修正清單不存在（舊題庫）或格式不對：當成空清單，一律照舊行為。
   * @param {Object} cached 快取紀錄 { id, text, model, askedAt, contentFingerprint? }
   * @param {Object} question 目前的題目
   * @param {Array} contentFixedIds index.json 的 contentFixedIds（題目內容修正過的題號）
   * @returns {{usable: boolean, invalidated: boolean, backfill: boolean, fingerprint: (string|null)}}
   *   usable 能直接用；invalidated 有舊詳解但已作廢；backfill 要補寫指紋；fingerprint 目前題目的指紋
   */
  function explainCacheVerdict(cached, question, contentFixedIds) {
    var fingerprint = questionFingerprint(question);
    var verdict = { usable: false, invalidated: false, backfill: false, fingerprint: fingerprint };
    if (!cached || typeof cached !== 'object' || !cached.text) return verdict;   // 根本沒有快取

    var stored = cached.contentFingerprint;
    if (typeof stored === 'string' && stored !== '') {
      if (stored === fingerprint) {
        verdict.usable = true;
      } else {
        verdict.invalidated = true;
      }
      return verdict;
    }

    // 舊版存的，沒有指紋：只能靠修正清單判斷
    var questionId = plainText(question && question.id ? question.id : cached.id);
    var fixedIds = Array.isArray(contentFixedIds) ? contentFixedIds : [];
    if (questionId !== '' && fixedIds.indexOf(questionId) !== -1) {
      verdict.invalidated = true;
      return verdict;
    }
    verdict.usable = true;
    verdict.backfill = fingerprint !== null;
    return verdict;
  }

  // ============================================================
  // 進度紀錄
  // ============================================================

  /**
   * 一題進度的空白紀錄。
   * 【注意】這個結構是使用者累積的資產，只能加欄位、不能改名或刪欄位，
   * 否則累積的進度會全部對不上（進度只存本機，對不上就救不回來）。
   */
  function makeProgressEntry() {
    return {
      correctCount: 0,      // 答對次數
      wrongCount: 0,        // 答錯次數
      streak: 0,            // 連續答對次數
      lastAnsweredAt: null, // 最後作答日（台北時間 YYYY-MM-DD）
      box: 1,               // 盒號（五格抽屜，6 代表已熟）
      dueAt: null,          // 下次到期日（台北時間 YYYY-MM-DD）
      sc: null              // 科目代號，讓「到期複習」知道要載入哪一科（舊紀錄可能沒有）
    };
  }

  /**
   * 把一次作答結果併進某一題的進度紀錄。
   * 回傳新物件，不改原本那一筆，避免畫面與儲存的資料互相影響。
   * @param {Object} entry 原本的紀錄（沒有就傳 null）
   * @param {boolean} correct 這次答對沒有
   * @param {string} dateString 台北時間的日期字串，由外面傳進來
   * @param {string} subjectCode 這題屬於哪一科（選填）
   */
  function applyAnswerToProgress(entry, correct, dateString, subjectCode) {
    var base = entry && typeof entry === 'object' ? entry : makeProgressEntry();
    var next = {
      correctCount: Number(base.correctCount) || 0,
      wrongCount: Number(base.wrongCount) || 0,
      streak: Number(base.streak) || 0,
      lastAnsweredAt: dateString || base.lastAnsweredAt || null,
      box: Number(base.box) || 1,
      dueAt: base.dueAt === undefined ? null : base.dueAt,
      sc: subjectCode || base.sc || null
    };
    if (correct) {
      next.correctCount += 1;
      next.streak += 1;
    } else {
      next.wrongCount += 1;
      next.streak = 0;
    }
    return next;
  }

  // ============================================================
  // 間隔重複：五格抽屜
  // ============================================================

  /*
   * 為什麼用抽屜制而不是 Anki 那套（SM-2）：
   * 那套有好幾個參數互相影響，出問題時看不出是哪個數字怪、也不知道要調哪個。
   * 抽屜制一眼就懂、一行就能改，對「幾個月內考完兩場」這種短期衝刺效果差不多。
   *
   * 桌上五個抽屜，答對往後一格（下次更晚出現），答錯打回第一格（明天再見）。
   * 第 6 格是「畢業」，標示已熟，30 天後再出一次。
   */
  var BOX_INTERVALS = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 30 };
  var MAX_BOX = 6;            // 第 6 格 ＝ 已熟（畢業）
  var DEFAULT_DAILY_LIMIT = 60;   // 每天最多出幾題到期題
  var DEFAULT_STREAK_THRESHOLD = 3; // 連續答對幾次才從錯題本放出去
  var EXAM_BUFFER_DAYS = 3;   // 到期日最晚不可超過考試日往前幾天

  /** 盒號對應的間隔天數 */
  function intervalForBox(box) {
    var value = Number(box);
    if (!isFinite(value) || value < 1) value = 1;
    if (value > MAX_BOX) value = MAX_BOX;
    return BOX_INTERVALS[value];
  }

  /** 這一格算不算「已熟」 */
  function isGraduated(box) {
    return (Number(box) || 1) >= MAX_BOX;
  }

  /**
   * 把這次作答換算成三種結果。
   * 多選題「部分對」要單獨分出來：完全命中才算對，部分對算答錯，
   * 但只退一格、不是打回第一格，否則多選題會永遠卡在第 1 格天天出現，刷到崩潰。
   * @returns {string} 'correct'（全對）／'partial'（部分對）／'wrong'（全錯或沒作答）
   */
  function outcomeOf(question, verdict) {
    if (!verdict) return 'wrong';
    if (verdict.correct) return 'correct';
    var isMulti = question && question.type === 'multi';
    if (isMulti && verdict.hitCount > 0) return 'partial';
    return 'wrong';
  }

  /** 依結果決定下一格 */
  function nextBox(box, outcome) {
    var current = Number(box) || 1;
    if (current < 1) current = 1;
    if (current > MAX_BOX) current = MAX_BOX;
    if (outcome === 'correct') return Math.min(current + 1, MAX_BOX);
    if (outcome === 'partial') return Math.max(current - 1, 1);  // 多選部分對只退一格
    return 1;                                                    // 全錯打回第一格
  }

  // ---------- 日期小工具（一律用 YYYY-MM-DD 字串，不碰時區） ----------

  /** 字串日期轉成 UTC 當天零時的 Date（只用來算天數差，不做時區換算） */
  function isoToUtc(iso) {
    if (typeof iso !== 'string') return null;
    var m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    var time = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(time) ? null : time;
  }

  /** 把 YYYY-MM-DD 往後推 n 天，回傳新的 YYYY-MM-DD */
  function addDaysISO(iso, days) {
    var base = isoToUtc(iso);
    var step = Number(days);
    if (base === null || !isFinite(step)) return null;
    var moved = new Date(base + Math.round(step) * 86400000);
    var month = String(moved.getUTCMonth() + 1);
    var day = String(moved.getUTCDate());
    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    return moved.getUTCFullYear() + '-' + month + '-' + day;
  }

  /** 兩個日期差幾天（後面減前面），算不出來回 null */
  function daysBetweenISO(fromIso, toIso) {
    var a = isoToUtc(fromIso);
    var b = isoToUtc(toIso);
    if (a === null || b === null) return null;
    return Math.round((b - a) / 86400000);
  }

  /**
   * 這一題該跟著哪一場考試的日期壓縮。
   * 共用科目（兩場都考的，例如警察法規）以**較近的那一場**為準——
   * 3 月那場滾得夠緊，6 月那場自然早就滾過好幾輪，不會白刷兩遍。
   * @param {Array} targets 這一科對應的考試（index.json 的 targets）
   * @param {Object} examDates { 考試名稱: 'YYYY-MM-DD' }
   */
  function pickExamDateISO(targets, examDates) {
    var dates = examDates && typeof examDates === 'object' ? examDates : {};
    var list = Array.isArray(targets) && targets.length
      ? targets.map(function (name) { return dates[name]; })
      : Object.keys(dates).map(function (name) { return dates[name]; });
    var valid = list.filter(function (iso) { return isoToUtc(iso) !== null; });
    valid.sort();
    return valid.length ? valid[0] : null;
  }

  /**
   * 把間隔天數依考試日壓縮。
   *   動態壓縮：距考試還有 D 天時，間隔上限 = D ÷ 3（最少 1 天）。
   *            距 150 天時上限 50 天、剩 30 天時上限 10 天、剩 9 天時上限 3 天。
   *   硬上限：下次到期日不可以晚於考試日的前 3 天。
   * 考試日已經過了就不再壓縮（那場考完了）。
   */
  function capIntervalDays(days, todayISO, examISO) {
    var raw = Math.max(1, Math.round(Number(days) || 1));
    var left = daysBetweenISO(todayISO, examISO);
    if (left === null || left <= 0) return raw;

    var dynamicCap = Math.max(1, Math.floor(left / 3));
    var hardCap = Math.max(1, left - EXAM_BUFFER_DAYS);
    return Math.max(1, Math.min(raw, dynamicCap, hardCap));
  }

  /**
   * 算出這一題下次什麼時候再出現。
   * @param {Object} entry 這一題目前的進度紀錄
   * @param {string} outcome 'correct' / 'partial' / 'wrong'
   * @param {string} todayISO 今天（台北時間 YYYY-MM-DD）
   * @param {string} examISO 這一科要對齊的考試日（沒有就傳 null）
   * @returns {{box: number, dueAt: string, interval: number, graduated: boolean}}
   */
  function scheduleNext(entry, outcome, todayISO, examISO) {
    var box = nextBox(entry && entry.box, outcome);
    var interval = capIntervalDays(intervalForBox(box), todayISO, examISO);
    return {
      box: box,
      dueAt: addDaysISO(todayISO, interval),
      interval: interval,
      graduated: isGraduated(box)
    };
  }

  // ============================================================
  // 到期題與錯題本
  // ============================================================

  /** 這一題今天到期了嗎 */
  function isDue(entry, todayISO) {
    if (!entry || !entry.dueAt) return false;
    return String(entry.dueAt) <= String(todayISO);
  }

  /**
   * 這一題在不在錯題本裡。
   * 依 ADR 的設計，錯題本**不另外存一份**，由作答紀錄推導：
   * 曾經答錯過，而且連續答對次數還沒到門檻。兩份資料容易不同步，寧願現算。
   */
  function isInWrongBook(entry, threshold) {
    if (!entry) return false;
    var limit = Number(threshold) || DEFAULT_STREAK_THRESHOLD;
    return (Number(entry.wrongCount) || 0) > 0 && (Number(entry.streak) || 0) < limit;
  }

  /** 統計進度裡有幾題到期、幾題在錯題本、幾題已熟 */
  function summarizeStudyState(progress, todayISO, threshold) {
    var questions = (progress && progress.questions) || {};
    var due = 0;
    var wrongBook = 0;
    var graduated = 0;
    var subjectsDue = {};

    Object.keys(questions).forEach(function (id) {
      var entry = questions[id];
      if (isDue(entry, todayISO)) {
        due += 1;
        var code = entry && entry.sc;
        if (code) subjectsDue[code] = (subjectsDue[code] || 0) + 1;
      }
      if (isInWrongBook(entry, threshold)) wrongBook += 1;
      if (entry && isGraduated(entry.box) && (Number(entry.correctCount) || 0) > 0) graduated += 1;
    });

    return {
      due: due,
      wrongBook: wrongBook,
      graduated: graduated,
      subjectsDue: subjectsDue           // 哪些科目有到期題（決定要載入哪幾科）
    };
  }

  /**
   * 從題目清單挑出今天該複習的。
   * 排序：抽屜格數小的（比較不熟的）優先，再比到期日。
   * 超過每日上限的自動往後順延——否則某天狂刷 200 題，8 天後會一次全部到期。
   */
  function pickDueQuestions(questions, progress, todayISO, dailyLimit) {
    var map = (progress && progress.questions) || {};
    var limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : DEFAULT_DAILY_LIMIT;
    var pool = (Array.isArray(questions) ? questions : []).filter(function (question) {
      return question && isDue(map[question.id], todayISO);
    });

    pool.sort(function (a, b) {
      var ea = map[a.id] || {};
      var eb = map[b.id] || {};
      var boxDiff = (Number(ea.box) || 1) - (Number(eb.box) || 1);
      if (boxDiff !== 0) return boxDiff;
      return String(ea.dueAt || '').localeCompare(String(eb.dueAt || ''));
    });

    return pool.slice(0, limit);
  }

  /** 從題目清單挑出錯題本裡的題目（答錯最多的排前面） */
  function pickWrongBookQuestions(questions, progress, threshold) {
    var map = (progress && progress.questions) || {};
    var pool = (Array.isArray(questions) ? questions : []).filter(function (question) {
      return question && isInWrongBook(map[question.id], threshold);
    });
    pool.sort(function (a, b) {
      var ea = map[a.id] || {};
      var eb = map[b.id] || {};
      return (Number(eb.wrongCount) || 0) - (Number(ea.wrongCount) || 0);
    });
    return pool;
  }

  /** 把使用者自己標過時的題目濾掉 */
  function excludeStaleFlagged(questions, progress) {
    var flags = (progress && progress.staleFlags) || {};
    return (Array.isArray(questions) ? questions : []).filter(function (question) {
      return !(question && flags[question.id]);
    });
  }

  // ============================================================
  // 模擬整卷計分（兩套規則分開，見 docs/adr/0007）
  // ============================================================

  /** 從試卷封面的計分說明裡找出每題幾分，找不到就回 null（不猜） */
  function parsePointsPerQuestion(scoringNote) {
    var text = String(scoringNote || '');
    var m = text.match(/每題\s*([0-9]+(?:\.[0-9]+)?)\s*分/);
    return m ? Number(m[1]) : null;
  }

  /** 從計分說明裡找出測驗題部分的滿分，找不到就回 null */
  function parseSectionFullScore(scoringNote) {
    var text = String(scoringNote || '');
    var m = text.match(/[（(]\s*([0-9]+(?:\.[0-9]+)?)\s*分\s*[）)]/);
    return m ? Number(m[1]) : null;
  }

  /**
   * 算一份模擬試卷的分數。
   *
   * 警佐班（cpu-deduct）：
   *   單選每題 2 分，答錯倒扣 1/3 題分（也就是 2/3 分），不答 0 分。
   *   多選每題 3 分，依「判斷錯誤的選項數 k」給分：得分 = (選項數 - 2k) / 選項數 × 題分，
   *   單題不給負分，完全不答 0 分。（k 包含漏選與誤選，詳見下方多選分支的說明）
   * 刑事三等（moex-no-deduct）：
   *   答錯不倒扣。每題配分依該科試卷封面（憲英 1.25 分，其他多為 2 分）。
   *   測驗題只占該科一半分數，所以結果一定要標明「申論題未計入」。
   *
   * @param {Object} spec { scoring, pointsPerSingle, pointsPerMulti, sectionFullScore }
   * @param {Array} records [{ type, verdict, answered }]
   */
  function scorePaper(spec, records) {
    var rule = (spec && spec.scoring) || 'moex-no-deduct';
    var list = Array.isArray(records) ? records : [];
    var singlePoints = Number(spec && spec.pointsPerSingle);
    var multiPoints = Number(spec && spec.pointsPerMulti);
    if (!isFinite(singlePoints) || singlePoints <= 0) singlePoints = rule === 'cpu-deduct' ? 2 : 2;
    if (!isFinite(multiPoints) || multiPoints <= 0) multiPoints = 3;

    var score = 0;
    var correct = 0;
    var wrong = 0;
    var blank = 0;

    list.forEach(function (record) {
      var verdict = record && record.verdict;
      var isMulti = record && record.type === 'multi';
      var answered = !!(record && record.answered);
      var points = isMulti ? multiPoints : singlePoints;

      if (!answered) {
        blank += 1;
        return;                                   // 不答一律 0 分，兩套規則都一樣
      }
      if (verdict && verdict.correct) {
        correct += 1;
        score += points;
        return;
      }

      wrong += 1;
      if (rule === 'cpu-deduct') {
        if (isMulti) {
          /*
           * 多選題的標準公式（公務人員考試複選題，見 docs/adr/0007）：
           *
           *     得分 = (n - 2k) / n × 題分        n = 選項數、k = 判斷錯誤的選項數
           *
           * 【關鍵】封面寫的「答對每一選項者各獲得 1/5 題分」，
           * 指的是「每一個選項的判斷正確」，而「正確地不選一個不該選的選項」也算判斷正確。
           * 所以 k = 漏選的 ＋ 誤選的；五個選項全部判斷正確（k=0）自然就是滿分 3 分，
           * 跟封面第一句「答對者每題給 3 分」一致，不需要另外開特例。
           *
           * 驗算（n=5、題分 3）：k=0 → 3 分；k=1 → 1.8 分；k=2 → 0.6 分；k≥3 → 0 分。
           */
          var optionCount = Number(record && record.optionCount);
          if (!isFinite(optionCount) || optionCount <= 0) optionCount = 5;
          var missed = Number(verdict && verdict.missCount) || 0;        // 該選卻沒選
          var wrongPicked = Number(verdict && verdict.wrongPickCount) || 0; // 不該選卻選了
          var badJudgements = missed + wrongPicked;
          score += Math.max(0, ((optionCount - 2 * badJudgements) / optionCount) * points);
        } else {
          score -= points / 3;                    // 單選答錯倒扣 1/3 題分
        }
      }
      // moex-no-deduct：答錯不扣分，什麼都不做
    });

    var answeredCount = correct + wrong;
    var fullScore = Number(spec && spec.sectionFullScore);
    if (!isFinite(fullScore) || fullScore <= 0) {
      fullScore = list.reduce(function (sum, record) {
        return sum + (record && record.type === 'multi' ? multiPoints : singlePoints);
      }, 0);
    }

    return {
      scoring: rule,
      score: Math.round(score * 100) / 100,
      fullScore: Math.round(fullScore * 100) / 100,
      correct: correct,
      wrong: wrong,
      blank: blank,
      total: list.length,
      accuracy: answeredCount === 0 ? 0 : Math.round((correct / answeredCount) * 100),
      essayExcluded: rule === 'moex-no-deduct'   // 刑事三等要標明申論題未計入
    };
  }

  // ============================================================
  // 進度匯出與匯入
  // ============================================================

  /** 匯出的檔名：刷題進度_YYYYMMDD.json（台北時間） */
  function exportFileName(todayISO) {
    var text = String(todayISO || '').replace(/-/g, '');
    return '刷題進度_' + (text || '未知日期') + '.json';
  }

  /** 看一眼匯入的檔案是什麼：幾月幾日的、裡面有幾題紀錄 */
  function describeProgressFile(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: '這個檔案看起來不是刷題進度檔。' };
    }
    var questions = data.questions;
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
      return { ok: false, reason: '這個檔案裡沒有作答紀錄，可能不是刷題進度檔。' };
    }
    var ids = Object.keys(questions);
    var latest = null;
    ids.forEach(function (id) {
      var when = questions[id] && questions[id].lastAnsweredAt;
      if (when && (!latest || when > latest)) latest = when;
    });
    return {
      ok: true,
      questionCount: ids.length,
      savedAt: data.updatedAt || null,
      lastAnsweredAt: latest,
      noteCount: Object.keys(data.notes || {}).length,
      draftCount: Object.keys(data.drafts || {}).length,
      staleFlagCount: Object.keys(data.staleFlags || {}).length
    };
  }

  /** 兩筆同一題的紀錄，挑比較新的那一筆（沒有日期的算舊的） */
  function newerEntry(a, b) {
    if (!a) return b;
    if (!b) return a;
    var da = String(a.lastAnsweredAt || '');
    var db = String(b.lastAnsweredAt || '');
    if (da === db) {
      // 同一天作答，就留作答次數比較多的那一筆
      var ta = (Number(a.correctCount) || 0) + (Number(a.wrongCount) || 0);
      var tb = (Number(b.correctCount) || 0) + (Number(b.wrongCount) || 0);
      return tb > ta ? b : a;
    }
    return db > da ? b : a;
  }

  /**
   * 合併兩份進度（匯入預設走這條，不是覆蓋）。
   * 覆蓋一按下去就回不來，對只存本機、沒有雲端備份的資料太危險。
   * 規則：同一題以「最後作答日比較新」的那一筆為準；筆記、草稿、過時標記取聯集。
   */
  function mergeProgress(current, incoming) {
    var base = current && typeof current === 'object' ? current : {};
    var add = incoming && typeof incoming === 'object' ? incoming : {};
    var result = {};
    Object.keys(base).forEach(function (key) { result[key] = base[key]; });

    var merged = {};
    var mine = base.questions || {};
    var theirs = add.questions || {};
    var stats = { added: 0, updated: 0, kept: 0 };

    Object.keys(mine).forEach(function (id) { merged[id] = mine[id]; });
    Object.keys(theirs).forEach(function (id) {
      if (!merged[id]) {
        merged[id] = theirs[id];
        stats.added += 1;
        return;
      }
      var winner = newerEntry(merged[id], theirs[id]);
      if (winner === theirs[id]) {
        merged[id] = theirs[id];
        stats.updated += 1;
      } else {
        stats.kept += 1;
      }
    });
    result.questions = merged;

    // 筆記、草稿、過時標記取聯集；同一題兩邊都有時，留現在這台的（使用者正在用的）
    ['notes', 'drafts', 'staleFlags'].forEach(function (field) {
      var pool = {};
      Object.keys(add[field] || {}).forEach(function (id) { pool[id] = add[field][id]; });
      Object.keys(base[field] || {}).forEach(function (id) { pool[id] = base[field][id]; });
      result[field] = pool;
    });

    // 設定留現在這台的，沒有才用匯入的
    result.settings = base.settings && Object.keys(base.settings).length
      ? base.settings : (add.settings || {});

    return { progress: result, stats: stats };
  }

  /** 距今幾天（用在「上次備份：X 天前」） */
  function daysSince(iso, todayISO) {
    var diff = daysBetweenISO(iso, todayISO);
    return diff === null ? null : diff;
  }

  /** 本回練習的成績統計 */
  function summarizeSession(records) {
    var list = Array.isArray(records) ? records : [];
    var correct = list.filter(function (item) { return item && item.correct; }).length;
    var total = list.length;
    return {
      total: total,
      correct: correct,
      wrong: total - correct,
      accuracy: total === 0 ? 0 : Math.round((correct / total) * 100)
    };
  }

  /** 全部進度的統計（首頁用） */
  function summarizeProgress(progress) {
    var questions = progress && progress.questions && typeof progress.questions === 'object'
      ? progress.questions : {};
    var answeredCount = 0;
    var correctTotal = 0;
    var wrongTotal = 0;
    var lastAnsweredAt = null;

    Object.keys(questions).forEach(function (id) {
      var entry = questions[id] || {};
      var correct = Number(entry.correctCount) || 0;
      var wrong = Number(entry.wrongCount) || 0;
      if (correct + wrong > 0) answeredCount += 1;
      correctTotal += correct;
      wrongTotal += wrong;
      if (entry.lastAnsweredAt && (!lastAnsweredAt || entry.lastAnsweredAt > lastAnsweredAt)) {
        lastAnsweredAt = entry.lastAnsweredAt;
      }
    });

    var times = correctTotal + wrongTotal;
    return {
      answeredCount: answeredCount,  // 刷過的題數（不重複計）
      correctTotal: correctTotal,    // 累計答對次數
      wrongTotal: wrongTotal,        // 累計答錯次數
      answerTimes: times,            // 累計作答次數
      accuracy: times === 0 ? 0 : Math.round((correctTotal / times) * 100),
      lastAnsweredAt: lastAnsweredAt
    };
  }

  // ============================================================
  // 題目上的各種提示
  // ============================================================

  /**
   * 修法時效提示。staleRisk 的 level 是「高」或「中」才提示，「無」不吵人。
   * 只提示、不自動排除題目（依 docs/題庫格式.md）。
   */
  function staleNotice(question) {
    var risk = question && question.staleRisk;
    if (!risk || (risk.level !== '高' && risk.level !== '中')) return null;

    /*
     * 盡量講具體：「這題涉及的洗錢防制法在 113 年修正過」比「可能過時」有用得多。
     * 建置器之後會把 detail 補上（法規名稱＋修正日期），欄位名稱可能叫 law/name/法規、
     * amendedAt/amendedOn/revisedAt/date/修正日期，這裡全部都接受，
     * 接不到就退回只列法規名稱，再接不到就退回一般提示，不會因為格式變動就壞掉。
     */
    var pieces = [];
    var abandonedLaws = [];
    var detail = risk.detail || risk.details || risk.hits;

    if (Array.isArray(detail)) {
      detail.forEach(function (item) {
        if (!item) return;
        if (typeof item === 'string') { pieces.push(item); return; }
        var law = item.law || item.name || item['法規'] || item.title;
        if (!law) return;

        // 法規已經廢止：這題的答案幾乎一定不能用了，要單獨講
        if (item.abandoned === true) {
          abandonedLaws.push(String(law));
          return;
        }

        // 出題之後修正過的日期（建置器給的是清單，可能好幾次）
        var dates = Array.isArray(item.modifiedAfter) ? item.modifiedAfter.filter(Boolean) : [];
        var count = Number(item.changeCount) || dates.length;
        var single = item.amendedAt || item.amendedOn || item.revisedAt || item.revisedDate ||
          item.date || item['修正日期'] || item.year || item['修正年'];

        /*
         * 有條號就講得更具體：「刑法第 339-4 條在 113-07-31 修正過」。
         * 欄位名以建置器寫進 docs/題庫格式.md 的為準，接不到就只講法規名。
         */
        var articleField = item.articles || item.article || item.articleNos ||
          item['條號'] || item['條文'];
        var articleList = Array.isArray(articleField) ? articleField.filter(Boolean)
          : (articleField ? [articleField] : []);
        if (articleList.length > 0) {
          var shown = articleList.slice(0, 3).map(function (no) {
            var text = String(no).trim();
            return /^第/.test(text) ? text : formatArticleKey(normalizeArticleKey(text) || text);
          });
          law = law + shown.join('、') + (articleList.length > 3 ? ' 等條文' : '');
        }

        if (dates.length > 1) {
          pieces.push(law + '在出題後修正過 ' + count + ' 次（最近 ' + dates[dates.length - 1] + '）');
        } else if (dates.length === 1) {
          pieces.push(law + '在 ' + dates[0] + ' 修正過');
        } else if (single) {
          // 中文排版：數字結尾要補半形空格，「113 年」這種已經是中文結尾就不用
          var whenText = String(single);
          var tail = /[0-9A-Za-z]$/.test(whenText) ? ' ' : '';
          pieces.push(law + '在 ' + whenText + tail + '修正過');
        } else {
          pieces.push(String(law));
        }
      });
    }
    if (pieces.length === 0 && abandonedLaws.length === 0) {
      var laws = Array.isArray(risk.laws) ? risk.laws.filter(Boolean) : [];
      laws.forEach(function (law) { pieces.push(String(law)); });
    }

    var text;
    if (abandonedLaws.length > 0) {
      text = '這題依據的' + abandonedLaws.join('、') + '已經廢止，這題的答案已經不能用了';
      if (pieces.length > 0) text += '；另外' + pieces.join('、');
    } else if (pieces.length > 0) {
      text = '這題涉及的' + pieces.join('、') + '，答案僅供參考';
    } else {
      text = '這題涉及的法規已修正，答案僅供參考';
    }
    return { level: risk.level, text: text, abandoned: abandonedLaws.length > 0 };
  }

  /**
   * 把一題命中的法規整理出來，給「查看相關法條」用。
   * 建置器之後會補 lawCode；在那之前用法規名稱去法規清單裡對，一樣找得到。
   * @returns {Array} [{ law, lawCode, abandoned, modifiedAfter, matched }]
   */
  function staleLawRefs(question) {
    var risk = (question && question.staleRisk) || {};
    var detail = risk.detail || risk.details || risk.hits;
    var refs = [];

    if (Array.isArray(detail)) {
      detail.forEach(function (item) {
        if (!item) return;
        if (typeof item === 'string') { refs.push({ law: item }); return; }
        var law = item.law || item.name || item['法規'] || item.title;
        if (!law) return;
        refs.push({
          law: String(law),
          lawCode: item.lawCode || item.code || null,
          abandoned: item.abandoned === true,
          modifiedAfter: Array.isArray(item.modifiedAfter) ? item.modifiedAfter : [],
          matched: item.matched || null
        });
      });
    }
    if (refs.length === 0 && Array.isArray(risk.laws)) {
      risk.laws.filter(Boolean).forEach(function (law) { refs.push({ law: String(law) }); });
    }
    return refs;
  }

  /**
   * 舊題提示：104 年以前的題目，法規與實務見解大多已經變動。
   * 建置器之後會補上標記，但這裡自己用年度判斷，不等資料也能用。
   */
  function oldQuestionNotice(question) {
    var risk = (question && question.staleRisk) || {};
    var flagged = risk.old === true || risk.oldQuestion === true || risk.level === '舊題' ||
      question.oldQuestion === true;
    var year = Number(question && question.year);
    if (!flagged && !(isFinite(year) && year > 0 && year <= 104)) return null;
    return '這是 ' + (isFinite(year) && year > 0 ? year + ' 年' : '104 年以前') +
      '的舊題，法規與實務見解可能已經變動，請以現行規定為準';
  }

  /** 使用者自己標記過時的提示 */
  function userStaleNotice(progress, questionId) {
    var flags = (progress && progress.staleFlags) || {};
    var flag = flags[questionId];
    if (!flag) return null;
    var when = typeof flag === 'object' && flag.at ? flag.at : null;
    return '你把這題標記成已過時' + (when ? ('（' + when + '）') : '') + '，正解僅供參考。';
  }

  /** 科目對應提示。mappingLevel 是「部分」時提醒出題範圍有差異 */
  function mappingNotice(question) {
    var level = question && question.mappingLevel;
    if (level === '部分') return '這科的出題範圍與現行考試已有差異';
    if (level === '停考') return '這是停考科目的舊題，現行考試已經不考這一科';
    return null;
  }

  /**
   * 官方釋疑更正提示。
   * 只有真的寫了更正內容（revisionNote）才提示：建置器會把整份採用更正版答案的題目
   * 都標成 revised，光憑這個標記提示會變成每一題都跳一行廢話。
   */
  function revisionNotice(question) {
    if (!question || !question.revised) return null;
    var note = question.revisionNote ? String(question.revisionNote).trim() : '';
    return note ? ('官方釋疑更正：' + note) : null;
  }

  return {
    ALL_LETTERS: ALL_LETTERS,
    OPTION_COUNT: OPTION_COUNT,
    typeLabel: typeLabel,
    yearLabel: yearLabel,
    normalizeGroup: normalizeGroup,
    inspectQuestion: inspectQuestion,
    inspectBank: inspectBank,
    judge: judge,
    formatGroups: formatGroups,
    filterByYear: filterByYear,
    collectYears: collectYears,
    shuffle: shuffle,
    toTaipeiDateString: toTaipeiDateString,
    toTaipeiStampString: toTaipeiStampString,
    loadErrorText: loadErrorText,
    classifyLoadError: classifyLoadError,
    storageErrorText: storageErrorText,
    makeProgressEntry: makeProgressEntry,
    applyAnswerToProgress: applyAnswerToProgress,
    summarizeSession: summarizeSession,
    summarizeProgress: summarizeProgress,
    staleNotice: staleNotice,
    staleLawRefs: staleLawRefs,
    oldQuestionNotice: oldQuestionNotice,

    // 主題統計
    UNTAGGED: UNTAGGED,
    LOW_CONFIDENCE_MIN: LOW_CONFIDENCE_MIN,
    topicsOf: topicsOf,
    readTopicTotals: readTopicTotals,
    topicStats: topicStats,
    subjectStats: subjectStats,
    pickTopicQuestions: pickTopicQuestions,
    essayTopicStats: essayTopicStats,
    filterByTopic: filterByTopic,

    // 法條速查
    normalizeArticleKey: normalizeArticleKey,
    formatArticleKey: formatArticleKey,
    parseLawQuery: parseLawQuery,
    listLaws: listLaws,
    groupLawsByCategory: groupLawsByCategory,
    searchLawList: searchLawList,
    searchArticles: searchArticles,
    findLawCode: findLawCode,

    userStaleNotice: userStaleNotice,
    mappingNotice: mappingNotice,
    revisionNotice: revisionNotice,

    // 間隔重複
    BOX_INTERVALS: BOX_INTERVALS,
    MAX_BOX: MAX_BOX,
    DEFAULT_DAILY_LIMIT: DEFAULT_DAILY_LIMIT,
    DEFAULT_STREAK_THRESHOLD: DEFAULT_STREAK_THRESHOLD,
    EXAM_BUFFER_DAYS: EXAM_BUFFER_DAYS,
    intervalForBox: intervalForBox,
    isGraduated: isGraduated,
    outcomeOf: outcomeOf,
    nextBox: nextBox,
    addDaysISO: addDaysISO,
    daysBetweenISO: daysBetweenISO,
    daysSince: daysSince,
    pickExamDateISO: pickExamDateISO,
    capIntervalDays: capIntervalDays,
    scheduleNext: scheduleNext,

    // 到期題與錯題本
    isDue: isDue,
    isInWrongBook: isInWrongBook,
    summarizeStudyState: summarizeStudyState,
    pickDueQuestions: pickDueQuestions,
    pickWrongBookQuestions: pickWrongBookQuestions,
    excludeStaleFlagged: excludeStaleFlagged,

    // 模擬整卷
    parsePointsPerQuestion: parsePointsPerQuestion,
    parseSectionFullScore: parseSectionFullScore,
    scorePaper: scorePaper,

    // 匯出匯入
    exportFileName: exportFileName,
    describeProgressFile: describeProgressFile,
    mergeProgress: mergeProgress,

    // AI 詳解
    buildExplainPrompt: buildExplainPrompt,
    aiErrorText: aiErrorText,
    AI_DISCLAIMER: AI_DISCLAIMER,
    EXPLAIN_REASKED_NOTICE: EXPLAIN_REASKED_NOTICE,
    questionFingerprint: questionFingerprint,
    explainCacheVerdict: explainCacheVerdict
  };
}());

/* 讓 Node 也能載入這支檔案做離線驗證（瀏覽器端完全不受影響） */
if (typeof module === 'object' && module && module.exports) {
  module.exports = PQPure;
}
