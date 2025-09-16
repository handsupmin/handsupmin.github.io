#!/usr/bin/env node
import { Client } from "@notionhq/client";

const notionToken = process.env.NOTION_TOKEN;
const dataSourceId = process.env.NOTION_DATA_SOURCE_ID;
const rootPageId = process.env.NOTION_ROOT_PAGE_ID;
const notionVersion = process.env.NOTION_VERSION || "2025-09-03";

if (!notionToken || !dataSourceId) {
  console.error("Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID");
  process.exit(1);
}
if (!rootPageId) {
  console.log("NOTION_ROOT_PAGE_ID not provided. Skip harvest.");
  process.exit(0);
}

const notion = new Client({ auth: notionToken, notionVersion });

let schema = null;
let titleKey = null;
let uploadedKey = "isUploaded";
let postIdKey = "postId";
let categoryKey = "category";

async function loadSchema() {
  const ds = await notion.request({
    method: "GET",
    path: `data_sources/${dataSourceId}`,
  });
  schema = ds?.properties || {};
  // title
  for (const [k, v] of Object.entries(schema)) {
    if (v?.type === "title") {
      titleKey = k;
      break;
    }
  }
  if (!titleKey) {
    throw new Error(
      "No title property found in data source schema. Please ensure the DB has a Title column."
    );
  }
  // isUploaded (checkbox) — if renamed, try to find first checkbox
  if (!schema[uploadedKey]?.type || schema[uploadedKey]?.type !== "checkbox") {
    for (const [k, v] of Object.entries(schema)) {
      if (v?.type === "checkbox") {
        uploadedKey = k;
        break;
      }
    }
  }
  // postId (prefer rich_text)
  if (!schema[postIdKey]?.type || schema[postIdKey]?.type !== "rich_text") {
    let found = null;
    for (const [k, v] of Object.entries(schema)) {
      if (k.toLowerCase() === "postid" && v?.type === "rich_text") found = k;
    }
    if (found) postIdKey = found;
    else if (schema[postIdKey]?.type === "title") postIdKey = titleKey; // avoid mismatch
  }
  // category (prefer select or multi_select)
  if (
    !schema[categoryKey] ||
    (schema[categoryKey]?.type !== "select" &&
      schema[categoryKey]?.type !== "multi_select")
  ) {
    for (const [k, v] of Object.entries(schema)) {
      if (
        k.toLowerCase() === "category" &&
        (v?.type === "select" || v?.type === "multi_select")
      ) {
        categoryKey = k;
        break;
      }
    }
  }
}

async function listChildPages(parentPageId) {
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

async function queryDbByPostId(pageId) {
  try {
    if (!schema[postIdKey] || schema[postIdKey]?.type !== "rich_text")
      return null;
    const res = await notion.request({
      method: "POST",
      path: `data_sources/${dataSourceId}/query`,
      body: {
        filter: {
          property: postIdKey,
          rich_text: { contains: pageId },
        },
        page_size: 1,
      },
    });
    return res?.results?.[0] || null;
  } catch (e) {
    return null;
  }
}

async function queryDbByTitle(title) {
  try {
    const res = await notion.request({
      method: "POST",
      path: `data_sources/${dataSourceId}/query`,
      body: {
        filter: {
          property: titleKey,
          title: { equals: title },
        },
        page_size: 1,
      },
    });
    return res?.results?.[0] || null;
  } catch (e) {
    return null;
  }
}

async function getPageTitle(pageId) {
  try {
    const pg = await notion.request({ method: "GET", path: `pages/${pageId}` });
    const t =
      pg.properties?.title?.title?.[0]?.plain_text ||
      pg.properties?.Name?.title?.[0]?.plain_text ||
      "untitled";
    return t;
  } catch (e) {
    return "untitled";
  }
}

async function ensureInDataSource(pageId, title, categoryName) {
  const exists =
    (await queryDbByPostId(pageId)) || (await queryDbByTitle(title));
  if (exists) {
    console.log("Skip existing:", title);
    return false;
  }
  const props = {};
  // Title
  if (!schema[titleKey] || schema[titleKey]?.type !== "title") {
    throw new Error(
      `Schema mismatch: detected titleKey='${titleKey}' is not type 'title'.`
    );
  }
  props[titleKey] = { title: [{ type: "text", text: { content: title } }] };
  // Checkbox
  if (schema[uploadedKey]?.type === "checkbox")
    props[uploadedKey] = { checkbox: false };
  // postId rich_text (only if rich_text)
  if (schema[postIdKey]?.type === "rich_text") {
    props[postIdKey] = {
      rich_text: [{ type: "text", text: { content: pageId } }],
    };
  }
  // category select/multi_select
  if (schema[categoryKey]?.type === "select" && categoryName) {
    props[categoryKey] = { select: { name: categoryName } };
  } else if (schema[categoryKey]?.type === "multi_select" && categoryName) {
    props[categoryKey] = { multi_select: [{ name: categoryName }] };
  }

  await notion.request({
    method: "POST",
    path: "pages",
    body: {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: props,
    },
  });
  console.log("Created:", title);
  return true;
}

async function main() {
  console.log("Harvest from root:", rootPageId);
  await loadSchema();
  const categories = await listChildPages(rootPageId);
  let created = 0;
  for (const cat of categories) {
    const catTitle = cat.title || (await getPageTitle(cat.id));
    const pages = await listChildPages(cat.id);
    for (const p of pages) {
      const title = p.title || (await getPageTitle(p.id));
      const ok = await ensureInDataSource(p.id, title, catTitle);
      if (ok) created += 1;
    }
  }
  console.log("Harvest done. Created:", created);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
