### BLOG_SPEC: Notion → GitHub Pages 자동 발행 파이프라인

- **목표**: 매일 1회 Notion에 아카이빙된 학습 노트 중, `블로그에 올림` 마크가 없는 페이지만 선별하여 LLM으로 지정 양식에 맞게 리라이트한 뒤, GitHub Pages(블로그)로 안전하게 발행한다.
- **핵심 가치**: 자동화(스케줄), 안전성(리뷰/PR/드래프트), 일관성(템플릿, 스타일가이드), 추적성(로그·알림·상태 동기화), 재시도/중복 방지.

---

## 1) 요구사항

- **소스**: Notion 데이터베이스(학습 노트). 필수 속성
  - **제목**: `title`
  - **상태 플래그**: `블로그에 올림`(checkbox)
  - (선택) `태그`, `요약`, `카테고리`, `표지 이미지`, `원문 링크`, `초안 여부`
- **필터**: `블로그에 올림 == false` 인 페이지만 대상
- **주기**: 매일 1회(KST 22:00)
- **산출물**: GitHub Pages용 Markdown(프론트매터 + 본문)
- **형식**: 팀 표준 템플릿(아래 5장에서 정의)으로 LLM이 리라이트
- **발행 전략**: 기본은 PR 생성(리뷰 후 머지). 선택적으로 자동 머지/드래프트 지원
- **상태 동기화**: 발행 성공 시 Notion의 `블로그에 올림`을 true로 갱신하고, 포스트 URL 백링크 저장

---

## 2) 아키텍처 개요(최신 LLM 트렌드 반영)

- **오케스트레이션 레이어**
  - 기본: **GitHub Actions** (cron + workflow_dispatch, 캐시/권한/컨커런시/시크릿 관리, self-hosted runner 옵션)
- **LLM 레이어**
  - 선호: 구조적 출력(JSON Schema) + 평가(셀프리뷰) + 캐싱
  - 모델 선택: Claude 3.5 Sonnet / GPT-4.1 / o4-mini / Llama 3.1 70B 등 공급자 다중화
  - 프롬프트 전략: 시스템 프롬프트에 스타일가이드/템플릿 명시, 출력은 JSON Schema 강제
  - **Self-Review 루프(선택)**: 1차 초안 → 비평 프롬프트 → 개선안 반영(1회)
  - **Prompt Caching**: 장문 입력 시 비용 절감(지원 모델에 한함)
- **빌드/배포 레이어**
  - Hugo + GitHub Pages(액션으로 빌드/배포)

---

## 2.1) 결정 필요 사항

- LLM 제공자/모델: 결정됨 → **OpenAI(기본) + Gemini(폴백)**, 모델은 환경변수로 지정(`OPENAI_MODEL`, `GEMINI_MODEL`)
- LLM 호출 방식: **직접 API 호출**(GitHub Actions의 Node 스크립트에서 수행)
- 배치 크기: 1회 실행당 최대 5건(권장: 3~5)
- 슬러그 규칙: 제목 기반 스네이크/케밥 케이스, 중복 시 넘버링
- Hugo 구조: Page Bundle
- 이미지 처리: Notion 파일 다운로드, 경로(`content/posts/<slug>/images/`)
- PR 정책: 자동 머지
- 스케줄: 22:00 KST
- 태그/카테고리 매핑: Notion 속성명 고정
- canonicalURL 규칙: 원문 링크 우선
- PR 라벨 포맷: `blog`, `cat:<카테고리 소문자>` (예: `TypeScript` → `cat:typescript`)

---

## 3) 데이터 흐름(Flow)

1. **스케줄 트리거**: GitHub Actions cron 또는 수동 실행(workflow_dispatch)
2. **Notion 쿼리**: `블로그에 올림 == false` 인 페이지 목록 조회(최대 N개/회)
3. **콘텐츠 수집**: Notion Blocks → Markdown 변환(코드블록/이미지/수식 보존)
4. **LLM 리라이트**:
   - 입력: 원문 Markdown, 메타(태그/카테고리), 스타일가이드, 템플릿 스펙(JSON Schema)
   - 출력: `BlogPost` JSON(제목/슬러그/요약/태그/본문 Markdown/표지/메타)
   - 안전장치: 구조 검증(JSON Schema), 길이/토큰 제한, 금칙어/PII 검사
