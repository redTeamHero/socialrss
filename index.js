// index.js
// A tiny multi-source feed aggregator with RSS/Atom/JSON outputs.
// Run: node index.js  (then visit: /rss.xml, /atom.xml, /feed.json)

import express from "express";
import RSSParser from "rss-parser";
import { Feed } from "feed";
import cron from "node-cron";
import { fetch } from "undici";

const app = express();
const parser = new RSSParser({
  // Some feeds hide media in custom fields; include them if present:
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:group", "mediaGroup", { keepArray: true }],
      ["enclosure", "enclosure"], // standard RSS enclosure
      ["content:encoded", "contentEncoded"],
    ],
  },
});

// ==== 1) Configure your source list here ====
// Add as many as you want. Can be RSS/Atom/JSON (if JSON Feed, we’ll adapt).
const SOURCES = [
  // Good examples:
  "https://hnrss.org/frontpage",                                      // RSS
  "https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9TQ", // YouTube channel RSS
  "https://blog.mozilla.org/feed/",                                   // WordPress RSS
  // JSON Feed example:
  "https://daringfireball.net/feeds/json",                            // JSON Feed 1.1
];

// ==== 2) Aggregator state (in-memory cache) ====
let CACHE = {
  items: [],
  lastBuild: new Date(),
};

// Small helper: try to parse as JSON Feed if content-type/shape indicates JSON
async function tryParseJSONFeed(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "MultiFeed/1.0" } });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json") && !ct.includes("text/json")) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) return null;

    // Normalize JSON Feed item shape to rss-parser-like items
    const items = data.items.map((it) => ({
      title: it.title || "(untitled)",
      link: it.url || it.external_url || "",
      isoDate: it.date_published || it.date_modified || new Date().toISOString(),
      content: it.content_html || it.content_text || "",
      contentSnippet: it.summary || "",
      // JSON Feed enclosures:
      enclosure: it.attachments && it.attachments[0]
        ? { url: it.attachments[0].url, type: it.attachments[0].mime_type || "" }
        : undefined,
      // Image helpers:
      image: it.image || it.banner_image || null,
      author: it.author && (it.author.name || it.author.url) ? [{ name: it.author.name, link: it.author.url }] : [],
      _source: url,
    }));
    return { title: data.title || url, items };
  } catch {
    return null;
  }
}

// Extract a best-guess image URL from item fields
function pickImage(item) {
  // 1) enclosure as image
  if (item.enclosure && item.enclosure.url && (item.enclosure.type || "").startsWith("image/")) {
    return item.enclosure.url;
  }
  // 2) media:* tags
  const firstMedia =
    (item.mediaContent && item.mediaContent[0] && item.mediaContent[0]["$"] && item.mediaContent[0]["$"].url) ||
    (item.mediaThumbnail && item.mediaThumbnail[0] && item.mediaThumbnail[0]["$"] && item.mediaThumbnail[0]["$"].url);
  if (firstMedia) return firstMedia;
  // 3) content:encoded or content HTML <img>
  const html = item.contentEncoded || item["content:encoded"] || item.content || "";
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];
  // 4) json feed fields mapped above
  if (item.image) return item.image;
  return null;
}

