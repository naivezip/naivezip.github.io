'use strict';

/* 阅读统计 Helper：统计中文字符 + 英文/数字词数，估算阅读时间 */

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
      var code = parseInt(hex, 16);
      return isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#([0-9]+);/g, function (_, dec) {
      var code = parseInt(dec, 10);
      return isFinite(code) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&[a-z]+;/gi, ' ');
}

function stripContent(html) {
  var text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<td[^>]*class="[^"]*gutter[^"]*"[^>]*>[\s\S]*?<\/td>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

hexo.extend.helper.register('reading_stats', function (content) {
  var text = stripContent(content);
  var cjkRegex = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
  var cjkMatches = text.match(cjkRegex);
  var cjkCount = cjkMatches ? cjkMatches.length : 0;

  var withoutCjk = text.replace(cjkRegex, ' ');
  var latinMatches = withoutCjk.match(/[A-Za-z0-9]+(?:['’_-][A-Za-z0-9]+)*/g);
  var latinCount = latinMatches ? latinMatches.length : 0;

  var words = cjkCount + latinCount;
  var minutes = Math.max(1, Math.round(words / 350));
  var formatted = words.toLocaleString('en-US') + ' 字 · 约 ' + minutes + ' 分钟';

  return {
    words: words,
    minutes: minutes,
    formatted: formatted
  };
});
