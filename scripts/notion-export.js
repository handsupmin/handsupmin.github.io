#!/usr/bin/env node
import { Client } from "@notionhq/client";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import fs from "fs";
import matter from "gray-matter";
import { NotionToMarkdown } from "notion-to-md";
import OpenAI from "openai";
import path from "path";
import slugify from "slugify";

const notionToken = process.env.NOTION_TOKEN;
const dataSourceIdEnv = process.env.NOTION_DATA_SOURCE_ID;
const notionVersion = process.env.NOTION_VERSION || "2025-09-03";

if (!notionToken || !dataSourceIdEnv) {
  console.error("Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID");
  process.exit(1);
}

dayjs.extend(utc);
dayjs.extend(timezone);
const notion = new Client({ auth: notionToken, notionVersion });
const n2m = new NotionToMarkdown({ notionClient: notion });
const llmProvider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || "gpt-5-mini";
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

const dataSourceId = dataSourceIdEnv;
let publishedPropName = process.env.NOTION_PUBLISHED_PROP || null;
let categoryProp = { name: null, type: null };

async function resolvePublishedKey() {
  if (publishedPropName) return publishedPropName;
  const ds = await notion.request({
    method: "GET",
    path: `data_sources/${dataSourceId}`,
  });
  const props = ds?.properties || {};
  const candidates = [
    "uploadedOnBlog",
    "uploaded_on_blog",
    "isUploaded",
    "published",
    "published_on_blog",
  ];
  for (const name of candidates) {
    if (props[name]?.type === "checkbox") {
      publishedPropName = name;
      return publishedPropName;
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if (v?.type === "checkbox") {
      publishedPropName = k;
      return publishedPropName;
    }
  }
  throw new Error("No checkbox property found to indicate published status.");
}

async function queryOneRandom() {
  const id = dataSourceId;
  const prop = await resolvePublishedKey();
  const res = await notion.request({
    method: "POST",
    path: `data_sources/${id}/query`,
    body: {
      filter: {
        property: prop,
        checkbox: { equals: false },
      },
      page_size: 10,
    },
  });
  const results = res?.results || [];
  if (results.length === 0) return null;
  const pick = results[Math.floor(Math.random() * results.length)];
  return pick;
}

async function resolveCategoryProperty() {
  if (categoryProp.name) return categoryProp;
  const ds = await notion.request({
    method: "GET",
    path: `data_sources/${dataSourceId}`,
  });
  const props = ds?.properties || {};
  const candidateKeys = ["category", "카테고리"];
  for (const key of candidateKeys) {
    if (props[key]?.type === "select" || props[key]?.type === "multi_select") {
      categoryProp = { name: key, type: props[key].type };
      return categoryProp;
    }
  }
  for (const [k, v] of Object.entries(props)) {
    if (v?.type === "select" || v?.type === "multi_select") {
      categoryProp = { name: k, type: v.type };
      return categoryProp;
    }
  }
  return categoryProp; // {name:null}
}

async function queryOneRandomWithPriority() {
  const id = dataSourceId;
  const publishedKey = await resolvePublishedKey();
  const cat = await resolveCategoryProperty();
  const priorityCategories = [
    "Typescript",
    "NFT",
    "Blockchain",
    "NestJS",
    "MySQL (InnoDB)",
    "k8s",
    "NodeJS",
    "Prisma",
    "Engineering",
    "Cryptography",
  ];

  if (cat.name) {
    for (const catName of priorityCategories) {
      const categoryFilter =
        cat.type === "select"
          ? { property: cat.name, select: { equals: catName } }
          : { property: cat.name, multi_select: { contains: catName } };
      const res = await notion.request({
        method: "POST",
        path: `data_sources/${id}/query`,
        body: {
          filter: {
            and: [
              { property: publishedKey, checkbox: { equals: false } },
              categoryFilter,
            ],
          },
          page_size: 10,
        },
      });
      const results = res?.results || [];
      if (results.length > 0) {
        return results[Math.floor(Math.random() * results.length)];
      }
    }
  }
  // fallback: no category prop or no results in priority buckets
  return await queryOneRandom();
}

function getTitle(page) {
  return (
    page.properties?.title?.title?.[0]?.plain_text ||
    page.properties?.Name?.title?.[0]?.plain_text ||
    "untitled"
  );
}

async function pageToMarkdown(pageId) {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const res = n2m.toMarkdownString(mdBlocks);
  return (res?.parent || "").trim();
}

function getPropertyByKeys(properties, keys, type) {
  for (const key of keys) {
    const prop = properties?.[key];
    if (!prop) continue;
    if (!type || prop.type === type) return prop;
  }
  return undefined;
}

function extractMeta(page) {
  const properties = page.properties || {};
  const title = getTitle(page);
  const tagsProp = getPropertyByKeys(
    properties,
    ["tags", "태그"],
    "multi_select"
  );
  const catProp = getPropertyByKeys(
    properties,
    ["category", "카테고리"],
    "select"
  );
  const summaryProp = getPropertyByKeys(
    properties,
    ["summary", "핵심 요약"],
    "rich_text"
  );
  const canonicalProp = getPropertyByKeys(
    properties,
    ["canonical", "원문 링크"],
    "url"
  );
  const tags = (tagsProp?.multi_select || [])
    .map((t) => t?.name)
    .filter(Boolean);
  const category = catProp?.select?.name || "";
  const summary = (summaryProp?.rich_text?.[0]?.plain_text || "").trim();
  const canonicalUrl = canonicalProp?.url || null;
  // source page id: prefer rich_text property named 'postId' (case-insensitive)
  let sourcePageId = null;
  for (const [k, v] of Object.entries(properties)) {
    if (k.toLowerCase() === "postid" && v?.type === "rich_text") {
      const txt =
        v.rich_text?.[0]?.plain_text || v.rich_text?.[0]?.text?.content || "";
      sourcePageId = (txt || "").trim();
      break;
    }
  }
  return { title, tags, category, summary, canonicalUrl, sourcePageId };
}

// Traverse Notion blocks under a page to collect child pages (1 level)
async function listChildPagesOnce(parentPageId) {
  const pages = [];
  let hasMore = true;
  let start_cursor = undefined;
  while (hasMore) {
    const resp = await notion.request({
      method: "GET",
      path: `blocks/${parentPageId}/children`,
      query: start_cursor ? { start_cursor } : undefined,
    });
    for (const blk of resp.results || []) {
      if (blk.type === "child_page") {
        pages.push({ id: blk.id, title: blk.child_page?.title || "" });
      } else if (
        blk.type === "link_to_page" &&
        blk.link_to_page?.type === "page_id"
      ) {
        pages.push({ id: blk.link_to_page.page_id, title: "" });
      }
    }
    hasMore = !!resp.has_more;
    start_cursor = resp.next_cursor;
  }
  return pages;
}

async function findChildPageByTitle(parentPageId, wantedTitle) {
  const children = await listChildPagesOnce(parentPageId);
  const norm = (s) => (s || "").trim().toLowerCase();
  const hit = children.find((p) => norm(p.title) === norm(wantedTitle));
  if (hit && hit.id) return hit.id;
  // fallback: fetch page titles via pages.retrieve for link_to_page entries without title
  for (const c of children) {
    if (!c.title && c.id) {
      try {
        const pg = await notion.request({
          method: "GET",
          path: `pages/${c.id}`,
        });
        const t =
          pg.properties?.title?.title?.[0]?.plain_text ||
          pg.properties?.Name?.title?.[0]?.plain_text ||
          "";
        if (norm(t) === norm(wantedTitle)) return c.id;
      } catch (_) {}
    }
  }
  return null;
}

async function resolveSourcePageIdByTitle(
  rootPageId,
  categoryName,
  wantedTitle
) {
  if (!rootPageId) return null;
  // 1) if category provided, find category page then child with title
  if (categoryName) {
    const catId = await findChildPageByTitle(rootPageId, categoryName);
    if (catId) {
      const pageId = await findChildPageByTitle(catId, wantedTitle);
      if (pageId) return pageId;
    }
  }
  // 2) search one level under root
  const pageId = await findChildPageByTitle(rootPageId, wantedTitle);
  if (pageId) return pageId;
  return null;
}

async function rewriteWithOpenAI(sourceMarkdown, meta) {
  if (!openai) return null;
  try {
    const resp = await openai.chat.completions.create({
      model: openaiModel,
      messages: [
        {
          role: "system",
          content: `당신은 백엔드 엔지니어이자 시니어 테크 라이터 ‘handsupmin’입니다. 아래 요구사항을 엄격히 준수해 입력된 원문을 블로그 게시용으로 리라이트하고, 오직 JSON만 출력하세요.

[목표]
- 원문을 한국어로 자연스럽고 사람 말투에 가깝게 리라이트
- 제목은 명확/검색 친화적으로, 본문은 실용적/맥락 중심으로
- 결과는 BlogPost(JSON) 하나의 객체로만 출력

[스타일 가이드]
- 톤: 과장/수사 금지, 실무자 설명체. 군더더기 축약
- 문장부호: 줄글(문단) 설명 문장은 마침표 사용. 리스트/개념 정리는 ‘~입니다/~합니다’ 지양, 명사형 종료 또는 음슴체(마침표 금지)
- 구조: 필요할 때만 서문(개요)·결론 사용(불필요하면 생략)
- 길이: 원문 대비 80~120% 분량 유지(지나치게 짧은 요약 금지)
- 코드/표/수식은 손상 없이 유지(내용에 중요할 때만)
- 이미지: 본문에서 모두 제거(마크다운 ![]()/HTML <img> 포함 금지)

[콘텐츠 구성 규칙]
- 제목(title): 내용/카테고리 맥락이 드러나게 구체적으로. 너무 일반적이면 카테고리+주제를 반영(예: ‘NFT의 개념’, ‘NestJS 의존성 주입 가이드’)
      - 본문(content): 최소 수백 자 이상, 여러 문단으로 구성
      - 마크다운 섹션 권장: 본문 섹션들(‘### 개념/배경’, ‘### 사용법/예시’, ‘### 마무리’(선택)). 섹션 제목은 한국어로 간결하게
- 참고자료(references): 유효 URL만 배열로(가능할 때)
- 태그(tags)/카테고리(category): meta가 있으면 존중, 아니면 본문 주제에서 합리적 추론
- 초안(draft): false(게시 목적)
- 슬러그(slug): ASCII 소문자-케밥케이스. 제목 기반 생성, 특수문자 제거

[출력 포맷 – JSON 객체 하나만]
{
  "title": string(>=3),
  "slug": string(kebab-case),
  "tags": string[],
  "category": string,
  "content": string(여러 문단),
  "draft": false,
  "canonicalUrl": string(uri) | null,
  "references": string[] (uri) | []
}

[엄수 사항]
- 오직 JSON만 출력(설명/마크다운 금지)
- 이미지 삽입 금지(본문에서 전부 제거)
- 본문이 비거나 요약만 있는 결과 금지
- meta의 tags/category가 있으면 우선 반영하되, 부적합하면 보정 가능(맥락 우선)

[입력]
- meta: { "title"?: string, "tags"?: string[], "category"?: string, "canonicalUrl"?: string|null }
- sourceMarkdown: string(원문 전체. 이미지 포함 시 제거)`,
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              meta,
              sourceMarkdown,
              lengthHint: {
                originChars: (sourceMarkdown || "").length,
                targetMin: Math.floor((sourceMarkdown || "").length * 0.8),
                targetMax: Math.ceil((sourceMarkdown || "").length * 1.2),
              },
            },
            null,
            2
          ),
        },
      ],
      temperature: 1,
      response_format: { type: "json_object" },
    });
    const text = resp.choices?.[0]?.message?.content || "";
    return JSON.parse(text);
  } catch (e) {
    console.error("LLM rewrite failed:", e?.message || e);
    return null;
  }
}

