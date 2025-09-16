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
const openaiModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
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
    ["summary", "요약"],
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
  return { title, tags, category, summary, canonicalUrl };
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
- 제목과 요약은 명확/검색 친화적으로, 본문은 실용적/맥락 중심으로
- 결과는 BlogPost(JSON) 하나의 객체로만 출력

[스타일 가이드]
- 톤: 과장/수사 금지, 실무자 설명체. 핵심 먼저, 군더더기 축약
- 문장부호: 줄글(문단) 설명 문장은 마침표 사용. 한줄/개념 요약·리스트는 ‘~입니다/~합니다’ 지양, 명사형 종료 또는 음슴체
- 구조: 필요할 때만 서문(개요)·결론 사용(불필요하면 생략)
- 길이: 원문 대비 80~120% 분량 유지(지나치게 짧은 요약 금지)
- 코드/표/수식은 손상 없이 유지(내용에 중요할 때만)
- 이미지: 본문에서 모두 제거(마크다운 ![]()/HTML <img> 포함 금지)

[콘텐츠 구성 규칙]
- 제목(title): 내용/카테고리 맥락이 드러나게 구체적으로. 너무 일반적이면 카테고리+주제를 반영(예: ‘NFT의 개념’, ‘NestJS 의존성 주입 가이드’)
- 요약(summary): 140~200자. 본문 핵심 포인트를 압축
- TL;DR(tldr): 3~6개 핵심 bullet. 줄바꿈/빈 줄 처리로 본문과 명확히 분리
- 본문(content): 최소 수백 자 이상, 여러 문단. TL;DR을 반복해 복붙하지 말 것
- 참고자료(references): 유효 URL만 배열로(가능할 때)
- 태그(tags)/카테고리(category): meta가 있으면 존중, 아니면 본문 주제에서 합리적 추론
- 초안(draft): false(게시 목적)
- 슬러그(slug): ASCII 소문자-케밥케이스. 제목 기반 생성, 특수문자 제거

[출력 포맷 – JSON 객체 하나만]
{
  "title": string(>=3),
  "slug": string(kebab-case),
  "summary": string(140~200자),
  "tags": string[],
  "category": string,
  "content": string(여러 문단, TL;DR와 명확히 분리),
  "draft": false,
  "canonicalUrl": string(uri) | null,
  "tldr": string[] (3~6개),
  "references": string[] (uri) | []
}

[엄수 사항]
- 오직 JSON만 출력(설명/마크다운 금지)
- 이미지 삽입 금지(본문에서 전부 제거)
- TL;DR 블록 종료 후 빈 줄 1개 이상 → 본문 시작(붙지 않게)
- 본문이 비거나 TL;DR만 있는 결과 금지
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
      temperature: 0.3,
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

// Generate body only (no title, no TL;DR), remove images, keep length similar to original
async function generateBodyMarkdown(sourceMarkdown, meta, lengthHint) {
  if (!openai) return sourceMarkdown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await openai.chat.completions.create({
      model: openaiModel,
      messages: [
        {
          role: "system",
          content: [
            "오직 본문 Markdown만 출력",
            "이미지/그림 제거(마크다운/HTML 금지)",
            "TL;DR/요약/제목/메타데이터 출력 금지",
            "원문 대비 80~120% 분량 유지",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify(
            { meta, sourceMarkdown, lengthHint },
            null,
            2
          ),
        },
      ],
      temperature: 0.4,
    });
    const text = (resp.choices?.[0]?.message?.content || "").trim();
    const onlyText = text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<img[^>]*>/gi, "");
    if (onlyText && !/^\s*>\s*TL;DR/i.test(onlyText) && onlyText.length > 200) {
      return onlyText;
    }
  }
  return sourceMarkdown;
}

