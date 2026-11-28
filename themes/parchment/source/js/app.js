/* Be AI-Native / Parchment: ⌘K 搜索、文章目录 Scroll-Spy、代码块增强、响应式表格、图片灯箱 */
(function () {
  'use strict';

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightTerms(text, terms) {
    var html = escapeHtml(text);
    if (!terms || !terms.length) return html;
    var patterns = terms
      .filter(Boolean)
      .slice()
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (t) { return escapeRegExp(escapeHtml(t)); });
    if (!patterns.length) return html;
    var regex = new RegExp('(' + patterns.join('|') + ')', 'gi');
    return html.replace(regex, '<mark>$1</mark>');
  }

  function isEditableTarget(el) {
    if (!el) return false;
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  function fuzzySubsequence(haystack, needle) {
    if (!needle || needle.length < 2) return false;
    var hi = 0;
    for (var ni = 0; ni < needle.length; ni++) {
      hi = haystack.indexOf(needle[ni], hi);
      if (hi === -1) return false;
      hi += 1;
    }
    return true;
  }

  /* ------------------------------------------------------------------
   * 1. ⌘K / Ctrl+K 搜索弹窗
   * ------------------------------------------------------------------ */
  function initSearchModal() {
    var modal = document.getElementById('search-modal');
    var trigger = document.getElementById('search-trigger');
    var input = document.getElementById('modal-search-input');
    var metaEl = document.getElementById('search-modal-meta');
    var resultsEl = document.getElementById('search-modal-results');
    if (!modal || !input || !resultsEl || !metaEl) return;

    var isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
    if (trigger) {
      var kbd = trigger.querySelector('.search-kbd');
      if (kbd) kbd.textContent = isMac ? '⌘K' : 'Ctrl K';
    }

    var indexUrl = window.SEARCH_INDEX_URL || '/search.json';
    var posts = null;
    var loading = false;
    var loadError = false;
    var selectedIndex = -1;
    var currentItems = [];
    var debounceTimer = null;
    var lastFocused = null;

    function isOpen() {
      return !modal.hidden && modal.classList.contains('is-open');
    }

    function scorePost(post, terms) {
      var title = (post.title || '').toLowerCase();
      var cats = (post.categories || []).join(' ').toLowerCase();
      var tags = (post.tags || []).join(' ').toLowerCase();
      var content = ((post.excerpt || '') + ' ' + (post.content || '')).toLowerCase();
      var total = 0;

      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        var s = 0;
        if (title.indexOf(t) !== -1) {
          s += 12;
          if (title.indexOf(t) === 0) s += 4;
        }
        if (cats.indexOf(t) !== -1) s += 7;
        if (tags.indexOf(t) !== -1) s += 7;
        if (content.indexOf(t) !== -1) s += 2;
        if (s === 0) return 0;
        total += s;
      }
      return total;
    }

    function fuzzyScorePost(post, terms) {
      var title = (post.title || '').toLowerCase();
      var meta = ((post.categories || []).join(' ') + ' ' + (post.tags || []).join(' ')).toLowerCase();
      var total = 0;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        var s = 0;
        if (fuzzySubsequence(title, t)) s += 5;
        if (fuzzySubsequence(meta, t)) s += 3;
        if (s === 0) return 0;
        total += s;
      }
      return total;
    }

    function buildSnippet(post, terms) {
      var sources = [post.excerpt || '', post.content || ''].filter(Boolean);
      if (!sources.length) return '';

      if (!terms || !terms.length) {
        var base = sources[0];
        return base.length > 110 ? base.slice(0, 110) + '…' : base;
      }

      for (var sIdx = 0; sIdx < sources.length; sIdx++) {
        var text = sources[sIdx];
        var lower = text.toLowerCase();
        var pos = -1;
        for (var i = 0; i < terms.length; i++) {
          pos = lower.indexOf(terms[i]);
          if (pos !== -1) break;
        }
        if (pos !== -1) {
          var start = Math.max(0, pos - 36);
          var end = Math.min(text.length, start + 130);
          return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
        }
      }
      var fallback = sources[0];
      return fallback.length > 110 ? fallback.slice(0, 110) + '…' : fallback;
    }

    function setSelected(idx) {
      var items = resultsEl.querySelectorAll('.search-modal-item');
      if (!items.length) {
        selectedIndex = -1;
        return;
      }
      if (idx < 0) idx = items.length - 1;
      if (idx >= items.length) idx = 0;
      selectedIndex = idx;

      for (var i = 0; i < items.length; i++) {
        var active = i === selectedIndex;
        items[i].classList.toggle('is-selected', active);
        items[i].setAttribute('aria-selected', active ? 'true' : 'false');
        if (active) {
          items[i].scrollIntoView({ block: 'nearest' });
        }
      }
    }

    function renderResults(query) {
      if (loading) {
        metaEl.textContent = '正在加载搜索索引…';
        resultsEl.innerHTML = '';
        return;
      }
      if (loadError) {
        metaEl.textContent = '搜索索引加载失败，请稍后重试。';
        resultsEl.innerHTML = '';
        return;
      }
      if (!posts) return;

      var q = (query || '').trim();
      var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      var list;

      if (!terms.length) {
        list = posts.slice(0, 8);
        metaEl.textContent = '共收录 ' + posts.length + ' 篇文章 · 最近更新';
      } else {
        var hits = posts
          .map(function (p) { return { post: p, s: scorePost(p, terms) }; })
          .filter(function (h) { return h.s > 0; })
          .sort(function (a, b) { return b.s - a.s; });

        if (!hits.length) {
          hits = posts
            .map(function (p) { return { post: p, s: fuzzyScorePost(p, terms) }; })
            .filter(function (h) { return h.s > 0; })
            .sort(function (a, b) { return b.s - a.s; });
        }

        list = hits.slice(0, 20).map(function (h) { return h.post; });
        metaEl.textContent = list.length ? '找到 ' + hits.length + ' 篇相关文章' : '未找到与“' + q + '”相关的文章';
      }

      currentItems = list;
      if (!list.length) {
        resultsEl.innerHTML = '';
        selectedIndex = -1;
        return;
      }

      resultsEl.innerHTML = list.map(function (p, i) {
        var subParts = [p.date]
          .concat(p.categories || [])
          .concat((p.tags || []).slice(0, 4).map(function (t) { return '#' + t; }))
          .filter(Boolean);
        var snippetText = buildSnippet(p, terms);
        return (
          '<a class="search-modal-item' + (i === 0 ? ' is-selected' : '') + '" href="' + escapeHtml(p.url) + '" role="option" aria-selected="' + (i === 0 ? 'true' : 'false') + '" data-index="' + i + '">' +
            '<div class="search-modal-title">' + highlightTerms(p.title, terms) + '</div>' +
            (subParts.length ? '<div class="search-modal-sub">' + escapeHtml(subParts.join(' · ')) + '</div>' : '') +
            (snippetText ? '<div class="search-modal-snippet">' + highlightTerms(snippetText, terms) + '</div>' : '') +
          '</a>'
        );
      }).join('');

      selectedIndex = 0;
    }

    function ensureIndexLoaded() {
      if (posts || loading) return;
      loading = true;
      loadError = false;
      metaEl.textContent = '正在加载搜索索引…';
      fetch(indexUrl)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          posts = (data && data.posts) || [];
          loading = false;
          renderResults(input.value);
        })
        .catch(function () {
          loading = false;
          loadError = true;
          renderResults(input.value);
        });
    }

    function openModal() {
      if (isOpen()) return;
      lastFocused = document.activeElement;
      modal.hidden = false;
      modal.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      ensureIndexLoaded();
      if (posts) renderResults(input.value);
      window.requestAnimationFrame(function () {
        input.focus();
        input.select();
      });
    }

    function closeModal() {
      if (!isOpen()) return;
      modal.classList.remove('is-open');
      modal.hidden = true;
      document.body.style.overflow = '';
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
      lastFocused = null;
    }

    if (trigger) {
      trigger.addEventListener('click', openModal);
    }

    modal.addEventListener('click', function (e) {
      if (e.target.closest('[data-close-modal]')) {
        closeModal();
      }
    });

    resultsEl.addEventListener('mousemove', function (e) {
      var item = e.target.closest('.search-modal-item');
      if (!item) return;
      var idx = parseInt(item.getAttribute('data-index'), 10);
      if (!isNaN(idx) && idx !== selectedIndex) {
        setSelected(idx);
      }
    });

    input.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        renderResults(input.value);
      }, 60);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected(selectedIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected(selectedIndex - 1);
      } else if (e.key === 'Enter') {
        if (selectedIndex >= 0 && currentItems[selectedIndex]) {
          e.preventDefault();
          window.location.href = currentItems[selectedIndex].url;
        }
      }
    });

    document.addEventListener('keydown', function (e) {
      var key = (e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'k') {
        e.preventDefault();
        if (isOpen()) closeModal();
        else openModal();
        return;
      }
      if (e.key === 'Escape' && isOpen()) {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isOpen() && !isEditableTarget(document.activeElement)) {
        var lb = document.getElementById('lightbox');
        if (lb && lb.classList.contains('is-open')) return;
        e.preventDefault();
        openModal();
      }
    });
  }

  /* ------------------------------------------------------------------
   * 2. 文章目录 (TOC) + Scroll-Spy
   * ------------------------------------------------------------------ */
  function initArticleToc() {
    var prose = document.querySelector('.article .prose');
    var aside = document.getElementById('toc-aside');
    var mobile = document.getElementById('toc-mobile');
    if (!prose || (!aside && !mobile)) return;

    var headings = Array.prototype.slice.call(prose.querySelectorAll('h2, h3'));
    if (headings.length < 2) return;

    var usedIds = Object.create(null);
    headings.forEach(function (h, idx) {
      var id = (h.getAttribute('id') || '').trim();
      if (!id) {
        var raw = (h.textContent || '')
          .trim()
          .toLowerCase()
          .replace(/[^\w\u4E00-\u9FFF\u3400-\u4DBF-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        id = raw || 'section-' + (idx + 1);
      }
      var unique = id;
      var suffix = 2;
      while (usedIds[unique]) {
        unique = id + '-' + suffix;
        suffix += 1;
      }
      usedIds[unique] = true;
      if (h.id !== unique) h.id = unique;
    });

    function populateNav(navEl) {
      if (!navEl) return [];
      var frag = document.createDocumentFragment();
      var links = [];
      headings.forEach(function (h) {
        var a = document.createElement('a');
        a.className = 'toc-link' + (h.tagName === 'H3' ? ' is-h3' : '');
        a.href = '#' + h.id;
        a.setAttribute('data-toc-id', h.id);
        a.textContent = (h.textContent || '').trim();
        frag.appendChild(a);
        links.push(a);
      });
      navEl.innerHTML = '';
      navEl.appendChild(frag);
      return links;
    }

    var desktopNav = aside ? aside.querySelector('.toc-nav') : null;
    var mobileNav = mobile ? mobile.querySelector('.toc-mobile-nav') : null;
    var desktopLinks = populateNav(desktopNav);
    var mobileLinks = populateNav(mobileNav);

    if (aside) aside.hidden = false;
    if (mobile) {
      mobile.hidden = false;
      if (mobileNav) {
        mobileNav.addEventListener('click', function (e) {
          if (e.target.closest('.toc-link')) {
            mobile.open = false;
          }
        });
      }
    }

    var activeId = null;
    var stickyContainer = aside ? aside.querySelector('.toc-sticky') : null;

    function setActive(id) {
      if (!id || id === activeId) return;
      activeId = id;

      var all = desktopLinks.concat(mobileLinks);
      for (var i = 0; i < all.length; i++) {
        var isCurrent = all[i].getAttribute('data-toc-id') === id;
        all[i].classList.toggle('is-active', isCurrent);
        if (isCurrent) {
          all[i].setAttribute('aria-current', 'location');
        } else {
          all[i].removeAttribute('aria-current');
        }
      }

      if (stickyContainer && desktopNav) {
        var activeLink = desktopNav.querySelector('.toc-link.is-active');
        if (activeLink) {
          var cRect = stickyContainer.getBoundingClientRect();
          var lRect = activeLink.getBoundingClientRect();
          if (lRect.top < cRect.top + 16 || lRect.bottom > cRect.bottom - 16) {
            activeLink.scrollIntoView({ block: 'nearest' });
          }
        }
      }
    }

    var ticking = false;
    function updateActiveHeading() {
      ticking = false;
      var offset = 110;
      var current = headings[0].id;

      for (var i = 0; i < headings.length; i++) {
        var rect = headings[i].getBoundingClientRect();
        if (rect.top <= offset) {
          current = headings[i].id;
        } else {
          break;
        }
      }

      var nearBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 24;
      if (nearBottom) {
        current = headings[headings.length - 1].id;
      }

      setActive(current);
    }

    function onScroll() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(updateActiveHeading);
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('hashchange', onScroll);
    updateActiveHeading();
  }

  /* ------------------------------------------------------------------
   * 3. 代码块增强（语言标签 + 一键复制）
   * ------------------------------------------------------------------ */
  function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else reject(new Error('copy failed'));
      } catch (err) {
        document.body.removeChild(ta);
        reject(err);
      }
    });
  }

  function extractCodeText(container) {
    var codePre = container.querySelector('.code pre') || container.querySelector('pre') || container;
    var lines = codePre.querySelectorAll('.line');
    if (lines && lines.length) {
      return Array.prototype.map.call(lines, function (el) {
        return el.textContent;
      }).join('\n');
    }
    return codePre.textContent || '';
  }

  function detectLanguageFromFigure(fig) {
    var cls = Array.prototype.slice.call(fig.classList || []);
    for (var i = 0; i < cls.length; i++) {
      var c = cls[i];
      if (!c || c === 'highlight') continue;
      if (c === 'plaintext' || c === 'plain' || c === 'nohighlight') return 'text';
      return c.replace(/^language-/, '');
    }
    var code = fig.querySelector('code[class*="language-"]');
    if (code) {
      var match = code.className.match(/language-([^\s]+)/);
      if (match && match[1]) {
        return match[1] === 'plaintext' ? 'text' : match[1];
      }
    }
    return 'text';
  }

  function createCodeHeader(lang, getCodeFn) {
    var header = document.createElement('div');
    header.className = 'code-header';

    var langSpan = document.createElement('span');
    langSpan.className = 'code-lang';
    langSpan.textContent = lang || 'text';

    var btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.setAttribute('aria-label', '复制代码');

    var resetTimer = null;
    btn.addEventListener('click', function () {
      var code = getCodeFn();
      copyToClipboard(code).then(function () {
        btn.textContent = '已复制';
        btn.classList.add('is-copied');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () {
          btn.textContent = '复制';
          btn.classList.remove('is-copied');
        }, 1800);
      }).catch(function () {
        btn.textContent = '复制失败';
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () {
          btn.textContent = '复制';
        }, 1800);
      });
    });

    header.appendChild(langSpan);
    header.appendChild(btn);
    return header;
  }

  function initCodeBlocks() {
    var figures = document.querySelectorAll('.prose figure.highlight');
    Array.prototype.forEach.call(figures, function (fig) {
      if (fig.querySelector('.code-header')) return;
      var lang = detectLanguageFromFigure(fig);
      var header = createCodeHeader(lang, function () {
        return extractCodeText(fig);
      });
      fig.insertBefore(header, fig.firstChild);
    });

    var standalonePres = document.querySelectorAll('.prose > pre');
    Array.prototype.forEach.call(standalonePres, function (pre) {
      if (pre.closest('figure.highlight') || pre.querySelector('.code-header')) return;
      var codeEl = pre.querySelector('code');
      var lang = 'text';
      if (codeEl && codeEl.className) {
        var m = codeEl.className.match(/(?:language-|lang-)([^\s]+)/);
        if (m && m[1]) lang = m[1] === 'plaintext' ? 'text' : m[1];
      }
      var wrapper = document.createElement('figure');
      wrapper.className = 'highlight ' + lang;
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(createCodeHeader(lang, function () {
        return extractCodeText(pre);
      }));
      wrapper.appendChild(pre);
    });
  }

  /* ------------------------------------------------------------------
   * 4. 响应式表格包装
   * ------------------------------------------------------------------ */
  function initResponsiveTables() {
    var tables = document.querySelectorAll('.prose table');
    Array.prototype.forEach.call(tables, function (table) {
      if (table.closest('.highlight') || table.closest('.table-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  /* ------------------------------------------------------------------
   * 5. 图片题注与全屏灯箱 (Lightbox)
   * ------------------------------------------------------------------ */
  function initImagesAndLightbox() {
    var images = document.querySelectorAll('.prose img');
    if (!images.length) return;

    Array.prototype.forEach.call(images, function (img) {
      if (!img.getAttribute('loading')) {
        img.setAttribute('loading', 'lazy');
      }

      var parent = img.parentElement;
      if (parent && parent.tagName === 'P' && !parent.closest('.prose-figure')) {
        var onlyImg = true;
        for (var i = 0; i < parent.childNodes.length; i++) {
          var node = parent.childNodes[i];
          if (node === img) continue;
          if (node.nodeType === 3 && !node.nodeValue.trim()) continue;
          onlyImg = false;
          break;
        }
        if (onlyImg) {
          var figure = document.createElement('figure');
          figure.className = 'prose-figure';
          parent.parentNode.insertBefore(figure, parent);
          figure.appendChild(img);

          var altText = (img.getAttribute('alt') || '').trim();
          if (altText) {
            var caption = document.createElement('figcaption');
            caption.className = 'prose-caption';
            caption.textContent = altText;
            figure.appendChild(caption);
          }
          parent.parentNode.removeChild(parent);
        }
      }
    });

    var lightbox = null;
    var lbImg = null;
    var lbCaption = null;
    var lbClose = null;
    var lastFocused = null;

    function ensureLightbox() {
      if (lightbox) return;
      lightbox = document.createElement('div');
      lightbox.className = 'lightbox';
      lightbox.id = 'lightbox';
      lightbox.setAttribute('role', 'dialog');
      lightbox.setAttribute('aria-modal', 'true');
      lightbox.setAttribute('aria-label', '图片预览');
      lightbox.setAttribute('aria-hidden', 'true');

      lbClose = document.createElement('button');
      lbClose.className = 'lightbox-close';
      lbClose.type = 'button';
      lbClose.setAttribute('aria-label', '关闭预览');
      lbClose.textContent = '×';

      lbImg = document.createElement('img');
      lbImg.className = 'lightbox-img';
      lbImg.alt = '';

      lbCaption = document.createElement('div');
      lbCaption.className = 'lightbox-caption';

      lightbox.appendChild(lbClose);
      lightbox.appendChild(lbImg);
      lightbox.appendChild(lbCaption);
      document.body.appendChild(lightbox);

      lbClose.addEventListener('click', closeLightbox);
      lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox) {
          closeLightbox();
        }
      });
    }

    function openLightbox(img) {
      ensureLightbox();
      lastFocused = document.activeElement;
      lbImg.src = img.currentSrc || img.src;
      var captionText = (img.getAttribute('alt') || '').trim();
      lbImg.alt = captionText;
      lbCaption.textContent = captionText;
      lbCaption.hidden = !captionText;
      lightbox.classList.add('is-open');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      lbClose.focus();
    }

    function closeLightbox() {
      if (!lightbox || !lightbox.classList.contains('is-open')) return;
      lightbox.classList.remove('is-open');
      lightbox.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
      lastFocused = null;
    }

    Array.prototype.forEach.call(images, function (img) {
      img.addEventListener('click', function (e) {
        if (img.closest('a')) return;
        e.preventDefault();
        openLightbox(img);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && lightbox && lightbox.classList.contains('is-open')) {
        e.preventDefault();
        closeLightbox();
      }
    });
  }

  /* ------------------------------------------------------------------
   * 6. 返回顶部平滑滚动
   * ------------------------------------------------------------------ */
  function initBackToTop() {
    var link = document.querySelector('.back-to-top');
    if (!link) return;
    link.addEventListener('click', function (e) {
      e.preventDefault();
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }

  function boot() {
    initSearchModal();
    initArticleToc();
    initCodeBlocks();
    initResponsiveTables();
    initImagesAndLightbox();
    initBackToTop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
