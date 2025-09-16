#!/usr/bin/env node
import { Client } from "@notionhq/client";
import fs from "fs";
import path from "path";

const notionToken = process.env.NOTION_TOKEN;
const dataSourceIdEnv = process.env.NOTION_DATA_SOURCE_ID;
const notionVersion = process.env.NOTION_VERSION || "2025-09-03";

if (!notionToken || !dataSourceIdEnv) {
  console.error("Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID");
  process.exit(1);
}

const notion = new Client({ auth: notionToken, notionVersion });

const dataSourceId = dataSourceIdEnv;

async function resolvePublishedKey() {
  try {
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
    for (const name of candidates)
      if (props[name]?.type === "checkbox") return name;
    for (const [k, v] of Object.entries(props))
      if (v?.type === "checkbox") return k;
  } catch (_) {}
  return null;
}

async function resolvePostUrlKey() {
  try {
    const ds = await notion.request({
      method: "GET",
      path: `data_sources/${dataSourceId}`,
    });
    const props = ds?.properties || {};
    const candidates = ["postUrl", "post_url", "url", "게시URL", "게시주소"];
    for (const name of candidates) if (props[name]?.type === "url") return name;
    for (const [k, v] of Object.entries(props)) if (v?.type === "url") return k;
  } catch (_) {}
  return null;
}

async function updatePageFlags(pageId, postUrl, publishedKey, postUrlKey) {
  const properties = {};
  if (publishedKey) properties[publishedKey] = { checkbox: true };
  if (postUrlKey && postUrl) properties[postUrlKey] = { url: postUrl };
  if (Object.keys(properties).length === 0) return;
  await notion.pages.update({ page_id: pageId, properties });
}

async function main() {
  // notion-blog-index.json을 읽어 해당 페이지들의 상태 업데이트
  const mapPath = path.join("data", "notion-blog-index.json");
  if (!fs.existsSync(mapPath)) {
    console.log("No mapping file; nothing to sync.");
    return;
  }
  const mapping = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
  const baseUrl = process.env.BLOG_BASE_URL || "https://handsupmin.github.io";
  const publishedKey = await resolvePublishedKey();
  const postUrlKey = await resolvePostUrlKey();
  for (const [pageId, info] of Object.entries(mapping)) {
    const postUrl = `${baseUrl}/posts/${info.slug}/`;
    try {
      // pageId는 Notion 원본 페이지 ID
      await updatePageFlags(pageId, postUrl, publishedKey, postUrlKey);
      console.log("Synced:", pageId, "→", postUrl);
    } catch (e) {
      console.error("Failed to sync", pageId, e?.message || e);
    }
  }
}

main();
