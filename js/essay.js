/*
 * essay.js — 申論題翻閱與草稿（製作人Rui / Maker Rui）
 *
 * 申論題沒有選項、不能判對錯，所以這裡只做三件事：
 *   1. 按科目與年度翻閱題目（題幹可能很長、含子題，換行要照原樣保留）
 *   2. 每題下面可以寫自己的答案草稿，存在這台裝置，可以反覆修改訂正
 *   3. 明確告訴使用者：系統不批改
 *
 * 草稿存在進度裡的 drafts，所以匯出進度時會一起帶走、換裝置接得回來。
 */

var PQEssay = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var makeEl = PQApp.makeEl;

  var el = {
    demoNotice: $('essay-demo-notice'),
    subject: $('essay-subject'),
    year: $('essay-year'),
    info: $('essay-info'),
    backBtn: $('essay-back-btn'),

    topicsBtn: $('essay-topics-btn'),
    topicCard: $('essay-topic-card'),
    topicList: $('essay-topic-list'),
    topicClose: $('essay-topic-close'),

    card: $('essay-question-card'),
    tags: $('essay-tags'),
    session: $('essay-session'),
    stem: $('essay-stem'),
    draft: $('essay-draft'),
    draftInfo: $('essay-draft-info'),
    prevBtn: $('essay-prev'),
    saveBtn: $('essay-save'),
    nextBtn: $('essay-next')
  };

  var state = {
    subjects: null,     // 科目代號 → { name, years, demo }
    demo: false,
    questions: [],      // 目前這一科的全部申論題
    pool: [],           // 依年度（與主題）篩選後的題目
    cursor: 0,
    topic: '',          // 目前只看哪一個考點（空字串＝全部）
    loaded: false
  };

  function open() {
    PQApp.showScreen('essay');
    if (state.loaded) return;

    el.info.textContent = '正在載入申論題庫…';
    PQBank.loadEssaySubjects().then(function (info) {
      state.subjects = info.subjects;
      state.demo = info.demo;
      state.loaded = true;

      el.demoNotice.textContent = '';
      if (info.demo) {
        el.demoNotice.appendChild(makeEl('div', 'notice',
          '正式的申論題庫還在製作中，現在看到的是「示範題目」，不是真的考古題，' +
          '只是讓你先看看畫面長什麼樣。題庫做好之後這裡會自動換成真的題目，你寫的草稿不會不見。'));
      }

      el.subject.textContent = '';
      var codes = Object.keys(state.subjects);
      if (codes.length === 0) {
        el.info.textContent = '目前沒有申論題庫。';
        return;
      }
      codes.forEach(function (code) {
        var option = document.createElement('option');
        option.value = code;
        option.textContent = state.subjects[code].name + '（' + state.subjects[code].count + ' 題）';
        el.subject.appendChild(option);
      });
      loadSubject();
    }).catch(function (error) {
      el.info.textContent = '申論題庫載入失敗。';
      PQApp.showNotice(error && error.message ? error.message : '申論題庫載入失敗。', 'error', 'essay');
    });
  }

  function loadSubject() {
    var code = el.subject.value;
    if (!code) return;
    state.topic = '';        // 換科目就不留上一科的考點篩選
    el.info.textContent = '正在載入題目…';
    el.card.classList.add('hidden');

    PQBank.loadEssayQuestions(code).then(function (data) {
      state.questions = data.questions || [];
      renderYearOptions();
      applyFilter();
    }).catch(function (error) {
      el.info.textContent = '題目載入失敗。';
      PQApp.showNotice(error && error.message ? error.message : '題目載入失敗。', 'error', 'essay');
    });
  }

  function renderYearOptions() {
    var years = PQPure.collectYears(state.questions).slice().reverse();
    el.year.textContent = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = '全部年度';
    el.year.appendChild(all);
    years.forEach(function (year) {
      var option = document.createElement('option');
      option.value = String(year);
      option.textContent = PQPure.yearLabel(year);
      el.year.appendChild(option);
    });
  }

  function applyFilter() {
    var year = el.year.value;
    state.pool = year
      ? state.questions.filter(function (q) { return String(q.year) === String(year); })
      : state.questions.slice();
    if (state.topic) state.pool = PQPure.filterByTopic(state.pool, state.topic);

    // 新的年度排前面，同年度照題號
    state.pool.sort(function (a, b) {
      if (a.year !== b.year) return Number(b.year) - Number(a.year);
      return (Number(a.no) || 0) - (Number(b.no) || 0);
    });

    state.cursor = 0;
    if (state.pool.length === 0) {
      el.info.textContent = '這個範圍沒有申論題。';
      el.card.classList.add('hidden');
      return;
    }
    el.info.textContent = '這個範圍有 ' + state.pool.length + ' 題' +
      (state.topic ? ('（只看「' + state.topic + '」這個考點）') : '') +
      '。系統不批改，草稿只存在這台裝置。';
    renderQuestion();
  }

  function currentQuestion() {
    return state.pool[state.cursor] || null;
  }

  function renderQuestion() {
    var question = currentQuestion();
    if (!question) return;

    el.card.classList.remove('hidden');
    el.tags.textContent = '';
    el.tags.appendChild(makeEl('span', 'tag tag-year', PQPure.yearLabel(question.year)));
    el.tags.appendChild(makeEl('span', 'tag', '申論題'));
    if (question.no) el.tags.appendChild(makeEl('span', 'tag', '第 ' + question.no + ' 題'));
    if (question.points) el.tags.appendChild(makeEl('span', 'tag', question.points + ' 分'));
    if (question.demo) el.tags.appendChild(makeEl('span', 'tag tag-demo', '示範題目'));

    el.session.textContent = question.session ? ('場次：' + question.session) : '';
    el.stem.textContent = question.stem || '';   // 換行用 CSS 的 pre-wrap 保留

    var drafts = PQApp.getProgress().drafts || {};
    var draft = drafts[question.id];
    el.draft.value = draft ? (draft.text || '') : '';
    renderDraftInfo(draft);

    el.prevBtn.disabled = state.cursor === 0;
    el.nextBtn.disabled = state.cursor >= state.pool.length - 1;
    window.scrollTo(0, 0);
  }

  function renderDraftInfo(draft) {
    var count = (el.draft.value || '').length;
    var saved = draft && draft.at ? ('　上次儲存：' + draft.at) : '';
    el.draftInfo.textContent = '目前 ' + count + ' 字' + saved +
      '　（第 ' + (state.cursor + 1) + ' ／ ' + state.pool.length + ' 題）';
  }

  function saveDraft(quiet) {
    var question = currentQuestion();
    if (!question) return;
    var progress = PQApp.getProgress();
    var drafts = progress.drafts || {};
    var text = el.draft.value;

    if (!text.trim()) {
      delete drafts[question.id];
    } else {
      drafts[question.id] = { text: text, at: PQApp.todayText() };
    }
    progress.drafts = drafts;
    var ok = PQApp.saveProgress();

    renderDraftInfo(drafts[question.id]);
    if (!quiet) {
      PQApp.showNotice(ok ? '草稿已存在這台裝置。' : '草稿沒有存起來（瀏覽器不讓這個網站儲存資料）。',
        ok ? 'good' : 'error', 'essay');
    }
  }

  function go(step) {
    saveDraft(true);              // 換題前自動存，不會寫到一半跑掉
    var next = state.cursor + step;
    if (next < 0 || next >= state.pool.length) return;
    state.cursor = next;
    renderQuestion();
  }

  /* ---------- 考點分布 ---------- */

  /**
   * 哪些主題年年考。
   * 申論題只能押題，所以「考過幾次、哪幾年考」比單一題目重要得多。
   */
  function renderTopicStats() {
    var year = el.year.value;
    // 考點統計看的是整個科目的歷年題目，不受目前年度篩選影響
    var rows = PQPure.essayTopicStats(state.questions);
    el.topicList.textContent = '';

    if (rows.length === 0) {
      el.topicList.appendChild(makeEl('p', 'small', '這一科沒有題目可以統計。'));
    } else if (rows.length === 1 && rows[0].topic === PQPure.UNTAGGED) {
      el.topicList.appendChild(makeEl('div', 'notice',
        '這一科的申論題還沒有主題標籤，所以統計不出考點分布。' +
        '等題庫補上標籤之後，這裡就會列出哪些主題年年考。'));
    } else {
      rows.forEach(function (row) {
        el.topicList.appendChild(makeTopicRow(row));
      });
      el.topicList.appendChild(makeEl('p', 'small',
        '一題可能掛好幾個考點，所以次數加起來會比題數多。' +
        (year ? '（統計看的是這一科的歷年全部題目，不受上面的年度篩選影響）' : '')));
    }

    el.topicCard.classList.remove('hidden');
    el.card.classList.add('hidden');
    window.scrollTo(0, 0);
  }

  function makeTopicRow(row) {
    var box = document.createElement('button');
    box.type = 'button';
    box.className = 'stat-line stat-line-clickable';

    var head = makeEl('div', 'stat-line-head');
    head.appendChild(makeEl('span', 'stat-line-name', row.topic));
    head.appendChild(makeEl('span', 'stat-line-rate', '考過 ' + row.count + ' 次'));
    box.appendChild(head);

    // 年度標籤列：一眼看得出是年年考還是偶爾考
    var years = makeEl('div', 'year-chips');
    row.years.forEach(function (year) {
      years.appendChild(makeEl('span', 'year-chip', year + ' 年'));
    });
    box.appendChild(years);

    box.appendChild(makeEl('span', 'stat-line-note',
      '橫跨 ' + row.yearCount + ' 個年度' +
      (row.latestYear ? ('，最近一次 ' + row.latestYear + ' 年') : '') + '　點一下只看這幾題'));

    box.addEventListener('click', function () {
      state.topic = row.topic;
      el.year.value = '';               // 看某個考點時不再限年度
      el.topicCard.classList.add('hidden');
      applyFilter();
    });
    return box;
  }

  function closeTopicStats() {
    el.topicCard.classList.add('hidden');
    state.topic = '';
    applyFilter();
  }

  function bind() {
    el.topicsBtn.addEventListener('click', renderTopicStats);
    el.topicClose.addEventListener('click', closeTopicStats);
    el.subject.addEventListener('change', loadSubject);
    el.year.addEventListener('change', applyFilter);
    el.backBtn.addEventListener('click', function () {
      saveDraft(true);
      PQApp.goHome();
    });
    el.prevBtn.addEventListener('click', function () { go(-1); });
    el.nextBtn.addEventListener('click', function () { go(1); });
    el.saveBtn.addEventListener('click', function () { saveDraft(false); });
    el.draft.addEventListener('input', function () { renderDraftInfo(null); });
    // 離開頁面前把草稿存起來，避免寫一半被關掉
    window.addEventListener('pagehide', function () { saveDraft(true); });
  }

  bind();

  return { open: open };
}());
