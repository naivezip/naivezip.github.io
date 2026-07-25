'use strict';

/* 生成 /search.json：全站文章的本地搜索索引 */

function strip(str) {
  return String(str || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

hexo.extend.generator.register('search-index', function (locals) {
  var posts = locals.posts.sort('-date').map(function (post) {
    return {
      title: post.title || '(无标题)',
      url: hexo.config.root + post.path,
      date: post.date ? post.date.format('YYYY-MM-DD') : '',
      categories: post.categories ? post.categories.map(function (c) { return c.name; }) : [],
      tags: post.tags ? post.tags.map(function (t) { return t.name; }) : [],
      excerpt: strip(post.excerpt).slice(0, 200),
      content: strip(post.content).slice(0, 3000)
    };
  });
  return {
    path: 'search.json',
    data: JSON.stringify({ posts: posts })
  };
});
