mkdir multi-feed && cd multi-feed
npm init -y
npm i express rss-parser feed node-cron undici

    Packages:

        express – HTTP server

        rss-parser – reads RSS/Atom sources

        feed – outputs RSS/Atom/JSON Feed

        node-cron – scheduled refresh

        undici – fast fetch (we’ll use if we need to probe URLs)

        What it is (high level)

A tiny feed aggregator you run as a web service. It:

Fetches many sources (RSS/Atom/JSON Feed, e.g., blogs, YouTube).

Normalizes the items into one consistent shape.

De-dupes by canonical link and sorts newest → oldest.

Publishes a single unified feed in three formats:

RSS 2.0 → /rss.xml

Atom 1.0 → /atom.xml

JSON Feed → /feed.json

Embeds media (links, images, videos) using standard enclosures and inline HTML so most readers render previews/players.

The moving parts
1) Dependencies

express – serves the feed over HTTP.

rss-parser – reads/merges RSS or Atom feeds.

feed – outputs RSS/Atom/JSON Feed formats.

node-cron – schedules periodic refreshes (every 15 minutes).

undici – fetches URLs; used to read JSON Feeds or APIs.

2) Config: SOURCES

A simple array of feed URLs (can be RSS/Atom or JSON Feed). You can add/remove sources freely. Examples included: Hacker News, a YouTube channel, Mozilla blog, and a JSON Feed site.

3) In-memory cache

CACHE holds the latest merged items and timestamp. It’s rebuilt on boot and then every 15 minutes via node-cron. (For production, you’d likely persist this in Redis/Postgres so restarts don’t clear it.)

The data flow (step by step)

Boot

App starts Express server.

Calls refresh() once to populate the cache.

Schedules refresh() to run every 15 minutes.

Refresh

For each URL in SOURCES:

Tries JSON Feed parsing first (tryParseJSONFeed). If it looks like JSON and has items[], normalize it.

Otherwise uses rss-parser to parse as RSS/Atom.

Each item gets normalized to a common structure: {title, link, date, description, author, imageUrl, video, enclosure, source}.

Media detection

Images: looks for standard RSS enclosure with image MIME type, media:* tags, <img src=…> inside HTML, or JSON Feed’s image/banner_image.

Videos: prefers enclosure type="video/*", scans media:group, direct .mp4/.webm in content, or recognizes YouTube links.

De-dupe & sort

Uses the item link as the canonical key.

Skips duplicates (seen Set).

Sorts items by date (newest first).

Serve feeds

On every request to /rss.xml, /atom.xml, or /feed.json, it builds a feed from the current cache using the feed library.

For each item, it assembles HTML content blocks (image tag, video player or “watch” link, original content, and a small “Source:” line).

It also attaches an enclosure (video if available; else original enclosure; else image) so clients that rely on enclosures can render media.

The HTTP endpoints

/ – simple text status (links to the feed URLs, last build time, item count).

/rss.xml – RSS 2.0 version of the unified feed.

/atom.xml – Atom 1.0 version of the unified feed.

/feed.json – JSON Feed 1.1 version of the unified feed.

/health – JSON health check with last build timestamp and item count.

You can test locally:
