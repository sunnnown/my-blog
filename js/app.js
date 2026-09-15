(function () {
  var listEl = document.getElementById('post-list');

  fetch('posts/posts.json')
    .then(function (res) {
      if (!res.ok) throw new Error('posts.json을 불러올 수 없습니다.');
      return res.json();
    })
    .then(function (posts) {
      posts.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

      if (posts.length === 0) {
        listEl.innerHTML = '<li class="post-list-status">아직 작성된 글이 없습니다.</li>';
        return;
      }

      listEl.innerHTML = posts.map(function (post) {
        var slug = post.file.replace(/\.md$/, '');
        return (
          '<li class="post-card">' +
            '<a href="post.html?slug=' + encodeURIComponent(slug) + '">' +
              '<h2>' + escapeHtml(post.title) + '</h2>' +
            '</a>' +
            '<time datetime="' + post.date + '">' + formatDate(post.date) + '</time>' +
            '<p>' + escapeHtml(post.excerpt || '') + '</p>' +
          '</li>'
        );
      }).join('');
    })
    .catch(function (err) {
      listEl.innerHTML = '<li class="post-list-status">글 목록을 불러오지 못했습니다: ' + escapeHtml(err.message) + '</li>';
    });

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
