/*
 * app.js — 畫面主程式（製作人Rui / Maker Rui）
 *
 * 負責畫面切換、首頁、設定、三種練習模式（隨機練習／今天該複習的／錯題本）、
 * 進度匯出匯入、AI 詳解按鈕、過時標記。
 * 模擬整卷在 exam.js、申論題在 essay.js，它們共用這裡提供的 PQApp 小工具。
 *
 * 分層規矩（不可打破）：
 *   core.js    只做判斷與計算，不碰畫面、不碰儲存、不連網路
 *   storage.js 全 App 只有它碰 localStorage
 *   bank.js    全 App 只有它抓題庫
 *   explain.js 全 App 只有它問 AI
 *   app.js     只做畫面
 *
 * 【改版檢查清單】改功能時這幾個地方要一起看：
 *   1. 這支檔案的 APP_VERSION
 *   2. sw.js 的 SHELL_CACHE（版本號要一起進位，否則手機會吃到舊版）
 *   3. 使用說明.html（使用者看得到的說明要跟程式行為一致）
 *   4. self-test.html（判題或排程規則有改就要補測試情境）
 */

var PQApp = (function () {
  'use strict';

  var APP_VERSION = 'v2.1';

  function $(id) { return document.getElementById(id); }

  /** 建元素並塞文字（一律用 textContent，題庫內容絕不當 HTML 解讀） */
  function makeEl(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  var el = {
    headSub: $('head-sub'),
    globalNotice: $('global-notice'),

    // 首頁
    statDue: $('stat-due'),
    statWrong: $('stat-wrong'),
    statKnown: $('stat-known'),
    examCountdown: $('exam-countdown'),
    backupReminder: $('backup-reminder'),
    modeRandom: $('mode-random'),
    modeDue: $('mode-due'),
    modeDueDesc: $('mode-due-desc'),
    modeWrong: $('mode-wrong'),
    modeWrongDesc: $('mode-wrong-desc'),
    modeExam: $('mode-exam'),
    modeEssay: $('mode-essay'),
    statAnswered: $('stat-answered'),
    statTimes: $('stat-times'),
    statAccuracy: $('stat-accuracy'),
    progressNote: $('progress-note'),
    exportBtn: $('export-btn'),
    importBtn: $('import-btn'),
    importFile: $('import-file'),
    settingsBtn: $('settings-btn'),
    updateBtn: $('update-btn'),
    offlineNote: $('offline-note'),
    versionNote: $('version-note'),

    // 練習範圍
    subjectSelect: $('subject-select'),
    yearFrom: $('year-from'),
    yearTo: $('year-to'),
    poolInfo: $('pool-info'),
    bankWarning: $('bank-warning'),
    startBtn: $('start-btn'),
    setupBackBtn: $('setup-back-btn'),

    // 刷題
    quizCounter: $('quiz-counter'),
    quizScore: $('quiz-score'),
    questionTags: $('question-tags'),
    questionSession: $('question-session'),
    questionNotices: $('question-notices'),
    questionStem: $('question-stem'),
    optionList: $('option-list'),
    resultBox: $('result-box'),
    afterAnswer: $('after-answer'),
    askAiBtn: $('ask-ai-btn'),
    staleBtn: $('stale-btn'),
    aiBox: $('ai-box'),
    questionId: $('question-id'),
    finishBtn: $('finish-btn'),

    // 本回成績
    doneTotal: $('done-total'),
    doneCorrect: $('done-correct'),
    doneAccuracy: $('done-accuracy'),
    doneNote: $('done-note'),
    againBtn: $('again-btn'),
    homeBtn: $('home-btn'),

    // 設定
    examDateCpu: $('exam-date-cpu'),
    examDateMoex: $('exam-date-moex'),
    examDateInfo: $('exam-date-info'),
    setThreshold: $('set-threshold'),
    setDaily: $('set-daily'),
    setYearSpan: $('set-yearspan'),
    aiProvider: $('ai-provider'),
    aiModel: $('ai-model'),
    aiKey: $('ai-key'),
    aiKeyHint: $('ai-key-hint'),
    aiSaveBtn: $('ai-save-btn'),
    aiClearBtn: $('ai-clear-btn'),
    aiCacheInfo: $('ai-cache-info'),
    aiClearCacheBtn: $('ai-clear-cache-btn'),
    settingsExportBtn: $('settings-export-btn'),
    settingsImportBtn: $('settings-import-btn'),
    backupInfo: $('backup-info'),
    staleCountInfo: $('stale-count-info'),
    staleClearBtn: $('stale-clear-btn'),
    settingsBackBtn: $('settings-back-btn'),

    bottomBar: $('bottom-bar'),
    actionBtn: $('action-btn'),

    confirmMask: $('confirm-mask'),
    confirmTitle: $('confirm-title'),
    confirmBody: $('confirm-body'),
    confirmOk: $('confirm-ok'),
    confirmCancel: $('confirm-cancel')
  };

  var SCREENS = ['home', 'setup', 'quiz', 'done', 'exam-setup', 'exam', 'exam-result', 'essay', 'settings'];
  var SCREEN_TITLES = {
    home: '首頁', setup: '隨機練習', quiz: '練習中', done: '本回成績',
    'exam-setup': '模擬整卷', exam: '模擬作答中', 'exam-result': '模擬結果',
    essay: '申論題', settings: '設定'
  };

  var state = {
    progress: PQStore.makeEmptyProgress(),
    index: null,
    subjects: [],
    subject: null,        // 隨機練習目前選的科目
    mode: 'random',       // random / due / wrong
    pool: [],
    cursor: 0,
    picked: [],
    answered: false,
    records: [],
    storageWarned: false,
    updating: false,
    subjectSeq: 0,
    aiBusy: false
  };

  /* ================= 共用小工具 ================= */

  var noticeSource = null;

  function showNotice(message, kind, source) {
    el.globalNotice.className = 'notice' +
      (kind === 'soft' ? ' notice-soft' : '') +
      (kind === 'error' ? ' notice-error' : '') +
      (kind === 'good' ? ' notice-good' : '');
    el.globalNotice.textContent = message;
    el.globalNotice.classList.remove('hidden');
    noticeSource = source || null;
    window.scrollTo(0, 0);
  }

  function clearNotice(source) {
    if (source && noticeSource !== source) return;
    el.globalNotice.textContent = '';
    el.globalNotice.classList.add('hidden');
    noticeSource = null;
  }

  function showScreen(name) {
    SCREENS.forEach(function (key) {
      var node = $('screen-' + key);
      if (node) node.classList.toggle('hidden', key !== name);
    });
    var withBar = (name === 'quiz');
    el.bottomBar.classList.toggle('hidden', !withBar);
    document.body.classList.toggle('has-bottom-bar', withBar);
    el.headSub.textContent = SCREEN_TITLES[name] || '';
    window.scrollTo(0, 0);
  }

  /** 台北時間的今天 */
  function todayText() {
    return PQPure.toTaipeiDateString(new Date());
  }

  function settings() {
    return state.progress.settings || PQStore.defaultSettings();
  }

  function saveProgressQuietly() {
    var result = PQStore.saveProgress(state.progress);
    if (!result.ok && !state.storageWarned) {
      state.storageWarned = true;
      showNotice(result.error, 'error', 'storage');
    }
    return result.ok;
  }

  /**
   * 確認對話框。回不去的動作（覆蓋進度、清除標記）一定要再問一次。
   * @returns {Promise<boolean>}
   */
  function confirmDialog(title, bodyNode, okText) {
    return new Promise(function (resolve) {
      el.confirmTitle.textContent = title;
      el.confirmBody.textContent = '';
      if (typeof bodyNode === 'string') {
        el.confirmBody.appendChild(makeEl('p', null, bodyNode));
      } else if (bodyNode) {
        el.confirmBody.appendChild(bodyNode);
      }
      el.confirmOk.textContent = okText || '確定';
      el.confirmMask.classList.remove('hidden');

      var finish = function (answer) {
        el.confirmMask.classList.add('hidden');
        el.confirmOk.removeEventListener('click', onOk);
        el.confirmCancel.removeEventListener('click', onCancel);
        resolve(answer);
      };
      var onOk = function () { finish(true); };
      var onCancel = function () { finish(false); };
      el.confirmOk.addEventListener('click', onOk);
      el.confirmCancel.addEventListener('click', onCancel);
    });
  }

  /* ================= 首頁 ================= */

  function renderHome() {
    var today = todayText();
    var set = settings();
    var study = PQPure.summarizeStudyState(state.progress, today, set.streakThreshold);
    var summary = PQPure.summarizeProgress(state.progress);

    el.statDue.textContent = String(study.due);
    el.statWrong.textContent = String(study.wrongBook);
    el.statKnown.textContent = String(study.graduated);

    el.modeDueDesc.textContent = study.due > 0
      ? ('今天有 ' + study.due + ' 題到期，先出比較不熟的')
      : '今天沒有到期的題目，先去隨機練習吧';
    el.modeWrongDesc.textContent = study.wrongBook > 0
      ? ('目前有 ' + study.wrongBook + ' 題在錯題本裡')
      : '錯題本是空的';
    el.modeDue.disabled = study.due === 0;
    el.modeWrong.disabled = study.wrongBook === 0;

    // 距考試天數
    var dates = set.examDates || {};
    var parts = [];
    Object.keys(dates).forEach(function (name) {
      var left = PQPure.daysBetweenISO(today, dates[name]);
      if (left === null) return;
      parts.push(left >= 0 ? ('距' + name + ' ' + left + ' 天') : (name + '已經考完'));
    });
    el.examCountdown.textContent = parts.length
      ? parts.join('　') : '還沒設定考試日期，可以到設定頁填。';

    el.statAnswered.textContent = String(summary.answeredCount);
    el.statTimes.textContent = String(summary.answerTimes);
    el.statAccuracy.textContent = summary.answerTimes === 0 ? '—' : (summary.accuracy + '%');

    var note = '進度只存在這台裝置的瀏覽器裡，沒有雲端備份。';
    if (summary.lastAnsweredAt) note = '上次作答：' + summary.lastAnsweredAt + '。' + note;
    if (!PQStore.isAvailable()) note = '這個瀏覽器不能儲存資料，作答紀錄不會被記住。' + note;
    el.progressNote.textContent = note;

    renderBackupReminder();
  }

  function renderBackupReminder() {
    var lastExport = (state.progress.backup || {}).lastExportAt;
    var days = lastExport ? PQPure.daysSince(lastExport, todayText()) : null;

    if (days === null) {
      el.backupReminder.className = 'notice notice-soft';
      el.backupReminder.textContent = '還沒備份過進度。進度只存在這台裝置，建議現在匯出一份放雲端硬碟。';
      el.backupReminder.classList.remove('hidden');
      return;
    }
    if (days >= 7) {
      el.backupReminder.className = 'notice';
      el.backupReminder.textContent = '上次備份是 ' + days + ' 天前，建議再匯出一份。';
      el.backupReminder.classList.remove('hidden');
      return;
    }
    el.backupReminder.className = 'notice notice-soft';
    el.backupReminder.textContent = '上次備份：' + (days === 0 ? '今天' : days + ' 天前');
    el.backupReminder.classList.remove('hidden');
  }

  /* ================= 練習範圍（隨機練習） ================= */

  function fillSelect(select, values, selectedValue, labelFn) {
    select.textContent = '';
    values.forEach(function (value) {
      var option = document.createElement('option');
      option.value = String(value);
      option.textContent = labelFn ? labelFn(value) : String(value);
      if (String(value) === String(selectedValue)) option.selected = true;
      select.appendChild(option);
    });
  }

  function renderSubjectOptions() {
    var set = settings();
    var saved = set.lastSubject;
    var hasSaved = state.subjects.some(function (item) { return item.code === saved; });
    var selected = hasSaved ? saved : (state.subjects[0] ? state.subjects[0].code : '');

    el.subjectSelect.textContent = '';
    state.subjects.forEach(function (item) {
      var option = document.createElement('option');
      option.value = item.code;
      option.textContent = item.name + '（' + item.count + ' 題）';
      if (item.code === selected) option.selected = true;
      el.subjectSelect.appendChild(option);
    });
  }

  /** 年度下拉：預設挑「近 N 年」（使用者可在設定頁改，預設近 5 年） */
  function renderYearOptions(years) {
    var set = settings();
    var span = Number(set.yearSpan);
    var newest = years[years.length - 1];
    var defaultFrom = years[0];
    if (isFinite(span) && span > 0) {
      var wanted = newest - span + 1;
      defaultFrom = years.filter(function (y) { return y >= wanted; })[0];
      if (defaultFrom === undefined) defaultFrom = years[0];
    }

    var saved = set.lastYears || {};
    var mine = saved[el.subjectSelect.value];
    var from = mine && years.indexOf(Number(mine.from)) !== -1 ? Number(mine.from) : defaultFrom;
    var to = mine && years.indexOf(Number(mine.to)) !== -1 ? Number(mine.to) : newest;
    if (from > to) { from = defaultFrom; to = newest; }

    fillSelect(el.yearFrom, years, from, PQPure.yearLabel);
    fillSelect(el.yearTo, years, to, PQPure.yearLabel);
  }

  function selectedYearRange() {
    return { from: Number(el.yearFrom.value), to: Number(el.yearTo.value) };
  }

  function rememberRange() {
    var set = settings();
    set.lastSubject = el.subjectSelect.value;
    set.lastYears = set.lastYears || {};
    var range = selectedYearRange();
    set.lastYears[el.subjectSelect.value] = { from: range.from, to: range.to };
    state.progress.settings = set;
    saveProgressQuietly();
  }

  function currentPoolQuestions() {
    if (!state.subject) return [];
    var range = selectedYearRange();
    var pool = PQPure.filterByYear(state.subject.questions, range.from, range.to);
    return PQPure.excludeStaleFlagged(pool, state.progress);
  }

  function renderPoolInfo() {
    if (!state.subject) {
      el.poolInfo.textContent = '請先選擇科目。';
      el.startBtn.disabled = true;
      return;
    }
    var pool = currentPoolQuestions();
    var range = selectedYearRange();
    var rangeText = range.from === range.to
      ? PQPure.yearLabel(range.from)
      : PQPure.yearLabel(range.from) + ' 到 ' + PQPure.yearLabel(range.to);

    if (pool.length === 0) {
      el.poolInfo.textContent = '「' + state.subject.name + '」在 ' + rangeText + '沒有可練習的題目，請換一個年度範圍。';
      el.startBtn.disabled = true;
    } else {
      el.poolInfo.textContent = '「' + state.subject.name + '」' + rangeText +
        '，這個範圍可以練習 ' + pool.length + ' 題。';
      el.startBtn.disabled = false;
    }

    var broken = state.subject.broken || [];
    if (broken.length === 0) {
      el.bankWarning.classList.add('hidden');
      el.bankWarning.textContent = '';
    } else {
      var ids = broken.slice(0, 5).map(function (item) { return item.id; }).join('、');
      if (broken.length > 5) ids += ' 等';
      el.bankWarning.textContent = '這一科有 ' + broken.length + ' 題的正解資料有問題，已經先跳過不出題（' +
        ids + '）。詳細原因可以開「自我檢查」頁查看。';
      el.bankWarning.classList.remove('hidden');
    }
  }

  function loadSelectedSubject() {
    var code = el.subjectSelect.value;
    if (!code) return Promise.resolve();

    state.subjectSeq += 1;
    var mySeq = state.subjectSeq;
    var isStale = function () { return mySeq !== state.subjectSeq; };

    el.startBtn.disabled = true;
    el.poolInfo.textContent = '正在載入題庫…';

    return PQBank.loadSubject(code).then(function (subject) {
      if (isStale()) return;
      state.subject = subject;
      var years = PQPure.collectYears(subject.questions);
      if (years.length === 0) {
        el.poolInfo.textContent = '「' + subject.name + '」沒有可以練習的題目。';
        return;
      }
      renderYearOptions(years);
      renderPoolInfo();
      rememberRange();
      clearNotice('bank');
    }).catch(function (error) {
      if (isStale()) return;
      state.subject = null;
      el.poolInfo.textContent = '這一科的題庫沒有載入成功。';
      el.startBtn.disabled = true;
      showNotice(error && error.message ? error.message : '題庫載入失敗，請稍後再試一次。', 'error', 'bank');
    });
  }

  /* ================= 到期複習與錯題本 ================= */

  /** 把需要的科目一次載進來（只載有需要的那幾科，不是整包） */
  function loadSubjectsByCodes(codes) {
    var jobs = codes.map(function (code) {
      return PQBank.loadSubject(code).catch(function (error) {
        if (window.console && console.warn) console.warn('[題庫] 載入 ' + code + ' 失敗', error);
        return null;
      });
    });
    return Promise.all(jobs).then(function (list) {
      return list.filter(Boolean);
    });
  }

  /** 進度裡出現過的科目代號（舊紀錄可能沒有，會另外提醒） */
  function codesInProgress(filterFn) {
    var questions = state.progress.questions || {};
    var codes = {};
    var unknown = 0;
    Object.keys(questions).forEach(function (id) {
      var entry = questions[id];
      if (!filterFn(entry)) return;
      if (entry && entry.sc) { codes[entry.sc] = true; } else { unknown += 1; }
    });
    return { codes: Object.keys(codes), unknown: unknown };
  }

  function startSpecialMode(mode) {
    var today = todayText();
    var set = settings();
    var filter = mode === 'due'
      ? function (entry) { return PQPure.isDue(entry, today); }
      : function (entry) { return PQPure.isInWrongBook(entry, set.streakThreshold); };

    var found = codesInProgress(filter);
    if (found.codes.length === 0) {
      showNotice(found.unknown > 0
        ? '有 ' + found.unknown + ' 題舊紀錄沒有記到科目，沒辦法直接叫出來。請先用隨機練習刷過一次，之後就會自動補上。'
        : '現在沒有符合的題目。', 'error', 'mode');
      return;
    }

    showNotice('正在準備題目…', 'soft', 'mode');
    loadSubjectsByCodes(found.codes).then(function (subjects) {
      var all = [];
      subjects.forEach(function (subject) {
        subject.questions.forEach(function (question) { all.push(question); });
      });
      all = PQPure.excludeStaleFlagged(all, state.progress);

      var pool = mode === 'due'
        ? PQPure.pickDueQuestions(all, state.progress, today, set.dailyLimit)
        : PQPure.pickWrongBookQuestions(all, state.progress, set.streakThreshold);

      if (pool.length === 0) {
        showNotice('現在沒有符合的題目可以練習。', 'error', 'mode');
        return;
      }
      clearNotice('mode');
      state.mode = mode;
      state.subject = null;
      state.pool = pool;            // 到期題與錯題本照排序出題，不洗牌
      state.cursor = 0;
      state.records = [];
      showScreen('quiz');
      renderQuestion();

      if (found.unknown > 0) {
        showNotice('另外有 ' + found.unknown + ' 題舊紀錄沒有記到科目，這一輪沒有包含進來。', 'soft', 'mode');
      }
    }).catch(function (error) {
      showNotice(error && error.message ? error.message : '題目準備失敗，請稍後再試。', 'error', 'mode');
    });
  }

  /* ================= 刷題 ================= */

  function currentQuestion() {
    return state.pool[state.cursor] || null;
  }

  function startRandomRound() {
    var pool = currentPoolQuestions();
    if (pool.length === 0) {
      showNotice('這個年度範圍沒有題目可以練習，請換一個範圍。', 'error', 'bank');
      return;
    }
    state.mode = 'random';
    state.pool = PQPure.shuffle(pool);
    state.cursor = 0;
    state.records = [];
    clearNotice('bank');
    showScreen('quiz');
    renderQuestion();
  }

  function renderQuestion() {
    var question = currentQuestion();
    if (!question) { finishRound(); return; }

    state.picked = [];
    state.answered = false;
    window.scrollTo(0, 0);

    var modeName = state.mode === 'due' ? '今天該複習的'
      : (state.mode === 'wrong' ? '錯題本' : '隨機練習');
    el.quizCounter.textContent = modeName + '　第 ' + (state.cursor + 1) +
      ' 題 ／ 本回共 ' + state.pool.length + ' 題';
    renderScore();

    // 標籤：年度一定要顯示，20 年間法條改過很多次
    el.questionTags.textContent = '';
    el.questionTags.appendChild(makeEl('span', 'tag tag-year', PQPure.yearLabel(question.year)));
    el.questionTags.appendChild(makeEl('span', 'tag', PQPure.typeLabel(question.type)));
    if (question.subject) el.questionTags.appendChild(makeEl('span', 'tag', question.subject));
    if (question.originalSubject && question.originalSubject !== question.subject) {
      el.questionTags.appendChild(makeEl('span', 'tag', '原始科目：' + question.originalSubject));
    }
    if (question.language === 'en') el.questionTags.appendChild(makeEl('span', 'tag', '英文題'));

    var entry = (state.progress.questions || {})[question.id];
    if (entry && (Number(entry.correctCount) || 0) + (Number(entry.wrongCount) || 0) > 0) {
      var boxText = PQPure.isGraduated(entry.box) ? '已熟' : ('第 ' + (entry.box || 1) + ' 格');
      el.questionTags.appendChild(makeEl('span', 'tag tag-box',
        boxText + '｜對 ' + (entry.correctCount || 0) + '／錯 ' + (entry.wrongCount || 0)));
    }

    el.questionSession.textContent = question.session ? ('場次：' + question.session) : '';

    // 提示：使用者自己標的過時、修法時效、舊題、科目對應、官方釋疑
    el.questionNotices.textContent = '';
    var userStale = PQPure.userStaleNotice(state.progress, question.id);
    if (userStale) el.questionNotices.appendChild(makeEl('div', 'notice notice-error', userStale));
    var stale = PQPure.staleNotice(question);
    if (stale) el.questionNotices.appendChild(makeEl('div', 'notice', stale.text));
    var old = PQPure.oldQuestionNotice(question);
    if (old) el.questionNotices.appendChild(makeEl('div', 'notice', old));
    var mapping = PQPure.mappingNotice(question);
    if (mapping) el.questionNotices.appendChild(makeEl('div', 'notice', mapping));
    var revision = PQPure.revisionNotice(question);
    if (revision) el.questionNotices.appendChild(makeEl('div', 'notice notice-soft', revision));

    el.questionStem.textContent = question.stem || '（這一題沒有題幹）';
    el.questionId.textContent = '題號 ' + (question.id || '不明');
    el.resultBox.textContent = '';
    el.resultBox.className = '';
    el.afterAnswer.classList.add('hidden');
    el.aiBox.classList.add('hidden');
    el.aiBox.textContent = '';

    renderOptions(question);
    renderActionButton();
  }

  function renderScore() {
    var summary = PQPure.summarizeSession(state.records);
    el.quizScore.textContent = '答對 ' + summary.correct + ' ／ 答錯 ' + summary.wrong;
  }

  function renderOptions(question) {
    el.optionList.textContent = '';
    var report = PQPure.inspectQuestion(question);
    report.validLetters.forEach(function (letter) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'option';
      button.setAttribute('data-letter', letter);
      button.appendChild(makeEl('span', 'option-letter', letter));
      var text = makeEl('span', 'option-text', String(question.options[letter]));
      text.appendChild(makeEl('span', 'option-mark', ''));
      button.appendChild(text);
      button.addEventListener('click', function () { onOptionClick(letter); });
      el.optionList.appendChild(button);
    });
  }

  function optionButtons() {
    return Array.prototype.slice.call(el.optionList.querySelectorAll('.option'));
  }

  function onOptionClick(letter) {
    if (state.answered) return;
    var question = currentQuestion();
    if (!question) return;

    if (question.type === 'multi') {
      var at = state.picked.indexOf(letter);
      if (at === -1) { state.picked.push(letter); } else { state.picked.splice(at, 1); }
      refreshPickedLook();
      renderActionButton();
    } else {
      state.picked = [letter];
      refreshPickedLook();
      submitAnswer();
    }
  }

  function refreshPickedLook() {
    optionButtons().forEach(function (button) {
      var letter = button.getAttribute('data-letter');
      button.classList.toggle('picked', state.picked.indexOf(letter) !== -1);
    });
  }

  function renderActionButton() {
    var question = currentQuestion();
    if (!question) return;

    if (state.answered) {
      var isLast = state.cursor >= state.pool.length - 1;
      el.actionBtn.textContent = isLast ? '看本回成績' : '下一題';
      el.actionBtn.disabled = false;
      return;
    }
    if (question.type === 'multi') {
      el.actionBtn.textContent = state.picked.length === 0
        ? '請選擇選項（可複選）'
        : '送出答案（已選 ' + state.picked.length + ' 個）';
      el.actionBtn.disabled = state.picked.length === 0;
    } else {
      el.actionBtn.textContent = '請選一個選項';
      el.actionBtn.disabled = true;
    }
  }

  function submitAnswer() {
    var question = currentQuestion();
    if (!question || state.answered) return;

    var verdict = PQPure.judge(question, state.picked);
    state.answered = true;

    // 順序很重要：先把進度與下次複習日排好，再畫結果，
    // 否則結果框會顯示「上一次」的到期日（看起來像排程壞掉）
    recordAnswer(question, verdict);
    markOptions(question, verdict);
    renderResult(question, verdict);

    state.records.push({ id: question.id, correct: verdict.correct });
    renderScore();

    el.afterAnswer.classList.remove('hidden');
    el.staleBtn.textContent = (state.progress.staleFlags || {})[question.id]
      ? '取消過時標記' : '標記已過時';
    renderActionButton();
    scrollResultIntoView();
  }

  /** 把這次作答記進進度，並排好下次什麼時候再出現 */
  function recordAnswer(question, verdict) {
    var today = todayText();
    var set = settings();
    var code = state.subject ? state.subject.code : subjectCodeOf(question);
    var entries = state.progress.questions || {};
    var updated = PQPure.applyAnswerToProgress(entries[question.id], verdict.correct, today, code);

    var outcome = PQPure.outcomeOf(question, verdict);
    var targets = subjectTargets(code);
    var examISO = PQPure.pickExamDateISO(targets, set.examDates);
    var plan = PQPure.scheduleNext(entries[question.id], outcome, today, examISO);
    updated.box = plan.box;
    updated.dueAt = plan.dueAt;

    entries[question.id] = updated;
    state.progress.questions = entries;
    saveProgressQuietly();
  }

  /** 從索引查這一科對應哪幾場考試（決定要用哪個考試日壓縮） */
  function subjectTargets(code) {
    var found = state.subjects.filter(function (item) { return item.code === code; })[0];
    return found ? found.targets : [];
  }

  /** 題目屬於哪一科（用 subject 名稱反查代號，不去拆題號） */
  function subjectCodeOf(question) {
    var name = question && question.subject;
    var found = state.subjects.filter(function (item) { return item.name === name; })[0];
    return found ? found.code : null;
  }

  function markOptions(question, verdict) {
    var correctLetters = {};
    verdict.groups.forEach(function (group) {
      group.forEach(function (letter) { correctLetters[letter] = true; });
    });

    optionButtons().forEach(function (button) {
      var letter = button.getAttribute('data-letter');
      var mark = button.querySelector('.option-mark');
      button.disabled = true;
      button.classList.remove('picked');

      if (verdict.allCorrect) {
        if (state.picked.indexOf(letter) !== -1) {
          button.classList.add('correct');
          mark.textContent = '（你選的）';
        }
        return;
      }
      var isCorrect = correctLetters[letter] === true;
      var isPicked = state.picked.indexOf(letter) !== -1;
      if (isCorrect) {
        button.classList.add('correct');
        mark.textContent = isPicked ? '（正解・你選的）' : '（正解）';
      } else if (isPicked) {
        button.classList.add('wrong');
        mark.textContent = '（你選的）';
      }
    });
  }

  function renderResult(question, verdict) {
    el.resultBox.textContent = '';
    el.resultBox.className = 'result ' + (verdict.correct ? 'result-ok' : 'result-ng');
    el.resultBox.appendChild(makeEl('span', 'result-title', verdict.correct ? '答對了' : '答錯了'));

    if (verdict.allCorrect) {
      el.resultBox.appendChild(makeEl('span', 'answer-line', '本題官方公告一律給分'));
    } else if (verdict.undecidable) {
      el.resultBox.appendChild(makeEl('span', 'answer-line', '這題的正解資料有問題，沒辦法判定對錯'));
    } else {
      var answerText = PQPure.formatGroups(verdict.groups);
      el.resultBox.appendChild(makeEl('span', 'answer-line', '正解：' + answerText));
      if (verdict.groups.length === 2) {
        el.resultBox.appendChild(makeEl('span', 'result-sub', '本題是雙正解，' + answerText + ' 都算對。'));
      } else if (verdict.groups.length > 2) {
        el.resultBox.appendChild(makeEl('span', 'result-sub',
          '本題官方認定 ' + verdict.groups.length + ' 組答案都算對：' + answerText + '。'));
      }
      if (question.type === 'multi' && !verdict.correct) {
        el.resultBox.appendChild(makeEl('span', 'result-sub',
          '多選題要全部選對才算答對（這次對 ' + verdict.hitCount + ' 個、漏 ' +
          verdict.missCount + ' 個、多選 ' + verdict.wrongPickCount + ' 個）。'));
      }
    }

    // 下次什麼時候再出現
    var entry = (state.progress.questions || {})[question.id];
    if (entry && entry.dueAt) {
      var boxText = PQPure.isGraduated(entry.box)
        ? '已熟，' : ('第 ' + entry.box + ' 格，');
      el.resultBox.appendChild(makeEl('span', 'result-sub',
        '下次複習：' + entry.dueAt + '（' + boxText + '間隔重複排的）'));
    }

    var stale = PQPure.staleNotice(question);
    if (stale) {
      el.resultBox.appendChild(makeEl('span', 'result-sub', '提醒：' + stale.text + '，請以現行法條原文為準。'));
    }
  }

  function scrollResultIntoView() {
    try {
      var box = el.resultBox.getBoundingClientRect();
      var barHeight = el.bottomBar.offsetHeight || 0;
      var visibleBottom = window.innerHeight - barHeight - 12;
      if (box.bottom <= visibleBottom) return;
      var need = box.bottom - visibleBottom;
      var limit = Math.max(box.top - 12, 0);
      window.scrollBy(0, Math.min(need, limit));
    } catch (e) { /* 算不出來就不捲，不影響作答 */ }
  }

  function goNext() {
    if (!state.answered) return;
    if (state.cursor >= state.pool.length - 1) { finishRound(); return; }
    state.cursor += 1;
    renderQuestion();
  }

  function finishRound() {
    var summary = PQPure.summarizeSession(state.records);
    el.doneTotal.textContent = String(summary.total);
    el.doneCorrect.textContent = String(summary.correct);
    el.doneAccuracy.textContent = summary.total === 0 ? '—' : (summary.accuracy + '%');

    if (summary.total === 0) {
      el.doneNote.textContent = '這一回還沒有作答任何題目。';
    } else {
      var where = state.mode === 'due' ? '今天該複習的'
        : (state.mode === 'wrong' ? '錯題本' : ('科目：' + (state.subject ? state.subject.name : '不明')));
      el.doneNote.textContent = where + '，答錯 ' + summary.wrong + ' 題。進度已存在這台裝置。';
    }
    el.againBtn.classList.toggle('hidden', state.mode !== 'random');
    renderHome();
    showScreen('done');
  }

  /* ================= AI 詳解 ================= */

  function renderAiBox(content, kind) {
    el.aiBox.textContent = '';
    el.aiBox.className = 'ai-box ' + (kind || '');
    if (typeof content === 'string') {
      el.aiBox.appendChild(makeEl('p', 'ai-text', content));
    } else if (content) {
      el.aiBox.appendChild(content);
    }
    el.aiBox.classList.remove('hidden');
  }

  function askAi() {
    var question = currentQuestion();
    if (!question || state.aiBusy) return;

    var set = settings();
    var key = PQStore.loadAiKey();
    state.aiBusy = true;
    el.askAiBtn.disabled = true;
    renderAiBox('正在請 AI 講解，可能要等十幾秒…', 'ai-loading');

    PQExplain.ask(question, {
      key: key,
      provider: set.aiProvider,
      model: set.aiModel
    }).then(function (result) {
      var wrap = document.createElement('div');
      wrap.appendChild(makeEl('p', 'ai-head',
        result.fromCache ? '這題之前問過了（存在這台裝置，離線也看得到）' : 'AI 講解'));
      wrap.appendChild(makeEl('p', 'ai-text', result.text));
      wrap.appendChild(makeEl('p', 'ai-disclaimer', PQPure.AI_DISCLAIMER));
      renderAiBox(wrap, 'ai-ready');
    }).catch(function (error) {
      var message = error && error.message ? error.message : PQPure.aiErrorText('unknown');
      var wrap = document.createElement('div');
      wrap.appendChild(makeEl('p', 'ai-text', message));
      if (message.indexOf('金鑰') !== -1) {
        var go = makeEl('button', 'btn-text', '去設定頁貼金鑰');
        go.type = 'button';
        go.addEventListener('click', openSettings);
        wrap.appendChild(go);
      }
      renderAiBox(wrap, 'ai-error');
    }).then(function () {
      state.aiBusy = false;
      el.askAiBtn.disabled = false;
    });
  }

  /* ================= 過時標記 ================= */

  function toggleStaleFlag() {
    var question = currentQuestion();
    if (!question) return;
    var flags = state.progress.staleFlags || {};

    if (flags[question.id]) {
      delete flags[question.id];
      el.staleBtn.textContent = '標記已過時';
      showNotice('已取消這題的過時標記。', 'soft', 'stale');
    } else {
      flags[question.id] = { at: todayText() };
      el.staleBtn.textContent = '取消過時標記';
      showNotice('已標記這題為過時，之後練習不會再出現（設定頁可以清除）。', 'soft', 'stale');
    }
    state.progress.staleFlags = flags;
    saveProgressQuietly();
  }

  /* ================= 匯出與匯入 ================= */

  function exportProgress() {
    var today = todayText();
    var data = PQStore.buildExportData(state.progress, today);
    var fileName = PQPure.exportFileName(today);

    try {
      var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 5000);

      state.progress.backup = state.progress.backup || {};
      state.progress.backup.lastExportAt = today;
      saveProgressQuietly();
      renderBackupReminder();
      showNotice('已匯出「' + fileName + '」。建議把它放到雲端硬碟，換手機時才接得回來。', 'good', 'backup');
    } catch (e) {
      if (window.console && console.warn) console.warn('[匯出] 失敗', e);
      showNotice('匯出失敗，這個瀏覽器可能不允許下載檔案。請換用 Safari 或 Chrome 再試一次。', 'error', 'backup');
    }
  }

  function pickImportFile() {
    el.importFile.value = '';
    el.importFile.click();
  }

  function onImportFileChosen(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    // 讀完就把選檔欄位清空，不然連續挑同一個檔案第二次不會有反應
    window.setTimeout(function () { el.importFile.value = ''; }, 0);

    var reader = new FileReader();
    reader.onerror = function () {
      showNotice('這個檔案讀不起來，請確認是從這個 App 匯出的進度檔。', 'error', 'backup');
    };
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (e) {
        showNotice('這個檔案的內容不是有效的進度檔，可能已經壞掉或被改過。', 'error', 'backup');
        return;
      }
      var info = PQPure.describeProgressFile(data);
      if (!info.ok) {
        showNotice(info.reason, 'error', 'backup');
        return;
      }
      askImportMode(data, info);
    };
    reader.readAsText(file);
  }

  /** 匯入前先講清楚這個檔是什麼，預設合併，要覆蓋得另外再確認一次 */
  function askImportMode(data, info) {
    var body = document.createElement('div');
    body.appendChild(makeEl('p', null,
      '這個檔案裡有 ' + info.questionCount + ' 題作答紀錄' +
      (info.lastAnsweredAt ? ('，最後作答日是 ' + info.lastAnsweredAt) : '') + '。'));
    if (info.savedAt) body.appendChild(makeEl('p', 'small', '檔案匯出時間：' + info.savedAt));
    if (info.draftCount) body.appendChild(makeEl('p', 'small', '另外有 ' + info.draftCount + ' 份申論草稿。'));
    body.appendChild(makeEl('p', 'small',
      '「合併」會把兩邊的紀錄湊在一起，同一題以比較新的那一次為準，' +
      '你現在的進度不會不見。這是建議的做法。'));

    confirmDialog('要匯入這份進度嗎', body, '合併進來').then(function (ok) {
      if (!ok) {
        askOverwrite(data, info);
        return;
      }
      doImport(data, false);
    });
  }

  /** 取消合併時，再問一次要不要整個覆蓋（這個動作回不去） */
  function askOverwrite(data, info) {
    var body = document.createElement('div');
    body.appendChild(makeEl('p', null, '要改成「整個覆蓋」嗎？'));
    body.appendChild(makeEl('p', 'small',
      '覆蓋會把這台裝置上現有的進度全部刪掉，換成檔案裡的 ' + info.questionCount +
      ' 題紀錄。按下去就回不來了，沒有復原按鈕。'));
    body.appendChild(makeEl('p', 'small', '不想匯入的話按「取消」就好。'));

    confirmDialog('確定要覆蓋現有進度嗎', body, '確定覆蓋').then(function (ok) {
      if (ok) doImport(data, true);
    });
  }

  function doImport(data, overwrite) {
    if (overwrite) {
      state.progress = PQStore.normalizeProgress(data);
      saveProgressQuietly();
      renderHome();
      showNotice('已覆蓋為匯入的進度。', 'good', 'backup');
      return;
    }
    var merged = PQPure.mergeProgress(state.progress, data);
    state.progress = PQStore.normalizeProgress(merged.progress);
    saveProgressQuietly();
    renderHome();
    showNotice('已合併：新增 ' + merged.stats.added + ' 題、更新 ' + merged.stats.updated +
      ' 題、保留本機較新的 ' + merged.stats.kept + ' 題。', 'good', 'backup');
  }

  /* ================= 設定 ================= */

  function openSettings() {
    var set = settings();
    el.examDateCpu.value = (set.examDates && set.examDates['警佐班第3類']) || '';
    el.examDateMoex.value = (set.examDates && set.examDates['刑事三等']) || '';
    el.setThreshold.value = String(set.streakThreshold);
    el.setDaily.value = String(set.dailyLimit);
    el.setYearSpan.value = String(set.yearSpan);

    renderProviderOptions(set);
    el.aiKey.value = PQStore.loadAiKey();
    renderAiCacheInfo();
    renderExamDateInfo();
    renderStaleInfo();

    var lastExport = (state.progress.backup || {}).lastExportAt;
    el.backupInfo.textContent = lastExport
      ? ('上次匯出：' + lastExport) : '還沒匯出過。';

    showScreen('settings');
  }

  function renderProviderOptions(set) {
    var providers = PQExplain.listProviders();
    el.aiProvider.textContent = '';
    providers.forEach(function (provider) {
      var option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      if (provider.id === set.aiProvider) option.selected = true;
      el.aiProvider.appendChild(option);
    });
    renderModelOptions(set);
  }

  function renderModelOptions(set) {
    var providers = PQExplain.listProviders();
    var current = providers.filter(function (p) { return p.id === el.aiProvider.value; })[0] || providers[0];
    el.aiModel.textContent = '';
    (current.models || []).forEach(function (model) {
      var option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.name;
      if (model.id === set.aiModel) option.selected = true;
      el.aiModel.appendChild(option);
    });
    el.aiKeyHint.textContent = current.keyHint || '';
  }

  function renderAiCacheInfo() {
    PQExplain.countCached().then(function (count) {
      el.aiCacheInfo.textContent = count === 0
        ? '詳解快取：還沒存任何詳解。'
        : ('詳解快取：已存 ' + count + ' 題（離線也看得到，清除不會動到作答進度）。');
    });
  }

  function renderExamDateInfo() {
    var today = todayText();
    var set = settings();
    var parts = [];
    Object.keys(set.examDates || {}).forEach(function (name) {
      var left = PQPure.daysBetweenISO(today, set.examDates[name]);
      if (left === null) return;
      if (left < 0) { parts.push(name + '：已經考完'); return; }
      var cap = Math.max(1, Math.floor(left / 3));
      parts.push(name + '：還有 ' + left + ' 天，目前間隔上限 ' + cap + ' 天');
    });
    el.examDateInfo.textContent = parts.join('；') || '還沒設定考試日期。';
  }

  function renderStaleInfo() {
    var count = Object.keys(state.progress.staleFlags || {}).length;
    el.staleCountInfo.textContent = count === 0
      ? '還沒有標記任何題目。'
      : ('目前標了 ' + count + ' 題，這些題目練習時不會再出現。');
    el.staleClearBtn.disabled = count === 0;
  }

  function saveSettingsFromForm() {
    var set = settings();
    set.examDates = set.examDates || {};
    if (el.examDateCpu.value) set.examDates['警佐班第3類'] = el.examDateCpu.value;
    if (el.examDateMoex.value) set.examDates['刑事三等'] = el.examDateMoex.value;
    set.streakThreshold = Number(el.setThreshold.value) || 3;
    set.dailyLimit = Number(el.setDaily.value) || 60;
    set.yearSpan = Number(el.setYearSpan.value);
    set.aiProvider = el.aiProvider.value;
    set.aiModel = el.aiModel.value;
    state.progress.settings = set;
    saveProgressQuietly();
    renderExamDateInfo();
    renderHome();
  }

  /* ================= 鍵盤（電腦上用） ================= */

  function onKeyDown(event) {
    if ($('screen-quiz').classList.contains('hidden')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var key = (event.key || '').toUpperCase();

    if (key === 'ENTER') {
      if (!el.actionBtn.disabled) { event.preventDefault(); onActionClick(); }
      return;
    }
    if (PQPure.ALL_LETTERS.indexOf(key) !== -1 && !state.answered) {
      var button = el.optionList.querySelector('.option[data-letter="' + key + '"]');
      if (button) { event.preventDefault(); onOptionClick(key); }
    }
  }

  function onActionClick() {
    if (state.answered) { goNext(); } else { submitAnswer(); }
  }

  /* ================= 離線與更新 ================= */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (window.location.protocol === 'file:') return;
    navigator.serviceWorker.register('./sw.js').catch(function (error) {
      if (window.console && console.warn) console.warn('離線功能註冊失敗：', error);
    });
  }

  function checkForUpdate() {
    if (state.updating) return;
    state.updating = true;
    el.updateBtn.disabled = true;
    showNotice('正在確認網路、檢查更新…', 'soft', 'update');

    PQBank.checkOnline().then(function (online) {
      if (!online) {
        showNotice('現在連不上網路，這次沒有更新，原本存在手機裡的離線版還在，可以照常刷題。', 'error', 'update');
        return null;
      }
      PQBank.forget();
      return PQBank.clearAppCaches().then(function () {
        if (!('serviceWorker' in navigator)) return null;
        return navigator.serviceWorker.getRegistration().then(function (registration) {
          return registration ? registration.update() : null;
        });
      }).then(function () {
        window.location.reload();
        return true;
      });
    }).catch(function (error) {
      if (window.console && console.warn) console.warn('[更新] 失敗', error);
      showNotice('更新沒有完成，原本存在手機裡的離線版還在，可以照常刷題。稍後再試一次即可。', 'error', 'update');
    }).then(function () {
      state.updating = false;
      el.updateBtn.disabled = false;
    });
  }

  function prepareOffline() {
    if (!('serviceWorker' in navigator) || window.location.protocol === 'file:') {
      el.offlineNote.textContent = '離線功能：這個開啟方式不支援，需要連著網路才能刷。';
      return;
    }
    el.offlineNote.textContent = '離線可用：正在把題庫存進這台裝置…';

    var paint = function (status) {
      if (!status.supported) {
        el.offlineNote.textContent = '離線功能尚未就緒，這次請連著網路刷。';
        return;
      }
      el.offlineNote.textContent = status.ready >= status.total && status.total > 0
        ? ('離線可用：' + status.ready + '／' + status.total + ' 科（已經可以斷網刷題）')
        : ('離線可用：' + status.ready + '／' + status.total + ' 科（還在存，請先連著網路）');
    };

    PQBank.warmOfflineCache(paint).then(paint).catch(function (error) {
      if (window.console && console.warn) console.warn('[離線] 準備失敗', error);
      el.offlineNote.textContent = '離線準備沒有完成，等有網路的時候再打開一次就會繼續存。';
    });
  }

  function guardUnexpectedErrors() {
    var tell = function (where, detail) {
      if (window.console && console.warn) console.warn('[意外] ' + where, detail);
      showNotice('程式遇到沒預料到的狀況，這一步可能沒做完。' +
        '請重新整理頁面；如果一直這樣，按「檢查更新」再試一次。', 'error', 'crash');
    };
    window.addEventListener('error', function (event) {
      tell('執行錯誤', event && (event.error || event.message));
    });
    window.addEventListener('unhandledrejection', function (event) {
      tell('未處理的非同步錯誤', event && event.reason);
    });
  }

  /* ================= 綁事件 ================= */

  function bindEvents() {
    // 首頁的模式
    el.modeRandom.addEventListener('click', function () {
      showScreen('setup');
      if (!state.subject) loadSelectedSubject();
    });
    el.modeDue.addEventListener('click', function () { startSpecialMode('due'); });
    el.modeWrong.addEventListener('click', function () { startSpecialMode('wrong'); });
    el.modeExam.addEventListener('click', function () {
      if (window.PQExam) PQExam.open();
    });
    el.modeEssay.addEventListener('click', function () {
      if (window.PQEssay) PQEssay.open();
    });

    // 練習範圍
    el.subjectSelect.addEventListener('change', function () { loadSelectedSubject(); });
    el.yearFrom.addEventListener('change', function () {
      if (Number(el.yearFrom.value) > Number(el.yearTo.value)) el.yearTo.value = el.yearFrom.value;
      renderPoolInfo();
      rememberRange();
    });
    el.yearTo.addEventListener('change', function () {
      if (Number(el.yearTo.value) < Number(el.yearFrom.value)) el.yearFrom.value = el.yearTo.value;
      renderPoolInfo();
      rememberRange();
    });
    el.startBtn.addEventListener('click', startRandomRound);
    el.setupBackBtn.addEventListener('click', goHome);

    // 刷題
    el.actionBtn.addEventListener('click', onActionClick);
    el.finishBtn.addEventListener('click', finishRound);
    el.askAiBtn.addEventListener('click', askAi);
    el.staleBtn.addEventListener('click', toggleStaleFlag);
    document.addEventListener('keydown', onKeyDown);

    // 成績
    el.againBtn.addEventListener('click', startRandomRound);
    el.homeBtn.addEventListener('click', goHome);

    // 匯出匯入
    el.exportBtn.addEventListener('click', exportProgress);
    el.importBtn.addEventListener('click', pickImportFile);
    el.settingsExportBtn.addEventListener('click', exportProgress);
    el.settingsImportBtn.addEventListener('click', pickImportFile);
    el.importFile.addEventListener('change', onImportFileChosen);

    // 設定
    el.settingsBtn.addEventListener('click', openSettings);
    el.settingsBackBtn.addEventListener('click', goHome);
    [el.examDateCpu, el.examDateMoex, el.setThreshold, el.setDaily, el.setYearSpan]
      .forEach(function (node) { node.addEventListener('change', saveSettingsFromForm); });
    el.aiProvider.addEventListener('change', function () {
      renderModelOptions(settings());
      saveSettingsFromForm();
    });
    el.aiModel.addEventListener('change', saveSettingsFromForm);

    el.aiSaveBtn.addEventListener('click', function () {
      var result = PQStore.saveAiKey(el.aiKey.value.trim());
      showNotice(result.ok ? 'AI 金鑰已存在這台裝置（不會跟著進度匯出）。' : result.error,
        result.ok ? 'good' : 'error', 'ai');
    });
    el.aiClearBtn.addEventListener('click', function () {
      PQStore.clearAiKey();
      el.aiKey.value = '';
      showNotice('已清除這台裝置上的 AI 金鑰。', 'soft', 'ai');
    });
    el.aiClearCacheBtn.addEventListener('click', function () {
      confirmDialog('要清除詳解快取嗎',
        '清掉之後，之前問過的詳解就要重新問一次（會再花一次 AI 費用）。作答進度不受影響。',
        '清除').then(function (ok) {
        if (!ok) return;
        PQExplain.clearCache().then(function () {
          renderAiCacheInfo();
          showNotice('已清除詳解快取。', 'soft', 'ai');
        });
      });
    });
    el.staleClearBtn.addEventListener('click', function () {
      confirmDialog('要清除全部過時標記嗎',
        '清掉之後，你標成「已過時」的題目會重新出現在練習裡。', '清除').then(function (ok) {
        if (!ok) return;
        state.progress.staleFlags = {};
        saveProgressQuietly();
        renderStaleInfo();
        showNotice('已清除全部過時標記。', 'soft', 'stale');
      });
    });

    el.updateBtn.addEventListener('click', checkForUpdate);
  }

  function goHome() {
    renderHome();
    clearNotice();
    showScreen('home');
  }

  /* ================= 啟動 ================= */

  function init() {
    guardUnexpectedErrors();

    var loaded = PQStore.loadProgress();
    state.progress = loaded.progress;
    if (loaded.error) {
      state.storageWarned = true;
      showNotice(loaded.error, 'error', 'storage');
    }

    bindEvents();
    renderHome();
    registerServiceWorker();

    PQBank.loadIndex().then(function (index) {
      state.index = index;
      state.subjects = PQBank.listSubjects(index);
      var total = state.subjects.reduce(function (sum, item) { return sum + item.count; }, 0);
      el.versionNote.textContent = '題庫版本：' + (index.version || '不明') +
        '　程式版本：' + APP_VERSION + '　共 ' + total + ' 題';
      renderSubjectOptions();
      return loadSelectedSubject();
    }).then(function () {
      prepareOffline();
    }).catch(function (error) {
      el.poolInfo.textContent = '題庫沒有載入成功。';
      el.versionNote.textContent = '題庫版本：讀不到　程式版本：' + APP_VERSION;
      el.offlineNote.textContent = '離線可用：還沒準備好';
      el.startBtn.disabled = true;
      showNotice(error && error.message ? error.message : '題庫載入失敗，請稍後再試一次。', 'error', 'bank');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 給 exam.js 與 essay.js 用的共用小工具 */
  return {
    makeEl: makeEl,
    showScreen: showScreen,
    showNotice: showNotice,
    clearNotice: clearNotice,
    confirmDialog: confirmDialog,
    todayText: todayText,
    goHome: goHome,
    getProgress: function () { return state.progress; },
    getSettings: settings,
    getSubjects: function () { return state.subjects; },
    saveProgress: saveProgressQuietly,
    renderHome: renderHome
  };
}());
