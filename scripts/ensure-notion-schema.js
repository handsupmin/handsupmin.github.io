#!/usr/bin/env node
import { Client } from "@notionhq/client";

const notionToken = process.env.NOTION_TOKEN;
const dataSourceIdEnv = process.env.NOTION_DATA_SOURCE_ID;
const notionVersion = process.env.NOTION_VERSION || "2025-09-03";

if (!notionToken || !dataSourceIdEnv) {
  console.error("Missing NOTION_TOKEN or NOTION_DATA_SOURCE_ID");
  process.exit(1);
}

const notion = new Client({ auth: notionToken, notionVersion });

const dataSourceId = dataSourceIdEnv;

async function main() {
  try {
    const id = dataSourceId;
    const ds = await notion.request({
      method: "GET",
      path: `data_sources/${id}`,
    });
    const hasFlag =
      ds.properties && ds.properties["isUploaded"]?.type === "checkbox";
    console.log("Data source:", ds?.name || id);
    console.log("checkbox exists:", hasFlag);
  } catch (e) {
    console.error("Failed to access Notion Data Source:", e?.message || e);
    process.exit(1);
  }
}

main();
