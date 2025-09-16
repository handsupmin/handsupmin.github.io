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

async function updatePageFlags(pageId, postUrl) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      isUploaded: { checkbox: true },
      postUrl: postUrl ? { url: postUrl } : undefined,
    },
  });
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
  for (const [pageId, info] of Object.entries(mapping)) {
    const postUrl = `${baseUrl}/posts/${info.slug}/`;
    try {
      await updatePageFlags(pageId, postUrl);
      console.log("Synced:", pageId, "→", postUrl);
    } catch (e) {
      console.error("Failed to sync", pageId, e?.message || e);
    }
  }
}

main();
