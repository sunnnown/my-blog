// Parses a leading `--- ... ---` frontmatter block out of raw markdown text.
function parseFrontmatter(raw) {
  var match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };

  var data = {};
  match[1].split('\n').forEach(function (line) {
    var idx = line.indexOf(':');
    if (idx === -1) return;
    var key = line.slice(0, idx).trim();
    var value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    data[key] = value;
  });

  return { data: data, content: match[2] };
}

function formatDate(dateStr) {
  var date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}