// Extract a best-guess video enclosure (mp4, webm, or YouTube link)
function pickVideo(item) {
  // Prioritize RSS enclosure with video mime types
  if (item.enclosure && item.enclosure.url && (item.enclosure.type || "").startsWith("video/")) {
    return { url: item.enclosure.url, type: item.enclosure.type };
  }

  // media:group may hide video content
  if (item.mediaGroup && Array.isArray(item.mediaGroup)) {
    // very naive scan
    const htmlish = JSON.stringify(item.mediaGroup);
    const mv = htmlish.match(/(https?:\/\/[^\s"']+\.(mp4|webm))/i);
    if (mv) return { url: mv[1], type: `video/${mv[2]}` };
  }

  // YouTube feed items: give link; most feed readers will render card
  if (item.link && item.link.includes("youtube.com/watch")) {
    return { url: item.link, type: "text/html" };
  }

  // Content HTML with direct video links
  const html = item.contentEncoded || item.content || "";
  const mv = html.match(/(https?:\/\/[^\s"']+\.(mp4|webm))/i);
  if (mv) return { url: mv[1], type: `video/${mv[2]}` };

  return null;
}

// Core: fetch + merge all sources
async function refresh() {
  const collected = [];
  for (const src of SOURCES) {
    // Try JSON Feed first (fast path)
    const jf = await tryParseJSONFeed(src);
    if (jf) {
      jf.items.forEach((it) => (it._source = src));
      collected.push(...jf.items);
      continue;
    }

    // Else parse as RSS/Atom
    try {
      const feed = await parser.parseURL(src);
      for (const it of feed.items) {
        it._source = src;
        collected.push(it);
      }
    } catch (e) {
      console.error("Failed to read", src, e.message);
    }
  }

  // Normalize, dedupe by canonical link, sort by date desc
  const seen = new Set();
  const normalized = collected
    .map((it) => {
      const date = new Date(it.isoDate || it.pubDate || Date.now());
      const link = it.link || it.guid || "";
      return {
        title: it.title || "(untitled)",
        link,
        date,
        description: it.contentEncoded || it.content || it.contentSnippet || "",
        authorName:
          (it.creator || (it.author && it.author[0] && it.author[0].name)) || "",
        imageUrl: pickImage(it),
        video: pickVideo(it), // {url,type} or null
        enclosure: it.enclosure && it.enclosure.url ? it.enclosure : null,
        source: it._source,
      };
    })
    .filter((it) => it.link); // need a link for canonical

  const deduped = [];
  for (const it of normalized) {
    const key = it.link.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(it);
  }

  deduped.sort((a, b) => b.date - a.date);

  CACHE = { items: deduped, lastBuild: new Date() };
  console.log(`Refreshed ${deduped.length} items @ ${CACHE.lastBuild.toISOString()}`);
}

// Build Feed objects on-the-fly from CACHE
function buildFeeds() {
  const siteUrl = "https://example.com"; // update to your domain
  const feed = new Feed({
    id: `${siteUrl}/`,
    title: "Multi-Source Feed",
    description: "Unified feed aggregated from multiple sources",
    link: `${siteUrl}/`,
    language: "en",
    updated: CACHE.lastBuild,
    feedLinks: {
      rss2: `${siteUrl}/rss.xml`,
      atom: `${siteUrl}/atom.xml`,
      json: `${siteUrl}/feed.json`,
    },
    author: { name: "MultiFeed Bot" },
  });

  for (const item of CACHE.items) {
    const contentBlocks = [];

    // Add image preview if present
    if (item.imageUrl) {
      contentBlocks.push(`<p><img src="${item.imageUrl}" alt="" /></p>`);
    }

    // Add video hint (direct mp4/webm or YouTube link)
    if (item.video) {
      if (item.video.type.startsWith("video/")) {
        contentBlocks.push(
          `<p><video controls src="${item.video.url}" style="max-width:100%"></video></p>`
        );
      } else {
        contentBlocks.push(`<p><a href="${item.video.url}">Watch video</a></p>`);
      }
    }

    // Original description/content
    if (item.description) {
      contentBlocks.push(item.description);
    }

    // Source attribution
    contentBlocks.push(`<p><small>Source: ${item.source}</small></p>`);

    feed.addItem({
      id: item.link,
      title: item.title,
      link: item.link,
      date: item.date,
      description: item.description?.replace(/<[^>]+>/g, "").slice(0, 280),
      content: contentBlocks.join("\n"),
      author: item.authorName ? [{ name: item.authorName }] : undefined,
      // Primary enclosure: prefer video, else original enclosure, else image
      enclosure: item.video
        ? { url: item.video.url, type: item.video.type }
        : item.enclosure
        ? { url: item.enclosure.url, type: item.enclosure.type || "" }
        : item.imageUrl
        ? { url: item.imageUrl, type: "image/jpeg" } // safe default
        : undefined,
    });
  }

  return {
    rss: feed.rss2(),   // application/rss+xml
    atom: feed.atom1(), // application/atom+xml
    json: feed.json1(), // application/feed+json
  };
}

// ==== 3) HTTP routes ====
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `Multi-Source Feed
    - RSS:  /rss.xml
    - Atom: /atom.xml
    - JSON: /feed.json
    Last build: ${CACHE.lastBuild.toISOString()}
    Items: ${CACHE.items.length}
    `
  );
});

app.get("/rss.xml", (_req, res) => {
  const { rss } = buildFeeds();
  res.type("application/rss+xml").send(rss);
});

app.get("/atom.xml", (_req, res) => {
  const { atom } = buildFeeds();
  res.type("application/atom+xml").send(atom);
});

app.get("/feed.json", (_req, res) => {
  const { json } = buildFeeds();
  res.type("application/feed+json").send(json);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, lastBuild: CACHE.lastBuild, count: CACHE.items.length });
});

// ==== 4) Schedule refresh ====
// Refresh every 15 minutes (adjust as needed). Also refresh on boot.
cron.schedule("*/15 * * * *", refresh);
refresh().catch(console.error);

// ==== 5) Start server ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MultiFeed running on http://localhost:${PORT}`));
