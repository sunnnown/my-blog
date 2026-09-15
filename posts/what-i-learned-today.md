---
title: 오늘 배운 것
date: 2026-09-15
excerpt: 클로드 코드로 블로그를 만들면서 정리한 HTML, CSS, JavaScript의 역할.
---

클로드 코드로 이 블로그를 만들면서, 프레임워크 없이도 HTML·CSS·JavaScript가 각자 어떤 역할을 맡는지 다시 정리하게 되었습니다.

## HTML — 구조와 내용

`index.html`과 `post.html`은 페이지의 뼈대만 담당합니다. 실제 글 목록이나 본문은 처음부터 담겨 있지 않고, 나중에 JavaScript가 채워 넣을 빈 자리(`<ul id="post-list">`, `<article id="post-content">`)만 마련해 둡니다.

## CSS — 스타일과 반응형

`style.css`는 화면에 어떻게 보일지를 결정합니다.

- CSS 변수(`--bg`, `--text` 등)로 라이트/다크 테마의 색상을 한곳에서 관리
- `prefers-color-scheme`으로 시스템 설정을 기본값으로 따르고, `data-theme` 속성으로 수동 토글을 덮어씀
- `max-width`와 미디어 쿼리로 데스크톱과 모바일 모두에서 읽기 편한 레이아웃 유지

## JavaScript — 데이터를 가져와 화면을 채우기

정적 HTML/CSS만으로는 마크다운 파일을 읽을 수 없기 때문에, JavaScript가 다음을 처리합니다.

1. `posts.json`을 읽어 글 목록을 렌더링
2. 클릭한 글의 마크다운 파일을 `fetch`로 가져오고, frontmatter(제목·날짜)와 본문을 분리
3. 본문을 HTML로 변환해 페이지에 삽입
4. 테마 토글 버튼 클릭을 감지해 `localStorage`에 저장하고 다시 적용

결국 HTML은 뼈대, CSS는 외형, JavaScript는 데이터와 동작을 담당한다는 원칙은 프레임워크를 쓰지 않아도 그대로 적용된다는 걸 느꼈습니다.
