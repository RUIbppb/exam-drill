/*
 * exam.js — 模擬整卷（製作人Rui / Maker Rui）
 *
 * 照官方試卷整份出題、計時作答，交卷後用**該場考試真正的計分規則**算分。
 *
 * 兩套規則一定要分開（見 docs/adr/0007-two-scoring-rules.md）：
 *   警佐班   答錯倒扣（單選扣 1/3 題分、多選每錯一項扣 1/5 題分）
 *   刑事三等 答錯不倒扣，而且測驗題只占該科一半分數，所以結果一定要標明「申論題未計入」
 * 若統一套警佐班的倒扣規則，刑事三等的分數會被低估，使用者會誤判自己的實力——
 * 這比沒有模擬功能更糟。
 *
 * 計分本身是純函式（PQPure.scorePaper），這裡只負責畫面與計時。
 */

var PQExam = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var makeEl = PQApp.makeEl;

  var el = {
    target: $('exam-target'),
    paper: $('exam-paper'),
    paperInfo: $('exam-paper-info'),
    startBtn: $('exam-start-btn'),
    backBtn: $('exam-back-btn'),
    history: $('exam-history'),

    counter: $('exam-counter'),
    timer: $('exam-timer'),
    tags: $('exam-tags'),
    stem: $('exam-stem'),
    options: $('exam-options'),
    qid: $('exam-qid'),
    session: $('exam-session'),
    nav: $('exam-nav'),
    answeredInfo: $('exam-answered-info'),
    submitBtn: $('exam-submit-btn'),

    scoreNum: $('exam-score-num'),
    scoreDetail: $('exam-score-detail'),
    scoreNotice: $('exam-score-notice'),
    reviewBtn: $('exam-review-btn'),
    reviewCard: $('exam-review-card'),
    review: $('exam-review'),
    homeBtn: $('exam-home-btn')
  };

  var state = {
    papers: [],          // 可以選的試卷清單
    paper: null,         // 目前這份試卷（含題目）
    answers: {},         // 題目編號 → 選了哪些字母
    cursor: 0,
    endAt: 0,            // 作答結束的時間戳
    timerId: null,
    result: null,
    loading: false
  };

  /* ---------- 選卷 ---------- */

  function open() {
    PQApp.showScreen('exam-setup');
    renderHistory();
    if (state.papers.length > 0) { renderPaperOptions(); return; }

    el.paper.textContent = '';
    el.paper.appendChild(makeEl('option', null, '正在載入場次…'));
    el.startBtn.disabled = true;

    Promise.all([PQBank.loadExams(), PQBank.loadIndex()]).then(function (both) {
      state.papers = PQBank.listPapers(both[0], both[1]);
      renderPaperOptions();
    }).catch(function (error) {
      el.paperInfo.textContent = '場次設定載入失敗。';
      PQApp.showNotice(error && error.message ? error.message : '場次設定載入失敗。', 'error', 'exam');
    });
  }

  function renderPaperOptions() {
    var target = el.target.value;
    var list = state.papers.filter(function (paper) { return paper.target === target; });

    el.paper.textContent = '';
    if (list.length === 0) {
      el.paper.appendChild(makeEl('option', null, '這一場沒有可用的試卷'));
      el.startBtn.disabled = true;
      el.paperInfo.textContent = '';
      return;
    }
    list.forEach(function (paper) {
      var option = document.createElement('option');
      option.value = paper.examId + '|' + paper.subjectCode;
      option.textContent = paper.examName + '　' + paper.subjectName +
        (paper.official ? '' : '（補充題源）');
      el.paper.appendChild(option);
    });
    el.startBtn.disabled = false;
    renderPaperInfo();
  }

  function selectedPaper() {
    var value = el.paper.value || '';
    var parts = value.split('|');
    if (parts.length !== 2) return null;
    return state.papers.filter(function (paper) {
      return paper.examId === parts[0] && paper.subjectCode === parts[1];
    })[0] || null;
  }

  function renderPaperInfo() {
    var paper = selectedPaper();
    if (!paper) { el.paperInfo.textContent = ''; return; }
    var text = '作答時間 ' + paper.minutes + ' 分鐘；計分規則：' +
      (paper.scoring === 'cpu-deduct'
        ? '答錯倒扣（警佐班）' : '答錯不倒扣（考選部），測驗題只占該科一半分數');
    if (!paper.official) {
      text += '。這一份是補充題源（不是這場考試的正式考卷），拿來練手感用，命題深度可能不同。';
    }
    el.paperInfo.textContent = text;
  }

  /* ---------- 開始作答 ---------- */

  function start() {
    var choice = selectedPaper();
    if (!choice || state.loading) return;

    state.loading = true;
    el.startBtn.disabled = true;
    el.paperInfo.textContent = '正在準備試卷…';

    PQBank.loadPaper(choice.examId, choice.subjectCode).then(function (paper) {
      state.paper = paper;
      state.answers = {};
      state.cursor = 0;
      state.result = null;
      state.endAt = Date.now() + paper.minutes * 60000;

      PQApp.showScreen('exam');
      renderQuestion();
      startTimer();
    }).catch(function (error) {
      PQApp.showNotice(error && error.message ? error.message : '試卷載入失敗。', 'error', 'exam');
      el.paperInfo.textContent = '試卷載入失敗。';
    }).then(function () {
      state.loading = false;
      el.startBtn.disabled = false;
    });
  }

  function startTimer() {
    stopTimer();
    state.timerId = window.setInterval(tick, 1000);
    tick();
  }

  function stopTimer() {
    if (state.timerId) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function tick() {
    var left = Math.max(0, Math.round((state.endAt - Date.now()) / 1000));
    var minutes = Math.floor(left / 60);
    var seconds = left % 60;
    el.timer.textContent = '剩餘 ' + minutes + ':' + (seconds < 10 ? '0' : '') + seconds;
    el.timer.classList.toggle('exam-timer-warn', left <= 300);   // 最後 5 分鐘變色

    if (left <= 0) {
      stopTimer();
      PQApp.showNotice('時間到，已經自動交卷。', 'soft', 'exam');
      submit(true);
    }
  }

  /* ---------- 作答畫面 ---------- */

  function currentQuestion() {
    return state.paper ? state.paper.questions[state.cursor] : null;
  }

  function renderQuestion() {
    var question = currentQuestion();
    if (!question) return;
    window.scrollTo(0, 0);

    // 上方只放題號與計時，試卷名稱放題目卡裡，免得兩邊擠在一起換行
    el.counter.textContent = '第 ' + (state.cursor + 1) + ' ／ ' +
      state.paper.questions.length + ' 題';
    el.session.textContent = state.paper.examName + '　' + state.paper.subjectName +
      (state.paper.official ? '' : '（補充題源）');

    el.tags.textContent = '';
    el.tags.appendChild(makeEl('span', 'tag tag-year', PQPure.yearLabel(question.year)));
    el.tags.appendChild(makeEl('span', 'tag', PQPure.typeLabel(question.type)));
    if (question.language === 'en') el.tags.appendChild(makeEl('span', 'tag', '英文題'));
    PQApp.renderCorrectionMark(el.tags, question);   // 人工校正過的題目才會出現

    el.stem.textContent = question.stem || '';
    el.qid.textContent = '題號 ' + (question.id || '');

    var picked = state.answers[question.id] || [];
    el.options.textContent = '';
    var report = PQPure.inspectQuestion(question);
    report.validLetters.forEach(function (letter) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'option' + (picked.indexOf(letter) !== -1 ? ' picked' : '');
      button.setAttribute('data-letter', letter);
      button.appendChild(makeEl('span', 'option-letter', letter));
      button.appendChild(makeEl('span', 'option-text', String(question.options[letter])));
      button.addEventListener('click', function () { choose(question, letter); });
      el.options.appendChild(button);
    });

    renderNav();
  }

  /** 作答中不顯示對錯（這是模擬考，交卷才知道） */
  function choose(question, letter) {
    var picked = state.answers[question.id] || [];
    if (question.type === 'multi') {
      var at = picked.indexOf(letter);
      if (at === -1) { picked = picked.concat([letter]); } else {
        picked = picked.slice();
        picked.splice(at, 1);
      }
    } else {
      picked = picked.length === 1 && picked[0] === letter ? [] : [letter];  // 再點一次可以取消
    }
    state.answers[question.id] = picked;
    renderQuestion();

    // 單選題選完自動跳下一題，省一次點擊
    if (question.type === 'single' && picked.length === 1 &&
        state.cursor < state.paper.questions.length - 1) {
      window.setTimeout(function () {
        state.cursor += 1;
        renderQuestion();
      }, 180);
    }
  }

  function renderNav() {
    el.nav.textContent = '';
    state.paper.questions.forEach(function (question, index) {
      var picked = state.answers[question.id] || [];
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'qnav-btn' +
        (picked.length > 0 ? ' qnav-done' : '') +
        (index === state.cursor ? ' qnav-now' : '');
      button.textContent = String(index + 1);
      button.addEventListener('click', function () {
        state.cursor = index;
        renderQuestion();
      });
      el.nav.appendChild(button);
    });

    var answered = state.paper.questions.filter(function (question) {
      return (state.answers[question.id] || []).length > 0;
    }).length;
    el.answeredInfo.textContent = '已作答 ' + answered + ' ／ ' + state.paper.questions.length + ' 題' +
      (answered < state.paper.questions.length ? '（沒作答的題目一律 0 分，不會倒扣）' : '');
  }

  /* ---------- 交卷與計分 ---------- */

  function askSubmit() {
    var answered = state.paper.questions.filter(function (question) {
      return (state.answers[question.id] || []).length > 0;
    }).length;
    var blank = state.paper.questions.length - answered;

    PQApp.confirmDialog('要交卷了嗎',
      blank > 0 ? ('還有 ' + blank + ' 題沒作答，沒作答一律 0 分。確定要交卷嗎？') : '交卷之後就會算分並顯示正解。',
      '交卷').then(function (ok) {
      if (ok) submit(false);
    });
  }

  function submit(auto) {
    stopTimer();
    if (!state.paper) return;

    var records = state.paper.questions.map(function (question) {
      var picked = state.answers[question.id] || [];
      return {
        id: question.id,
        type: question.type,
        // 多選題的計分公式要用選項數（(n - 2k) / n × 題分）
        optionCount: PQPure.inspectQuestion(question).validLetters.length,
        answered: picked.length > 0,
        picked: picked,
        verdict: PQPure.judge(question, picked)
      };
    });

    var result = PQPure.scorePaper({
      scoring: state.paper.scoring,
      pointsPerSingle: state.paper.pointsPerSingle,
      pointsPerMulti: state.paper.pointsPerMulti,
      sectionFullScore: state.paper.sectionFullScore
    }, records);

    state.result = { result: result, records: records, auto: !!auto };
    saveHistory(result);
    renderResult();
  }

  function renderResult() {
    var result = state.result.result;
    var paper = state.paper;

    el.scoreNum.textContent = String(result.score);
    el.scoreDetail.textContent = paper.examName + '　' + paper.subjectName +
      '　滿分 ' + result.fullScore + ' 分　' +
      '答對 ' + result.correct + ' 題、答錯 ' + result.wrong + ' 題、沒作答 ' + result.blank + ' 題';

    el.scoreNotice.textContent = '';
    if (result.essayExcluded) {
      el.scoreNotice.appendChild(makeEl('div', 'notice',
        '這是測驗題部分的分數，申論題未計入。實際該科總分還要加上申論題，' +
        '所以這個分數不等於你的總成績。'));
    }
    el.scoreNotice.appendChild(makeEl('div', 'notice notice-soft',
      paper.scoring === 'cpu-deduct'
        ? '計分規則：單選每題 ' + paper.pointsPerSingle + ' 分、答錯倒扣 1/3 題分；' +
          '多選每題 ' + paper.pointsPerMulti + ' 分，五個選項每判斷正確一個得 1/5 題分' +
          '（正確地不選也算），判斷錯 1 個得 1.8 分、錯 2 個得 0.6 分、錯 3 個以上 0 分，單題不給負分。'
        : '計分規則：每題 ' + paper.pointsPerSingle + ' 分，答錯不倒扣。'));
    if (paper.scoringNote) {
      el.scoreNotice.appendChild(makeEl('div', 'notice notice-soft',
        '試卷封面原文：' + paper.scoringNote));
    }

    el.reviewCard.classList.add('hidden');
    PQApp.showScreen('exam-result');
  }

  /** 逐題檢討：看每一題選了什麼、正解是什麼 */
  function renderReview() {
    el.review.textContent = '';
    state.result.records.forEach(function (record, index) {
      var question = state.paper.questions[index];
      var wrap = makeEl('div', 'review-item');

      var head = makeEl('div', 'review-head');
      head.appendChild(makeEl('span', 'review-no', '第 ' + (index + 1) + ' 題'));
      var mark = record.verdict.correct ? '答對' : (record.answered ? '答錯' : '沒作答');
      head.appendChild(makeEl('span', 'review-mark review-' +
        (record.verdict.correct ? 'ok' : (record.answered ? 'ng' : 'blank')), mark));
      wrap.appendChild(head);

      var correctionMark = PQApp.makeCorrectionMark(question);   // 人工校正過的題目才會出現
      if (correctionMark) wrap.appendChild(correctionMark);

      wrap.appendChild(makeEl('p', 'review-stem', question.stem || ''));
      wrap.appendChild(makeEl('p', 'review-line',
        '你選的：' + (record.picked.length ? record.picked.join('、') : '（沒作答）')));
      wrap.appendChild(makeEl('p', 'review-line',
        '正解：' + (record.verdict.allCorrect ? '本題一律給分'
          : PQPure.formatGroups(record.verdict.groups))));

      var stale = PQPure.staleNotice(question);
      if (stale) wrap.appendChild(makeEl('p', 'review-line review-warn', '提醒：' + stale.text));
      wrap.appendChild(makeEl('p', 'review-qid', question.id));

      el.review.appendChild(wrap);
    });
    el.reviewCard.classList.remove('hidden');
    el.reviewCard.scrollIntoView({ block: 'start' });
  }

  /* ---------- 模擬紀錄（只留最近 20 次） ---------- */

  function saveHistory(result) {
    var progress = PQApp.getProgress();
    var list = Array.isArray(progress.exams) ? progress.exams : [];
    list.unshift({
      at: PQApp.todayText(),
      examId: state.paper.examId,
      examName: state.paper.examName,
      subjectName: state.paper.subjectName,
      score: result.score,
      fullScore: result.fullScore,
      correct: result.correct,
      total: result.total,
      scoring: result.scoring
    });
    progress.exams = list.slice(0, 20);   // 只留最近 20 次，避免無上限長大
    PQApp.saveProgress();
  }

  function renderHistory() {
    var list = PQApp.getProgress().exams || [];
    el.history.textContent = '';
    if (list.length === 0) {
      el.history.appendChild(makeEl('p', 'small', '還沒有模擬紀錄。'));
      return;
    }
    list.forEach(function (item) {
      var row = makeEl('div', 'bank-row');
      row.appendChild(makeEl('span', null, item.examName + '　' + item.subjectName));
      row.appendChild(makeEl('span', 'small',
        item.at + '　' + item.score + '／' + item.fullScore + ' 分'));
      el.history.appendChild(row);
    });
    el.history.appendChild(makeEl('p', 'small', '只保留最近 20 次。'));
  }

  /* ---------- 綁事件 ---------- */

  function bind() {
    el.target.addEventListener('change', renderPaperOptions);
    el.paper.addEventListener('change', renderPaperInfo);
    el.startBtn.addEventListener('click', start);
    el.backBtn.addEventListener('click', PQApp.goHome);
    el.submitBtn.addEventListener('click', askSubmit);
    el.reviewBtn.addEventListener('click', renderReview);
    el.homeBtn.addEventListener('click', function () {
      stopTimer();
      PQApp.renderHome();
      PQApp.goHome();
    });
  }

  bind();

  return { open: open };
}());