async function rewriteWithRetries(sourceMarkdown, meta, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const candidate = await rewriteWithOpenAI(sourceMarkdown, meta);
    if (
      candidate &&
      typeof candidate.content === "string" &&
      candidate.content.trim().length > 0
    ) {
      if (!candidate.slug && candidate.title) {
        candidate.slug = slugify(candidate.title, {
          lower: true,
          strict: true,
        });
      }
      return candidate;
    }
    console.error(`LLM rewrite invalid output. retry ${attempt}/${maxRetries}`);
  }
  return null;
}

function slugifyWithSuffix(baseText, pageId) {
  const cleanBase = slugify(baseText || "post", { lower: true, strict: true });
  const idPart = (pageId || "").replace(/-/g, "").slice(0, 6);
  const randPart = Math.random().toString(36).slice(2, 8);
  const suffix = idPart || randPart;
  return `${cleanBase}-${suffix}`;
}

function ensureUniqueContentSlug(preferredSlug) {
  let candidate = preferredSlug;
  let attempt = 0;
  while (fs.existsSync(path.join("content", "posts", candidate))) {
    const extra = Math.random().toString(36).slice(2, 6);
    candidate = `${preferredSlug}-${extra}`;
    attempt += 1;
    if (attempt > 20) break; // 안전장치
  }
  return candidate;
}