// Summarize body into 3-6 bullets
async function generateSummaryBullets(bodyMarkdown) {
  if (!openai) {
    const sentences = (bodyMarkdown || "")
      .replace(/\n+/g, " ")
      .split(/(?<=\.)\s+/)
      .slice(0, 5)
      .map((s) => s.trim())
      .filter(Boolean);
    return sentences.slice(0, 6).map((s) => s.replace(/\.$/, ""));
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const resp = await openai.chat.completions.create({
      model: openaiModel,
      messages: [
        {
          role: "system",
          content:
            "입력 본문을 3~6개 핵심 bullet로 요약. 오직 줄바꿈된 '- ' 리스트만 출력.",
        },
        { role: "user", content: bodyMarkdown.slice(0, 12000) },
      ],
      temperature: 0.3,
    });
    const text = (resp.choices?.[0]?.message?.content || "").trim();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^\-\s+/, ""));
    if (lines.length >= 3) return lines.slice(0, 6);
  }
  return [];
}

// Generate a concise, SEO-friendly title from body
async function generateTitleFromBody(bodyMarkdown, metaCategory) {
  if (!openai) return null;
  const hint = metaCategory ? `카테고리: ${metaCategory}` : "";
  const resp = await openai.chat.completions.create({
    model: openaiModel,
    messages: [
      {
        role: "system",
        content:
          "본문에 가장 어울리는 검색 친화적 한국어 제목 1개만 출력. 10~40자. 따옴표/마크다운 금지.",
      },
      { role: "user", content: `${hint}\n\n${bodyMarkdown.slice(0, 8000)}` },
    ],
    temperature: 0.4,
  });
  const t = (resp.choices?.[0]?.message?.content || "").trim();
  return t.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
}

async function main() {
  const page = await queryOneRandomWithPriority();
  if (!page) {
    console.log("No items to publish.");
    return;
  }
  const title = getTitle(page);
  const kst = dayjs().tz("Asia/Seoul").toDate().toISOString();
  const sourceMarkdown = (await pageToMarkdown(page.id)) || "";
  const meta = extractMeta(page);
  const llmEnabled = llmProvider === "openai" && !!openai;
  const lengthHint = {
    originChars: (sourceMarkdown || "").length,
    targetMin: Math.floor((sourceMarkdown || "").length * 0.8),
    targetMax: Math.ceil((sourceMarkdown || "").length * 1.2),
  };
  let outContent = sourceMarkdown;
  let outTldr = [];
  let outTitle = title;
  let outSummary = meta.summary || "";
  let outTags = meta.tags || [];
  let outCategory = meta.category || "";
  let outCanonical = meta.canonicalUrl || null;
  let outDraft = false;
  let outRefs = [];

  if (llmEnabled) {
    const body = await generateBodyMarkdown(sourceMarkdown, meta, lengthHint);
    outContent = body;
    outTldr = await generateSummaryBullets(body);
    const gTitle = await generateTitleFromBody(body, outCategory);
    if (gTitle) outTitle = gTitle;
  }

  let outSlug = slugify(outTitle || title || "", { lower: true, strict: true });
  if (!outSlug || outSlug === "index") {
    const pid =
      (page.id || "").replace(/-/g, "").slice(0, 8) || String(Date.now());
    outSlug = `post-${pid}`;
  }

  // 제목이 너무 일반적이면 카테고리 맥락을 포함해 보정
  const genericTitle = /^(개념|정의|소개|요약|기초|베이직|가이드)$/i;
  if (genericTitle.test(outTitle) && outCategory) {
    outTitle = `${outCategory}의 ${outTitle}`;
  }

  // 요약 보정: 비어있거나 너무 짧으면 본문에서 140~200자 추출
  if (!outSummary || outSummary.trim().length < 20) {
    const plain = (outContent || sourceMarkdown)
      .replace(/`{3}[\s\S]*?`{3}/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/<img[^>]*>/gi, " ")
      .replace(/[>#*_`\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    outSummary = plain.slice(0, 200);
  }

  // 이미지 제거 및 콘텐츠 폴백
  const stripImages = (text) =>
    (text || "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<img[^>]*>/gi, "");
  let cleanedContent = stripImages(outContent).trim();
  if (!cleanedContent) cleanedContent = stripImages(sourceMarkdown).trim();
  if (!cleanedContent) cleanedContent = outSummary || "";
  outContent = cleanedContent;

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
  if (outTldr.length) {
    body += "\n\n## 간단 요약\n" + outTldr.map((t) => `- ${t}`).join("\n");
  }
  if (outRefs.length) {
    body += "\n\n## 참고자료\n" + outRefs.map((r) => `- ${r}`).join("\n");
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
