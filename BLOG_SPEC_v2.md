### BLOG_SPEC v2: Notion → LLM → Hugo(PaperMod) → GitHub Pages

#### 0) 개요

- 매일 KST 22:00에 Notion에서 미발행 노트를 1건 선택 → LLM으로 리라이트 → Hugo Page Bundle 생성 → PR 생성/자동 병합 → Pages 배포 → 머지 후 Notion 상태 동기화.
- Notion API 2025-09-03 기준: database_id 대신 data_source_id 사용.

#### 1) Notion 스키마(데이터소스)

- 필수
  - Title: 타입 Title(이름은 임의). 스크립트가 자동 감지
  - Published 플래그: 타입 Checkbox. 권장 이름 `uploadedOnBlog`(자동 감지 후보: `uploadedOnBlog`, `uploaded_on_blog`, `isUploaded`, `published`, `published_on_blog`)
  - postId: 타입 Text(rich_text). 원본 Notion Page ID 저장(하베스트가 채움)
- 선택
  - category: Select 또는 Multi-select
  - tags: Multi-select
  - summary: Text(rich_text)
  - canonical: URL
  - postUrl: URL(머지 후 게시 URL 저장 권장)

#### 2) 시크릿/환경변수

- 필수: `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID`
- 선택: `NOTION_ROOT_PAGE_ID`(하베스트 루트 페이지), `OPENAI_API_KEY`, `OPENAI_MODEL`(기본 gpt-4.1-mini), `BLOG_BASE_URL`(기본 https://handsupmin.github.io), `NOTION_VERSION`(기본 2025-09-03)

#### 3) 동작 플로우(핵심)

1. Harvest(옵션): `NOTION_ROOT_PAGE_ID` 하위의 카테고리/페이지 트리 순회 → DB에 없으면 생성
   - 중복 판정: `postId`(원본 Page ID) 또는 제목
   - 스키마 자동 감지로 실제 속성명/타입에 맞춰 저장
2. Select & Export: Published 플래그(false)인 항목 최대 10건 쿼리 → 랜덤 1건 선택
3. Convert: Notion Blocks → Markdown(notional-to-md)
4. Rewrite(LLM): OpenAI Chat Completions(JSON 출력)
   - 스타일 가이드(중요)
     - 한국어 자연스러운 말투. 과한 수사/AI 티 금지. 핵심 먼저
     - 줄글(문단) 설명 문장 끝에는 마침표 사용
     - 개념 간단 설명/한줄 요약/리스트는 명사형 종료 또는 음슴체 사용(입니다/합니다 지양)
     - 출력 스키마: BlogPost { title, slug, summary, tags[], category, content, draft(false), canonicalUrl?, tldr[3+], references[] }
   - 실패/빈 본문이면 워크플로 실패 처리(빈 글 방지)
5. Compose(Hugo): `content/posts/<slug>/index.md` 생성(front matter + 본문)
   - front matter: title, date(KST), draft, description, tags, categories, slug, postId, canonicalURL?
   - 매핑: `data/notion-blog-index.json`에 {pageId → slug, path}
6. PR & Merge: 변경사항으로 PR 생성(`peter-evans/create-pull-request`), 자동 병합 활성화
7. Deploy: main 푸시 시 Hugo 빌드/Pages 배포(`hugo-pages.yml`)
8. Sync-back: 머지 후 Notion에 Published 플래그 true, 게시 URL 기록(`on-merge-sync-notion.yml`)

#### 4) 리포지토리 구성

- Hugo: PaperMod 테마(서브모듈). Page Bundle 권장
- 스크립트: `scripts/`
  - `notion-harvest.js`(옵션): 루트 페이지 → DB 동기화(생성 전용, 스키마 자동 감지)
  - `notion-export.js`: 선택→변환→리라이트→합성→매핑
  - `notion-sync.js`: 머지 후 Notion 플래그/URL 동기화
  - `ensure-notion-schema.js`: 접근성/필수 속성 존재 로그 확인

#### 5) GitHub Actions(핵심 스텝만)

- `.github/workflows/daily-blog.yml`
  - schedule: 매일 22:00 KST, workflow_dispatch 지원
  - steps: checkout → setup-node → (옵션) harvest → export(rewrite/compose, 실패 시 중단) → create-pull-request(base: main) → enable auto-merge
  - 권한: Settings → Actions → Workflow permissions = Read and write, “Allow GitHub Actions to create and approve pull requests” 활성화
- `.github/workflows/hugo-pages.yml`
  - main 푸시 시 Hugo 빌드 → Pages 배포
- `.github/workflows/on-merge-sync-notion.yml`
  - main 푸시 시 Notion 플래그/URL 동기화

#### 6) 로컬 테스트

- 하베스트: `NOTION_TOKEN=... NOTION_DATA_SOURCE_ID=... NOTION_ROOT_PAGE_ID=... node scripts/notion-harvest.js`
- 1회 게시: `NOTION_TOKEN=... NOTION_DATA_SOURCE_ID=... OPENAI_API_KEY=... node scripts/notion-export.js`
- 동기화: `NOTION_TOKEN=... NOTION_DATA_SOURCE_ID=... BLOG_BASE_URL=... node scripts/notion-sync.js`

#### 7) 에러/운영 팁

- object_not_found: ID 오입력 또는 통합 공유 미설정(해당 DB/페이지에 Integration 초대)
- validation_error: 스키마 타입/이름 불일치. 하베스트/익스포트는 스키마 자동 감지하나, 권장 스키마 준수 필요
- LLM 실패: 워크플로 실패로 중단(빈 본문 방지). 모델/키/토큰 사용량 확인
- PR 생성 불가: 레포 Actions 권한 또는 PAT 필요

#### 8) 체크리스트

- [ ] Notion 통합에 대상 데이터소스/루트 페이지 공유 완료
- [ ] Secrets: `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID`, (`NOTION_ROOT_PAGE_ID` 선택), `OPENAI_API_KEY`
- [ ] Notion 스키마: Title, Published(Checkbox), postId(Text), (category/tags/summary/canonical/postUrl 선택)
- [ ] Actions 권한: Read and write + PR 생성 허용
- [ ] Pages 소스: GitHub Actions