async function main() {
  const page = await queryOneRandomWithPriority();
  if (!page) {
    console.log("No items to publish.");
    return;
  }
  const title = getTitle(page);
  const kst = dayjs().tz("Asia/Seoul").toDate().toISOString();
  const meta = extractMeta(page);
  const preferredSourceId =
    meta.sourcePageId && /[0-9a-fA-F-]{32,36}/.test(meta.sourcePageId)
      ? meta.sourcePageId
      : null;
  let sourceMarkdown = "";
  try {
    if (preferredSourceId) {
      sourceMarkdown = (await pageToMarkdown(preferredSourceId)) || "";
    }
    if (!sourceMarkdown) {
      const rootPageId = process.env.NOTION_ROOT_PAGE_ID || null;
      if (rootPageId) {
        const resolved = await resolveSourcePageIdByTitle(
          rootPageId,
          meta.category,
          meta.title
        );
        if (resolved) sourceMarkdown = (await pageToMarkdown(resolved)) || "";
      }
    }
  } catch (e) {
    console.error("Failed to fetch page markdown:", e?.message || e);
  }
  if (!sourceMarkdown) {
    console.error(
      "No source content resolved from Notion (postId/title). Aborting."
    );
    process.exit(1);
  }
  const llmEnabled = llmProvider === "openai" && !!openai;
  // Single-step rewrite (JSON) with retries
  let blogPost = null;
  if (llmEnabled) {
    blogPost = await rewriteWithRetries(sourceMarkdown, meta, 3);
    if (!blogPost) {
      console.error(
        "LLM rewrite failed after 3 attempts. Aborting to avoid empty post."
      );
      process.exit(1);
    }
  }
  let outTitle = blogPost?.title || title;
  // 요약/핵심 요약 사용 안 함
  let outTags = Array.isArray(blogPost?.tags) ? blogPost.tags : meta.tags || [];
  let outCategory = blogPost?.category || meta.category || "";
  let outCanonical = blogPost?.canonicalUrl || meta.canonicalUrl || null;
  let outDraft = blogPost?.draft === true ? true : false;
  let outContent =
    blogPost &&
    typeof blogPost.content === "string" &&
    blogPost.content.trim().length > 0
      ? blogPost.content
      : sourceMarkdown;
  let outRefs = Array.isArray(blogPost?.references) ? blogPost.references : [];

  // 충돌 방지: 항상 접미사(-abcdef) 포함하고, 실제 디렉터리 존재 시 랜덤 추가 접미사로 재시도
  const baseForSlug = blogPost?.slug || outTitle || title || "post";
  const preferredSlug = slugifyWithSuffix(baseForSlug, page.id);
  const outSlug = ensureUniqueContentSlug(preferredSlug);

  const fm = {
    title: outTitle,
    date: kst,
    draft: outDraft,
    tags: outTags,
    categories: [outCategory].filter(Boolean),
    slug: outSlug,
    postId: page.id,
  };
  if (outCanonical) fm.canonicalURL = outCanonical;

  let body = "";
  body += outContent || "";
  // 핵심 요약 섹션 추가하지 않음
  if (outRefs.length) {
    body += "\n\n### 참고자료\n" + outRefs.map((r) => `- ${r}`).join("\n");
  }

  const md = matter.stringify(body, fm);
  const dir = path.join("content", "posts", outSlug);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, "index.md");
  fs.writeFileSync(outPath, md);
  console.log("Wrote:", outPath);

  // 매핑 파일 업데이트: notion-blog-index.json
  const mapPath = path.join("data", "notion-blog-index.json");
  const prev = fs.existsSync(mapPath)
    ? JSON.parse(fs.readFileSync(mapPath, "utf-8"))
    : {};
  prev[page.id] = { slug: outSlug, path: `content/posts/${outSlug}/index.md` };
  fs.mkdirSync(path.dirname(mapPath), { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(prev, null, 2));
  console.log("Updated index:", mapPath);
}

main();
