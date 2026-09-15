(function () {
  var contentEl = document.getElementById('post-content');
  var params = new URLSearchParams(window.location.search);
  var slug = params.get('slug');

  if (!slug) {
    contentEl.innerHTML = '<p class="post-status">글을 찾을 수 없습니다.</p>';
    return;
  }

  fetch('posts/' + encodeURIComponent(slug) + '.md')
    .then(function (res) {
      if (!res.ok) throw new Error('해당 글을 찾을 수 없습니다.');
      return res.text();
    })
    .then(function (raw) {
      var parsed = parseFrontmatter(raw);
      var title = parsed.data.title || slug;

      document.title = title + ' · My Blog';

      var dateHtml = parsed.data.date
        ? '<time class="post-date" datetime="' + parsed.data.date + '">' + formatDate(parsed.data.date) + '</time>'
        : '';

      contentEl.innerHTML =
        '<h1 class="post-title">' + title + '</h1>' +
        dateHtml +
        '<div class="post-body">' + marked.parse(parsed.content) + '</div>';
    })
    .catch(function (err) {
      contentEl.innerHTML = '<p class="post-status">' + err.message + '</p>';
    });
})();
