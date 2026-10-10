/*
 * laws.js — 法條速查（製作人Rui / Maker Rui）
 *
 * 刷題刷到一半想查法條原文，不用切到瀏覽器；捷運上沒網路也查得到
 * （法規檔會跟題庫一起背景存進這台裝置，見 bank.js 的 warmLaws）。
 *
 * 資料來源是全國法規資料庫（法務部），畫面上一定要標示出處——
 * 法務部的使用規範就是這樣要求的，不是可有可無的小字。
 *
 * 【效能】刑事訴訟法 712 條、刑法 422 條，一次把幾百條塞進畫面手機會卡，
 * 所以採分段渲染：先畫 60 條，按「再顯示更多」才繼續。搜尋時只畫命中的那幾條。
 */

var PQLaws = (function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  var makeEl = PQApp.makeEl;

  var CHUNK = 60;          // 一次畫幾條

  var el = {
    search: $('law-search'),
    searchInfo: $('law-search-info'),
    searchResult: $('law-search-result'),
    backBtn: $('law-back-btn'),

    catalogCard: $('law-catalog-card'),
    catalog: $('law-catalog'),
    source: $('law-source'),

    detailCard: $('law-detail-card'),
    name: $('law-name'),
    meta: $('law-meta'),
    amendments: $('law-amendments'),
    articleSearch: $('law-article-search'),
    articleInfo: $('law-article-info'),
    articles: $('law-articles'),
    moreBtn: $('law-more-btn'),
    officialLink: $('law-official-link'),
    listBtn: $('law-list-btn')
  };

  var state = {
    laws: [],            // 法規清單
    source: '',
    categoryOrder: null,
    loaded: false,
    law: null,           // 目前打開的那一部
    shown: 0,            // 已經畫了幾條
    filtered: null       // 搜尋後的條文（null 代表沒在搜尋）
  };

  /* ---------- 進入畫面 ---------- */

  function open(lawCode) {
    PQApp.showScreen('laws');
    if (state.loaded) {
      if (lawCode) { openLaw(lawCode); } else { showCatalog(); }
      return;
    }

    el.catalog.textContent = '';
    el.catalog.appendChild(makeEl('p', 'small', '正在載入法規清單…'));

    PQBank.lawCatalog().then(function (data) {
      state.laws = data.laws;
      state.source = data.source;
      state.categoryOrder = data.categoryOrder;
      state.loaded = true;
      renderCatalog();
      // 法務部的使用規範要求衍生應用註明來源，這一行不可以拿掉
      el.source.textContent = '資料來源：' + data.source +
        (data.officialUpdatedAt ? ('　官方資料更新日：' + data.officialUpdatedAt) : '') +
        '　這份資料每週重新抓一次，實際內容仍以全國法規資料庫的官方網站為準。';
      if (lawCode) openLaw(lawCode);
    }).catch(function (error) {
      el.catalog.textContent = '';
      el.catalog.appendChild(makeEl('div', 'notice',
        '法規資料還沒準備好。' +
        (error && error.message ? '（' + error.message + '）' : '') +
        '等建置完成之後，這裡就會出現全部法規。'));
    });
  }

  function showCatalog() {
    el.detailCard.classList.add('hidden');
    el.catalogCard.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  /* ---------- 法規清單 ---------- */

  function renderCatalog() {
    el.catalog.textContent = '';
    var groups = PQPure.groupLawsByCategory(state.laws, state.categoryOrder);

    groups.forEach(function (group) {
      el.catalog.appendChild(makeEl('p', 'law-category', group.category));
      group.laws.forEach(function (law) {
        el.catalog.appendChild(makeLawRow(law));
      });
    });
    el.catalog.appendChild(makeEl('p', 'small',
      '共 ' + state.laws.length + ' 部法規。點一下看全部條文。'));
  }

  function makeLawRow(law) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'law-row';
    row.appendChild(makeEl('span', 'law-row-name', law.name));
    row.appendChild(makeEl('span', 'law-row-meta',
      law.articles + ' 條' + (law.modified ? ('　最後修正 ' + law.modified) : '')));
    row.addEventListener('click', function () { openLaw(law.code); });
    return row;
  }

  /* ---------- 打開一部法規 ---------- */

  function openLaw(code) {
    el.catalogCard.classList.add('hidden');
    el.detailCard.classList.remove('hidden');
    el.articles.textContent = '';
    el.articles.appendChild(makeEl('p', 'small', '正在載入條文…'));
    el.moreBtn.classList.add('hidden');
    el.articleSearch.value = '';
    el.articleInfo.textContent = '';
    window.scrollTo(0, 0);

    PQBank.loadLaw(code).then(function (law) {
      state.law = law;
      state.filtered = null;
      state.shown = 0;

      el.name.textContent = law.name + (law.abandoned ? '（已廢止）' : '');
      el.meta.textContent = '共 ' + law.articles.length + ' 條' +
        (law.modified ? ('　最後修正 ' + law.modified) : '') +
        (law.category ? ('　' + law.category) : '');

      renderAmendments(law);
      el.officialLink.href = law.url || '#';
      el.officialLink.classList.toggle('hidden', !law.url);

      renderArticles(true);
    }).catch(function (error) {
      el.articles.textContent = '';
      el.articles.appendChild(makeEl('div', 'notice notice-error',
        error && error.message ? error.message : '這部法規載入失敗。'));
    });
  }

  /** 最近修正紀錄：讓使用者一眼看到這部法最近改過幾次 */
  function renderAmendments(law) {
    el.amendments.textContent = '';
    var list = law.recentAmendments || [];
    if (list.length === 0) return;

    var box = makeEl('div', 'notice notice-soft');
    box.appendChild(makeEl('span', 'amend-title', '最近修正：'));
    box.appendChild(makeEl('span', null, list.slice(0, 5).join('　')));
    if (list.length > 5) {
      box.appendChild(makeEl('span', 'small', '（另有較早的 ' + (list.length - 5) + ' 次修正）'));
    }
    el.amendments.appendChild(box);
  }

  /**
   * 畫條文。分段畫，不然幾百條一次塞進畫面手機會卡住。
   * @param {boolean} reset 是否從頭畫起
   */
  function renderArticles(reset) {
    var list = state.filtered || state.law.articles;
    if (reset) {
      el.articles.textContent = '';
      state.shown = 0;
    }

    var end = Math.min(state.shown + CHUNK, list.length);
    for (var i = state.shown; i < end; i += 1) {
      el.articles.appendChild(makeArticle(list[i]));
    }
    state.shown = end;

    var left = list.length - state.shown;
    el.moreBtn.classList.toggle('hidden', left <= 0);
    if (left > 0) {
      el.moreBtn.textContent = '再顯示更多條文（還有 ' + left + ' 條）';
    }
  }

  function makeArticle(article) {
    var box = makeEl('div', 'article');
    box.appendChild(makeEl('p', 'article-no', article.no || ''));
    // 條文有縮排與換行（全形空格排版），用 CSS 的 pre-wrap 原樣顯示
    box.appendChild(makeEl('p', 'article-text', article.text || ''));
    return box;
  }

  /* ---------- 搜尋 ---------- */

  /** 在法規清單頁搜尋：找法規名稱 */
  function onSearchList() {
    var text = el.search.value;
    var parsed = PQPure.parseLawQuery(text);
    el.searchResult.textContent = '';

    if (parsed.empty) {
      el.searchInfo.textContent = '可以打法規名稱、條號（185-3）或條文裡的字。';
      return;
    }

    var hits = PQPure.searchLawList(state.laws, parsed);
    if (parsed.keyword && hits.length === 0) {
      el.searchInfo.textContent = '沒有法規叫「' + parsed.keyword + '」。' +
        '想找條文內容的話，先點開一部法規，再用裡面的搜尋框找。';
      return;
    }
    if (!parsed.keyword && parsed.articleKey) {
      el.searchInfo.textContent = '請先選一部法規，再查 ' + PQPure.formatArticleKey(parsed.articleKey) + '。';
      return;
    }

    el.searchInfo.textContent = '找到 ' + hits.length + ' 部法規' +
      (parsed.articleKey ? ('，點進去會直接跳到' + PQPure.formatArticleKey(parsed.articleKey)) : '');
    hits.forEach(function (law) {
      var row = makeLawRow(law);
      if (parsed.articleKey) {
        // 「刑法 185-3」這種打法：點了直接帶著條號進去
        row.addEventListener('click', function () {
          window.setTimeout(function () {
            el.articleSearch.value = parsed.articleKey;
            onSearchArticles();
          }, 300);
        });
      }
      el.searchResult.appendChild(row);
    });
  }

  /** 在一部法規裡面搜條文 */
  function onSearchArticles() {
    if (!state.law) return;
    var text = el.articleSearch.value;
    var parsed = PQPure.parseLawQuery(text);

    if (parsed.empty) {
      state.filtered = null;
      el.articleInfo.textContent = '';
      renderArticles(true);
      return;
    }

    var hits = PQPure.searchArticles(state.law.articles, parsed, 200);
    state.filtered = hits;
    el.articleInfo.textContent = hits.length === 0
      ? '這部法規裡找不到「' + parsed.raw + '」。'
      : ('找到 ' + hits.length + ' 條' + (hits.length >= 200 ? '（只顯示前 200 條）' : '') +
         '。清空搜尋框就會回到全部條文。');
    renderArticles(true);
  }

  /* ---------- 綁事件 ---------- */

  function bind() {
    el.search.addEventListener('input', onSearchList);
    el.articleSearch.addEventListener('input', onSearchArticles);
    el.moreBtn.addEventListener('click', function () { renderArticles(false); });
    el.listBtn.addEventListener('click', function () {
      el.search.value = '';
      el.searchResult.textContent = '';
      onSearchList();
      showCatalog();
    });
    el.backBtn.addEventListener('click', PQApp.goHome);
  }

  bind();

  return { open: open };
}());
