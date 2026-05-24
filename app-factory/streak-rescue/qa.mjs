#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.STREAK_RESCUE_MARKETING_QA_PORT ?? "8146");
const baseUrl = `http://127.0.0.1:${port}`;
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const widths = [320, 375, 414, 768];
const pages = [
  { path: "/index.html", markers: ["Streak Rescue", "Missed yesterday?", "Optional diagnostic analytics", "No account, no server, no runtime AI wrapper"] },
  { path: "/privacy.html", markers: ["Local habit recovery", "Firebase Analytics", "no runtime AI"] },
  { path: "/support.html", markers: ["Help for the day after", "Support diagnostics", "Back to Streak Rescue"] }
];

async function main() {
  const server = await serveSite();
  const chrome = await launchChrome();
  try {
    const tab = await connectToChrome(chrome.port);
    const results = [];
    for (const width of widths) {
      for (const page of pages) {
        await tab.setViewport(width, 900);
        await tab.navigate(`${baseUrl}${page.path}`);
        const result = await tab.evaluate((markers) => {
          const text = document.body.innerText || "";
          const documentElement = document.documentElement;
          const links = Array.from(document.querySelectorAll("a"));
          const linkOverflow = links.some((link) => {
            const rect = link.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(link);
            const lineCount = new Set(Array.from(range.getClientRects()).map((item) => Math.round(item.top))).size;
            range.detach();
            return rect.right > window.innerWidth + 1 || lineCount > 1;
          });
          const hasAllMarkers = markers.every((marker) => text.toLowerCase().includes(marker.toLowerCase()));
          return {
            clientWidth: documentElement.clientWidth,
            hasAllMarkers,
            horizontalScroll: documentElement.scrollWidth > window.innerWidth + 1,
            linkOverflow,
            scrollWidth: documentElement.scrollWidth
          };
        }, page.markers);
        results.push({
          ...result,
          pass: result.hasAllMarkers && !result.horizontalScroll && !result.linkOverflow,
          url: page.path,
          width
        });
      }
    }

    await tab.setViewport(375, 900);
    await tab.navigate(`${baseUrl}/index.html`);
    await tab.captureJpeg(path.join(siteDir, "qa-index-375.jpg"), { height: 900, width: 375 });

    await writeFile(path.join(siteDir, "qa-responsive-results.json"), `${JSON.stringify(results, null, 2)}\n`);
    await writeFile(path.join(siteDir, "qa-report.md"), qaReport(results));
    const failed = results.filter((result) => !result.pass);
    if (failed.length > 0) {
      throw new Error(`Marketing QA failed: ${failed.map((result) => `${result.url}@${result.width}`).join(", ")}`);
    }
    console.log("OK Streak Rescue marketing site QA");
  } finally {
    chrome.process.kill("SIGTERM");
    await waitForExit(chrome.process, 3000);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function serveSite() {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", baseUrl);
      const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      const filePath = path.join(siteDir, decodeURIComponent(pathname));
      if (!filePath.startsWith(siteDir)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function launchChrome() {
  for (let offset = 0; offset < 10; offset += 1) {
    const debugPort = 9700 + offset;
    const child = spawn(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(process.env.TMPDIR ?? "/tmp", `streak-marketing-${debugPort}-${Date.now()}`)}`,
      "about:blank"
    ], { stdio: "ignore" });
    try {
      await waitForChrome(debugPort);
      return { process: child, port: debugPort };
    } catch {
      child.kill("SIGTERM");
      await waitForExit(child, 1000);
    }
  }
  throw new Error("Could not launch Chrome with a debugging port.");
}

async function waitForChrome(debugPort) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const tabs = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
      if (tabs.length > 0) return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Chrome did not open debugging port ${debugPort}.`);
}

async function connectToChrome(debugPort) {
  const tabs = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = tabs.find((tab) => tab.type === "page") ?? tabs[0];
  return new CdpPage(page.webSocketDebuggerUrl);
}

class CdpPage {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (message) => {
      const payload = JSON.parse(message.data);
      if (payload.id) {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        this.pending.delete(payload.id);
        if (payload.error) pending.reject(new Error(payload.error.message));
        else pending.resolve(payload.result ?? {});
        return;
      }
      const listeners = this.events.get(payload.method) ?? [];
      for (const listener of listeners) listener(payload.params ?? {});
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return await result;
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await this.send("Page.enable");
  }

  async navigate(targetUrl) {
    const loaded = this.waitFor("Page.loadEventFired", 10000);
    await this.send("Page.navigate", { url: targetUrl });
    await loaded;
    await sleep(150);
  }

  async evaluate(fn, arg) {
    const result = await this.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
      awaitPromise: true,
      returnByValue: true
    });
    return result.result?.value;
  }

  async captureJpeg(filePath, { height, width }) {
    const result = await this.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      clip: { height, scale: 1, width, x: 0, y: 0 },
      format: "jpeg",
      fromSurface: true,
      quality: 92
    });
    await writeFile(filePath, Buffer.from(result.data, "base64"));
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
      const listener = (params) => {
        clearTimeout(timeout);
        const listeners = (this.events.get(method) ?? []).filter((item) => item !== listener);
        this.events.set(method, listeners);
        resolve(params);
      };
      this.events.set(method, [...(this.events.get(method) ?? []), listener]);
    });
  }
}

function qaReport(results) {
  const rows = results
    .map((result) => `| ${result.url} | ${result.width} | ${result.horizontalScroll ? "yes" : "no"} | ${result.linkOverflow ? "yes" : "no"} | ${result.hasAllMarkers ? "yes" : "no"} | ${result.pass ? "pass" : "fail"} |`)
    .join("\n");
  return `# Static Site QA: Streak Rescue

## Scope

- Overview: \`index.html\`
- Privacy policy: \`privacy.html\`
- Support: \`support.html\`
- Local preview: \`${baseUrl}\`

## Result

| URL | Width | Horizontal Scroll | Link Overflow | Copy Markers | Result |
| --- | ---: | --- | --- | --- | --- |
${rows}

## Evidence

- \`qa-responsive-results.json\`
- \`qa-index-375.jpg\`
`;
}

async function fetchJson(targetUrl) {
  const response = await fetch(targetUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${targetUrl}`);
  return await response.json();
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

await main();