5. **후처리**:
   - 프론트매터(YAML) + 본문 합성
   - 슬러그/파일명 생성 규칙 적용
   - 내부 링크·이미지 경로 정규화(필요 시 이미지 다운로드/리사이즈)
6. **퍼블리시**:
   - 리포지토리 체크아웃 → 브랜치 생성 → 포스트 추가 → 커밋/푸시 → PR 생성(`peter-evans/create-pull-request`)
   - 옵션: 자동 병합 또는 드래프트 폴더로 저장
7. **상태 동기화**:
   - 기본: PR 머지 후 워크플로가 Notion에 `블로그에 올림 = true`, `postUrl`(게시 URL) 업데이트
   - 대안: PR 생성 시 임시로 PR URL 저장, 머지 후 게시 URL로 갱신
8. **알림/로깅**: Slack/Telegram/Webhook으로 결과 요약(성공/건수/에러 링크)
9. **재시도/중복방지**: Notion Page ID 기반 idempotency 키 관리

사전 단계(권장): 실행 초기에 DB 스키마 보정 단계 수행

- `블로그에 올림`(checkbox) 속성이 없으면 자동 생성
- 페이지 필터는 `checkbox does_not_equal: true`로 구성(null 포함 미발행 인식)

---

## 4) 구성 요소 세부(GitHub Actions + Hugo 최소화)

- **Notion**

  - 데이터베이스 스키마(예시)
    - `title`(Title), `블로그에 올림`(Checkbox), `태그`(Multi-select), `요약`(Text), `카테고리`(Select), `표지`(URL), `원문 링크`(URL)
  - 필터: `블로그에 올림 == false`
  - 원천 구조: `SMS Dictionary` 데이터베이스 내부에 여러 주제(= 카테고리)가 있고, 각 노트는 해당 카테고리에 소속
    - 카테고리 추출: 기본은 DB의 `카테고리`(Select) 사용
    - (대안) `카테고리` 속성이 비어있다면 상위 페이지/뷰의 그룹명을 추론하여 보정
  - 제목 정책: LLM이 콘텐츠를 대표하는 **새로운 제목**을 생성(원문 페이지 제목과 달라도 됨)

- **LLM 서비스(게이트웨이)**

  - 입력: `sourceMarkdown`, `meta`, `styleGuide`, `schemaVersion`
  - 출력: `BlogPost` JSON(스키마 준수)
  - 호출 전략: **OpenAI 기본 → 실패 시 Gemini 폴백**(타임아웃/429/5xx/스키마 불일치 시 순차 폴백)
  - 선택: Self-Review 1회, 캐시, 레이트리밋

- **블로그 리포지토리**

  - 구조 예시(`Hugo`, Page Bundle 권장):
    - `content/posts/<slug>/index.md` (포스트 본문)
    - `content/posts/<slug>/*` (해당 포스트 전용 이미지/첨부)
    - `static/` (공용 정적 자산)
  - 대안(싱글 파일): `content/posts/<date>-<slug>.md` + `static/`에 이미지 배치

- **오케스트레이터(GitHub Actions)**
  - 워크플로: `.github/workflows/daily-blog.yml` (schedule + workflow_dispatch)
  - 스텝: checkout → setup-node → deps 설치 → ensure-notion-schema → notion-export → PR 생성(라벨: blog + 카테고리) → 자동 머지 → 알림
  - 라벨 규칙: `blog`, `cat:<category.toLowerCase()>`
  - 권한/시크릿: `contents: write`, `pull-requests: write` / `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `LLM_API_KEY`, `SLACK_WEBHOOK_URL`
  - 컨커런시/캐시: `concurrency` 설정, actions/cache 사용

---

## 5) 템플릿/출력 스키마(권장)

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "BlogPost",
  "type": "object",
  "required": ["title", "slug", "summary", "content"],
  "properties": {
    "title": { "type": "string", "minLength": 3 },
    "slug": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "summary": { "type": "string", "minLength": 20 },
    "tags": { "type": "array", "items": { "type": "string" }, "default": [] },
    "category": { "type": "string" },
    "coverImage": { "type": "string", "format": "uri", "nullable": true },
    "draft": { "type": "boolean", "default": false },
    "canonicalUrl": { "type": "string", "format": "uri", "nullable": true },
    "seo": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "description": { "type": "string" },
        "keywords": { "type": "array", "items": { "type": "string" } },
      },
    },
    "content": { "type": "string", "description": "Markdown 본문(헤더/목차/코드블록 포함)" },
    "tldr": { "type": "array", "items": { "type": "string" }, "minItems": 3 },
    "references": {
      "type": "array",
      "items": { "type": "string", "format": "uri" },
      "default": [],
    },
  },
}
```

