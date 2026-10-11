/*
 * weak.js — 我的弱點（製作人Rui / Maker Rui）
 *
 * 刷了幾千題之後，總答對率看不出「我到底哪一塊弱」。這一頁按主題與科目拆開算，
 * 最弱的排最前面，點一下就直接只刷那個主題。
 *
 * 【兩個設計重點】
 *  1. 作答題數太少的一定要標示「參考價值低」。
 *     只刷過 1 題就顯示 0% 會讓人誤以為自己完全不會，那是統計假象不是實力。
 *  2. 他考兩場，科目不一樣，所以一定要能切換只看某一場的科目，
 *     四科跟七科混在一起看不出重點。
 *
 * 統計本身是純函式（PQPure.topicStats / subjectStats），這裡只負責載入與畫面。
 */

var PQWeak = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var makeEl = PQApp.makeEl;

  var el = {
    target: $('weak-target'),
    status: $('weak-status'),
    backBtn: $('weak-back-btn'),
    subjectCard: $('weak-subject-card'),
    subjects: $('weak-subjects'),
    topicCard: $('weak-topic-card'),
    topics: $('weak-topics'),
    topicNote: $('weak-topic-note')
  };

  var state = {
    pool: [],          // 目前這個考試目標底下的全部題目
    target: null,      // 已經載入的是哪一個目標
    loading: false
  };

  function open() {
    PQApp.showScreen('weak');
    var saved = PQApp.getSettings().weakTarget;
    if (saved !== undefined && saved !== null) el.target.value = saved;
    load();
  }

  /** 載入這個考試目標底下的所有科目（只載需要的那幾科，不是整包題庫） */
  function load() {
    if (state.loading) return;
    var target = el.target.value;
    if (state.target === target && state.pool.length > 0) {
      render();
      return;
    }

    state.loading = true;
    el.subjectCard.classList.add('hidden');
    el.topicCard.classList.add('hidden');

    var subjects = PQApp.getSubjects().filter(function (item) {
      return !target || (item.targets || []).indexOf(target) !== -1;
    });
    if (subjects.length === 0) {
      state.loading = false;
      el.status.textContent = '這個考試目標底下沒有科目。';
      return;
    }

    var done = 0;
    el.status.textContent = '正在讀題庫計算…（0／' + subjects.length + ' 科）';

    // 一科一科讀，讀完才讀下一科，不要一口氣塞爆手機
    var chain = Promise.resolve([]);
    subjects.forEach(function (item) {
      chain = chain.then(function (collected) {
        return PQBank.loadSubject(item.code).then(function (subject) {
          done += 1;
          el.status.textContent = '正在讀題庫計算…（' + done + '／' + subjects.length + ' 科）';
          return collected.concat(subject.questions);
        }).catch(function () {
          done += 1;
          return collected;        // 某一科讀不到就跳過，其他照算
        });
      });
    });

    chain.then(function (all) {
      state.pool = all;
      state.target = target;
      state.loading = false;
      render();
    }).catch(function (error) {
      state.loading = false;
      el.status.textContent = '題庫讀不完整，沒辦法算弱點。';
      PQApp.showNotice(error && error.message ? error.message : '題庫讀取失敗。', 'error', 'weak');
    });
  }

  function render() {
    var progress = PQApp.getProgress();
    var answered = state.pool.filter(function (question) {
      var entry = (progress.questions || {})[question.id];
      return entry && ((Number(entry.correctCount) || 0) + (Number(entry.wrongCount) || 0)) > 0;
    }).length;

    if (answered === 0) {
      el.status.textContent = '這些科目你還沒刷過任何題目，先去練幾回再回來看。';
      el.subjectCard.classList.add('hidden');
      el.topicCard.classList.add('hidden');
      return;
    }
    el.status.textContent = '這個範圍共 ' + state.pool.length + ' 題，你刷過 ' + answered + ' 題。';

    renderSubjects(progress);
    renderTopics(progress);
  }

  /** 哪一科比較弱 */
  function renderSubjects(progress) {
    var rows = PQPure.subjectStats(state.pool, progress)
      .filter(function (row) { return row.answered > 0; });

    el.subjects.textContent = '';
    if (rows.length === 0) {
      el.subjectCard.classList.add('hidden');
      return;
    }
    rows.forEach(function (row) {
      el.subjects.appendChild(makeStatRow({
        name: row.subject,
        accuracy: row.accuracy,
        answered: row.answered,
        total: row.total,
        lowConfidence: row.lowConfidence
      }));
    });
    el.subjectCard.classList.remove('hidden');
  }

  /** 哪個主題比較弱 */
  function renderTopics(progress) {
    var index = PQApp.getIndex();
    // 看「全部科目」時才能直接用索引的全庫題數，篩了考試目標就要用實際載入的題數
    var totals = el.target.value ? null : PQPure.readTopicTotals(index);
    var rows = PQPure.topicStats(state.pool, progress, { topicTotals: totals });
    var practised = rows.filter(function (row) { return row.answered > 0; });

    el.topics.textContent = '';
    if (practised.length === 0) {
      el.topicCard.classList.add('hidden');
      return;
    }

    // 題庫還沒標主題時，全部會落在「未分類」，要講清楚不是程式壞了
    var onlyUntagged = practised.length === 1 && practised[0].topic === PQPure.UNTAGGED;
    if (onlyUntagged) {
      el.topics.appendChild(makeEl('div', 'notice',
        '這些題目還沒有主題標籤，所以只能看到「未分類」。等題庫補上標籤之後，' +
        '這裡就會按主題拆開顯示，不用重刷。'));
    }

    practised.forEach(function (row) {
      el.topics.appendChild(makeStatRow({
        name: row.topic,
        accuracy: row.accuracy,
        answered: row.answered,
        total: row.total,
        untouched: row.untouched,
        lowConfidence: row.lowConfidence,
        onPractise: function () { practise(row.topic); }
      }));
    });

    var waiting = rows.length - practised.length;
    el.topicNote.textContent = '一題可能掛好幾個主題，所以各主題的題數加起來會比總題數多，這是正常的。' +
      (waiting > 0 ? ('另外有 ' + waiting + ' 個主題你還沒刷到，等刷過才會出現在這裡。') : '');
    el.topicCard.classList.remove('hidden');
  }

  /** 一列統計：名稱、答對率、刷過幾題 */
  function makeStatRow(info) {
    var row = info.onPractise ? document.createElement('button') : makeEl('div', null, null);
    if (info.onPractise) {
      row.type = 'button';
      row.addEventListener('click', info.onPractise);
    }
    row.className = 'stat-line' + (info.onPractise ? ' stat-line-clickable' : '');

    var head = makeEl('div', 'stat-line-head');
    head.appendChild(makeEl('span', 'stat-line-name', info.name));
    head.appendChild(makeEl('span', 'stat-line-rate' + rateClass(info.accuracy),
      info.accuracy === null ? '還沒刷' : (info.accuracy + '%')));
    row.appendChild(head);

    // 用一條細長條把強弱畫出來，比純數字好掃
    var bar = makeEl('div', 'stat-bar');
    var fill = makeEl('div', 'stat-bar-fill' + rateClass(info.accuracy));
    fill.style.width = (info.accuracy === null ? 0 : info.accuracy) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);

    var note = '刷過 ' + info.answered + ' 題';
    if (info.total) note += ' ／ 題庫 ' + info.total + ' 題';
    if (info.untouched) note += '（還有 ' + info.untouched + ' 題沒刷過）';
    row.appendChild(makeEl('span', 'stat-line-note', note));

    if (info.lowConfidence) {
      row.appendChild(makeEl('span', 'stat-line-warn',
        '只刷過 ' + info.answered + ' 題，參考價值低'));
    }
    return row;
  }

  function rateClass(accuracy) {
    if (accuracy === null) return ' rate-none';
    if (accuracy < 50) return ' rate-low';
    if (accuracy < 75) return ' rate-mid';
    return ' rate-high';
  }

  /** 從弱點直接開練：只出這個主題的題目 */
  function practise(topic) {
    var progress = PQApp.getProgress();
    var pool = PQPure.pickTopicQuestions(
      PQPure.excludeStaleFlagged(state.pool, progress), progress, topic,
      PQApp.getSettings().dailyLimit || 60);

    if (pool.length === 0) {
      PQApp.showNotice('這個主題目前沒有題目可以練習。', 'error', 'weak');
      return;
    }
    PQApp.startPool(pool, 'topic', '主題：' + topic);
  }

  function bind() {
    el.target.addEventListener('change', function () {
      var settings = PQApp.getSettings();
      settings.weakTarget = el.target.value;
      PQApp.saveProgress();
      load();
    });
    el.backBtn.addEventListener('click', PQApp.goHome);
  }

  bind();

  return { open: open };
}());
