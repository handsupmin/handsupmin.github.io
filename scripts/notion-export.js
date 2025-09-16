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

const blogPostSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "BlogPost",
  type: "object",
  required: ["title", "slug", "summary", "content"],
  properties: {
    title: { type: "string", minLength: 3 },
    slug: { type: "string", pattern: "^[a-z0-9-]+$" },
    summary: { type: "string", minLength: 20 },
    tags: { type: "array", items: { type: "string" }, default: [] },
    category: { type: "string" },
    coverImage: { type: "string", format: "uri", nullable: true },
    draft: { type: "boolean", default: false },
    canonicalUrl: { type: "string", format: "uri", nullable: true },
    content: { type: "string" },
    tldr: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      default: [],
    },
    references: {
      type: "array",
      items: { type: "string", format: "uri" },
      default: [],
    },
  },
};

async function rewriteWithOpenAI(sourceMarkdown, meta) {
  if (!openai) return null;
  try {
    const resp = await openai.chat.completions.create({
      model: openaiModel,
      messages: [
        {
          role: "system",
          content: [
            "당신은 백엔드 엔지니어이자 시니어 테크 라이터 'handsupmin' 입니다",
            "요구사항:",
            "- 한국어로 자연스럽고 사람 말투에 가깝게 작성",
            "- 필요할 때만 서문(개요)과 결론을 두고, 불필요하면 생략",
            "- 줄글(문단)로 설명이 필요한 문장은 문장 끝에 마침표 사용",
            "- 개념 간단 설명/한줄 요약/리스트는 '~입니다/~합니다' 지양, 명사형 종료 또는 음슴체 사용",
            "- 틀린 내용이나 보충이 필요한 내용이 있으면 수정해서 rewrite",
            "- 과한 수사, AI 티 나는 표현 금지",
            "- 위 요구사항을 엄격히 준수하여 출력",
            "- 아래 meta와 sourceMarkdown을 바탕으로 BlogPost(JSON)만 출력",
            "출력: BlogPost(JSON) — title, slug, summary, tags[], category, content, draft(false), canonicalUrl?, tldr[3+], references[]",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ meta, sourceMarkdown }, null, 2),
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

async function main() {
  const page = await queryOneRandom();
  if (!page) {
    console.log("No items to publish.");
    return;
  }
  const title = getTitle(page);
  const slug = slugify(title, { lower: true, strict: true });
  const dir = path.join("content", "posts", slug);
  fs.mkdirSync(dir, { recursive: true });
  const kst = dayjs().tz("Asia/Seoul").toDate().toISOString();
  const sourceMarkdown = (await pageToMarkdown(page.id)) || "";
  const meta = extractMeta(page);
  let blogPost = null;
  const llmEnabled = llmProvider === "openai" && !!openai;
  if (llmEnabled) {
    blogPost = await rewriteWithOpenAI(sourceMarkdown, meta);
    if (
      !blogPost ||
      typeof blogPost.content !== "string" ||
      blogPost.content.trim().length === 0
    ) {
      console.error(
        "LLM rewrite failed or returned empty content. Aborting to avoid empty post."
      );
      process.exit(1);
    }
  }
  let outTitle = blogPost?.title || title;
  let outSlug =
    blogPost?.slug || slugify(outTitle, { lower: true, strict: true });
  let outSummary = blogPost?.summary || meta.summary || "";
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
  let outTldr = Array.isArray(blogPost?.tldr) ? blogPost.tldr : [];
  let outRefs = Array.isArray(blogPost?.references) ? blogPost.references : [];

  const fm = {
    title: outTitle,
    date: kst,
    draft: outDraft,
    description: outSummary,
    tags: outTags,
    categories: [outCategory].filter(Boolean),
    slug: outSlug,
    postId: page.id,
  };
  if (outCanonical) fm.canonicalURL = outCanonical;

  let body = "";
  if (outTldr.length) {
    body += "> TL;DR\n" + outTldr.map((t) => `- ${t}`).join("\n") + "\n\n";
  }
  body += outContent || "";
  if (outRefs.length) {
    body += "\n\n## 참고자료\n" + outRefs.map((r) => `- ${r}`).join("\n");
  }

  const md = matter.stringify(body, fm);
  fs.writeFileSync(path.join(dir, "index.md"), md);
  console.log("Wrote:", path.join(dir, "index.md"));

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