프론트매터 합성 예시(Hugo):

```yaml
---
title: "{{title}}"
date: "{{dateISO}}"
draft: {{draft}}
description: "{{summary}}"
tags: {{tags}}
categories: ["{{category}}"]
slug: "{{slug}}"
cover:
  image: "{{coverImage}}"
  alt: "{{title}}"
canonicalURL: "{{canonicalUrl}}"
---

> TL;DR
{{#each tldr}}
- {{this}}
{{/each}}

{{content}}

{{#if references}}
## 참고자료
{{#each references}}
- {{this}}
{{/each}}
{{/if}}
```

---

## 6) 프롬프트(권장 초안)

```text
시스템: 당신은 시니어 테크 라이터입니다. 아래 스타일가이드와 템플릿을 엄격히 준수하여, 입력 Markdown을 블로그 게시물로 리라이트하세요. 항상 JSON Schema에 맞는 구조적 출력을 생성합니다. 코드블록/표/수식은 손상 없이 보존하고, 한국어로 자연스럽게 다듬습니다.

스타일가이드:
- 독자가 실무에 바로 적용할 수 있도록 맥락/사례/코드를 포함
- 불필요한 수식어 최소화, 핵심을 먼저, 근거/링크 첨부
- 제목은 검색/공유 친화적으로, 요약은 140~200자

출력: BlogPost(JSON) — 위 스키마를 반드시 준수

사용자 입력:
- meta: {title, tags, category, coverImage, canonicalUrl?}
- sourceMarkdown: (Notion에서 추출된 원문)
```

Self-Review 프롬프트(선택):

```text
다음 BlogPost 초안의 품질을 검토하고 개선 포인트를 제안하세요.
- 제목의 검색성, 요약의 명확성, TL;DR의 실행 가능성, 본문 흐름, 코드 정확성
출력: {improvements: string[], risks: string[]}
```

---

## 7) 퍼블리시 규칙(Hugo)

- **파일 구조**: Page Bundle 권장 → `content/posts/<slug>/index.md`
- **슬러그/링크**: 프론트매터 `slug` 사용(테마 규약에 맞게)
- **표지 이미지**: `content/posts/<slug>/cover.*` 또는 front matter `cover.image`
- **중복 방지**: Notion Page ID ↔ 포스트 경로 매핑 파일(`notion-blog-index.json`) 유지
- **PR 전략**: Conventional Commits
  - `feat(blog): publish <slug> from notion(<pageId>)`
- **자동화 안전장치**
  - 새 포스트는 기본 PR 생성 → 수동 리뷰 후 머지(초기 안정화 단계)
  - 옵션: `draft: true`로 먼저 공개 저장소에 커밋, 사이트에서 비공개 처리

---

## 8) 오류 처리/관측

- **재시도**: 네트워크/429/5xx는 지수 백오프 3회
- **유효성**: JSON Schema 불일치 시 원문/LLM 응답 아카이브 후 실패 처리
- **로그/알림**: 실행 요약, 생성 포스트 목록, 실패 사유를 Slack/Webhook으로 통지
- **추적성**: 각 실행 runId, 대상 pageId, 생성 브랜치/PR URL, 게시 URL 기록

---

## 9) 보안/시크릿

