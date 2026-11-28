/* 本地即时搜索（/search/ 兜底页）：加载 /search.json，按标题/分类/标签/正文打分过滤 */
(function () {
  'use strict';

  var input = document.getElementById('search-input');
  var resultsEl = document.getElementById('search-results');
  var metaEl = document.getElementById('search-meta');
  if (!input || !resultsEl || !metaEl) return;

  var indexUrl = window.SEARCH_INDEX_URL || '/search.json';
  var posts = null;
  var timer = null;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(text, terms) {
    var html = escapeHtml(text);
    if (!terms || !terms.length) return html;
    var patterns = terms
      .filter(Boolean)
      .slice()
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (t) { return escapeRegExp(escapeHtml(t)); });
    if (!patterns.length) return html;
    return html.replace(new RegExp('(' + patterns.join('|') + ')', 'gi'), '<mark>$1</mark>');
  }

  function score(post, terms) {
    var total = 0;
    var title = (post.title || '').toLowerCase();
    var cats = (post.categories || []).join(' ').toLowerCase();
    var tags = (post.tags || []).join(' ').toLowerCase();
    var content = ((post.excerpt || '') + ' ' + (post.content || '')).toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var s = 0;
      if (title.indexOf(t) !== -1) s += 12;
      if (cats.indexOf(t) !== -1) s += 7;
      if (tags.indexOf(t) !== -1) s += 7;
      if (content.indexOf(t) !== -1) s += 2;
      if (s === 0) return 0;
      total += s;
    }
    return total;
  }

  function snippet(post, terms) {
    var sources = [post.excerpt || '', post.content || ''].filter(Boolean);
    if (!sources.length) return '';

    for (var sIdx = 0; sIdx < sources.length; sIdx++) {
      var text = sources[sIdx];
      var lower = text.toLowerCase();
      var pos = -1;
      for (var i = 0; i < terms.length; i++) {
        pos = lower.indexOf(terms[i]);
        if (pos !== -1) break;
      }
      if (pos !== -1) {
        var start = Math.max(0, pos - 40);
        var end = Math.min(text.length, start + 140);
        return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      }
    }

    var fallback = sources[0];
    return fallback.length > 140 ? fallback.slice(0, 140) + '…' : fallback;
  }

  function render(query) {
    if (!posts) return;
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      resultsEl.innerHTML = '';
      metaEl.textContent = '共收录 ' + posts.length + ' 篇文章';
      return;
    }
    var hits = posts
      .map(function (p) { return { post: p, s: score(p, terms) }; })
      .filter(function (h) { return h.s > 0; })
      .sort(function (a, b) { return b.s - a.s; });

    metaEl.textContent = hits.length
      ? '找到 ' + hits.length + ' 篇相关文章'
      : '未找到与“' + query + '”相关的文章';

    resultsEl.innerHTML = hits.map(function (h) {
      var p = h.post;
      var meta = [p.date]
        .concat(p.categories || [])
        .concat((p.tags || []).map(function (t) { return '#' + t; }))
        .filter(Boolean)
        .join(' · ');
      var snip = snippet(p, terms);
      return (
        '<article class="search-result">' +
          '<h2 class="search-result-title"><a href="' + escapeHtml(p.url) + '">' + highlight(p.title, terms) + '</a></h2>' +
          (meta ? '<div class="search-result-meta">' + escapeHtml(meta) + '</div>' : '') +
          (snip ? '<p class="search-result-snippet">' + highlight(snip, terms) + '</p>' : '') +
        '</article>'
      );
    }).join('');
  }

  function run() {
    var q = input.value.trim();
    render(q);
    var url = q ? '?q=' + encodeURIComponent(q) : location.pathname;
    history.replaceState(null, '', url);
  }

  fetch(indexUrl)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      posts = (data && data.posts) || [];
      var params = new URLSearchParams(location.search);
      var q = params.get('q') || '';
      input.value = q;
      render(q);
      input.focus();
    })
    .catch(function () {
      metaEl.textContent = '搜索索引加载失败，请先执行 hexo generate。';
    });

  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(run, 140);
  });
})();
