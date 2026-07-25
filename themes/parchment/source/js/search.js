/* 本地即时搜索：加载 /search.json，按标题/分类/标签/正文打分过滤 */
(function () {
  var input = document.getElementById('search-input');
  var resultsEl = document.getElementById('search-results');
  var metaEl = document.getElementById('search-meta');
  var indexUrl = window.SEARCH_INDEX_URL || '/search.json';
  var posts = null;
  var timer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(text, terms) {
    var html = escapeHtml(text);
    terms.forEach(function (t) {
      if (!t) return;
      html = html.replace(new RegExp('(' + escapeRegExp(escapeHtml(t)) + ')', 'gi'), '<mark>$1</mark>');
    });
    return html;
  }

  function score(post, terms) {
    var total = 0;
    var title = post.title.toLowerCase();
    var cats = post.categories.join(' ').toLowerCase();
    var tags = post.tags.join(' ').toLowerCase();
    var content = (post.excerpt + ' ' + post.content).toLowerCase();
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var s = 0;
      if (title.indexOf(t) !== -1) s += 10;
      if (cats.indexOf(t) !== -1) s += 6;
      if (tags.indexOf(t) !== -1) s += 6;
      if (content.indexOf(t) !== -1) s += 2;
      if (s === 0) return 0; // 每个关键词都必须命中
      total += s;
    }
    return total;
  }

  function snippet(post, terms) {
    var text = post.excerpt || post.content || '';
    var lower = text.toLowerCase();
    var pos = -1;
    for (var i = 0; i < terms.length; i++) {
      pos = lower.indexOf(terms[i]);
      if (pos !== -1) break;
    }
    if (pos === -1) return text.slice(0, 120);
    var start = Math.max(0, pos - 40);
    return (start > 0 ? '…' : '') + text.slice(start, start + 140) + '…';
  }

  function render(query) {
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) {
      resultsEl.innerHTML = '';
      metaEl.textContent = posts ? '共收录 ' + posts.length + ' 篇文章' : '';
      return;
    }
    var hits = posts
      .map(function (p) { return { post: p, s: score(p, terms) }; })
      .filter(function (h) { return h.s > 0; })
      .sort(function (a, b) { return b.s - a.s; });

    metaEl.textContent = '找到 ' + hits.length + ' 篇相关文章';
    resultsEl.innerHTML = hits.map(function (h) {
      var p = h.post;
      var meta = [p.date]
        .concat(p.categories)
        .concat(p.tags.map(function (t) { return '#' + t; }))
        .filter(Boolean)
        .join(' · ');
      return (
        '<div class="search-result">' +
        '<div class="search-result-title"><a href="' + p.url + '">' + highlight(p.title, terms) + '</a></div>' +
        '<div class="meta">' + escapeHtml(meta) + '</div>' +
        '<p class="search-result-snippet">' + highlight(snippet(p, terms), terms) + '</p>' +
        '</div>'
      );
    }).join('');
  }

  function run() {
    render(input.value.trim());
    var q = input.value.trim();
    var url = q ? '?q=' + encodeURIComponent(q) : location.pathname;
    history.replaceState(null, '', url);
  }

  fetch(indexUrl)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      posts = data.posts || [];
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
    timer = setTimeout(run, 160);
  });
})();