- Notion API Key, LLM Provider 키는 GitHub Secrets 보관(`NOTION_TOKEN`, `NOTION_DATABASE_ID`, `LLM_API_KEY`, `SLACK_WEBHOOK_URL`)
- 최소 권한 원칙(리포지토리: 콘텐츠 전용)
- LLM 프롬프트/응답에 민감정보가 포함되지 않도록 PII 스캐너(선택)

---

## 10) GitHub Actions 워크플로 설계(예시)

`.github/workflows/daily-blog.yml`

```yaml
name: Daily Notion → Blog

on:
  schedule:
    - cron: '0 13 * * *' # 매일 22:00 KST
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: blog-daily
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Cache deps
        uses: actions/cache@v4
        with:
          path: |
            ~/.npm
            node_modules
          key: ${{ runner.os }}-node-${{ hashFiles('**/package-lock.json') }}

      - run: npm ci

      - name: Ensure Notion schema
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
          NOTION_DATABASE_ID: ${{ secrets.NOTION_DATABASE_ID }}
        run: node scripts/ensure-notion-schema.js

      - name: Run notion export → rewrite → compose (Hugo)
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
          NOTION_DATABASE_ID: ${{ secrets.NOTION_DATABASE_ID }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          LLM_PROVIDER: openai
          OPENAI_MODEL: gpt-4.1-mini
          GEMINI_MODEL: gemini-1.5-pro
        run: node scripts/notion-export.js # Hugo용으로 content/posts/<slug>/index.md 생성 (OpenAI 기본, Gemini 폴백)

      - name: Export meta for labels
        id: export_meta
        run: |
          echo "category_label=cat:${{ steps.notional.outputs.category_slug }}" >> $GITHUB_OUTPUT

      - name: Create PR
        uses: peter-evans/create-pull-request@v6
        id: cpr
        with:
          branch: chore/notion-to-blog
          title: 'chore(blog): publish from Notion'
          commit-message: 'chore(blog): add posts from Notion'
          delete-branch: true
          labels: |
            blog
            ${{ steps.export_meta.outputs.category_label }}

      - name: Merge PR automatically
        uses: peter-evans/enable-pull-request-automerge@v3
        with:
          pull-request-number: ${{ steps.cpr.outputs.pull-request-number }}
          merge-method: squash

      - name: Notify
        if: always()
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: |
          node scripts/notify.js || echo "skip notify"
```

---

## 11) 머지 후 Notion 동기화(권장)

- 목적: 실제 게시(머지) 이후에만 Notion의 `블로그에 올림`을 true로 보증
- 방법: PR 머지 트리거 워크플로(`.github/workflows/on-merge-sync-notion.yml`)

```yaml
name: Sync Notion after merge

on:
  push:
    branches: [main]

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Update Notion flags
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
        run: node scripts/notion-sync.js
```

- 구현 아이디어: `notion-blog-index.json`에 {pageId → postPath/postUrl} 매핑 유지 → main에 포스트 반영되면 해당 pageId들을 찾아 Notion API로 `블로그에 올림=true` 및 `postUrl` 업데이트

---

## 12) 향후 확장

- MCP 기반 단일 에이전트로 완전 이관(도구: Notion/GitHub/Filesystem/Slack)
- 번역 파이프라인(ko→en) 또는 다국어 동시 게시
- OG 이미지 자동 생성(Satori/Vercel OG/Playwright)
- 품질 측정/리그레션(Evals) + 스타일 가드
- 주제 큐레이션/우선순위(태그/인기도 기반)

---

## 13) 체크리스트(최소 구성)

- [ ] Notion DB에 `블로그에 올림`(checkbox) 속성 존재
- [ ] GitHub Secrets 설정: `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `LLM_API_KEY`, `SLACK_WEBHOOK_URL`
- [ ] GitHub Actions에서 스키마 보정 스텝(`scripts/ensure-notion-schema.js`) 실행 확인
- [ ] LLM 게이트웨이 `/rewrite` 엔드포인트 준비(JSON Schema 강제)
- [ ] 블로그 리포 체크아웃/PR 권한 확인
- [ ] 테스트 모드: N=1로 건건이 검증 → 점진 확대
