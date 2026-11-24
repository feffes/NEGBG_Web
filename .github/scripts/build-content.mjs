/*
  Turns a parsed GitHub Issue Form into Hugo content.

  Usage: node build-content.mjs <new-tournament|news-post>
  Reads the parsed issue JSON from $ISSUE_JSON (stefanbuck/github-issue-parser)
  and the issue number from $ISSUE_NUMBER.

  The workflow always runs this on a fresh checkout of master, so every run (the
  first one and every edit of the issue) rebuilds the content from scratch and the
  PR branch is force-updated to match the issue.

  On a validation failure it writes a reader-friendly explanation to $GITHUB_OUTPUT
  as `error` and exits 1; the workflow posts that back as an issue comment.
*/

import { mkdir, writeFile, readdir, access, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
const TZ = "Europe/Stockholm";
const LANGS = ["sv", "en"];

/* Every event so far has been here, so it is the default rather than four fields to fill in. */
const KAPPA_BAR = {
  name: "Kappa Bar",
  street: "Rosenlundsgatan 8",
  postal_code: "411 20",
  city: "Göteborg",
  country: "SE",
};

const CHECKIN_MINUTES_BEFORE_START = 30;

class UserError extends Error {}

/* ---------- issue form field access ---------- */

/* Issue forms send this literal string for a skipped optional field. */
const NO_RESPONSE = "_No response_";

const fields = JSON.parse(process.env.ISSUE_JSON ?? "{}");
const issueNumber = process.env.ISSUE_NUMBER ?? "local";

function field(id) {
  const raw = fields[id];
  if (typeof raw !== "string") return "";
  let value = raw.trim();
  if (value === NO_RESPONSE) return "";
  /* `render:` textareas arrive wrapped in a code fence on some parser versions. */
  const fenced = value.match(/^```[a-z]*\n([\s\S]*?)\n?```$/);
  if (fenced) value = fenced[1].trim();
  return value;
}

function required(id, label) {
  const value = field(id);
  if (!value) throw new UserError(`**${label}** is required but was left empty.`);
  return value;
}

function validSlug(value, label, example) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) {
    throw new UserError(
      `**${label}** must be lowercase letters, numbers and hyphens only, e.g. \`${example}\`. Got \`${value}\`.`,
    );
  }
  return value;
}

async function mustNotExist(dir, label) {
  if (await exists(dir)) {
    throw new UserError(`\`${path.relative(REPO, dir)}\` already exists. Pick a different **${label}**.`);
  }
}

/* ---------- dates ---------- */

/* Hugo reads data.toml datetimes as local time, so they are written without an offset. */
function localDateTime(day, time) {
  return `${day}T${time}:00`;
}

function offsetFor(date) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value;
  return parts.replace("GMT", "") || "+00:00";
}

/* Matches the news front matter convention, e.g. 2026-05-17T12:00:00+02:00 */
function rfc3339(date) {
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  return `${f.format(date).replace(" ", "T")}${offsetFor(date)}`;
}

function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date());
}

function parseStart(value) {
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
  if (!m) {
    throw new UserError(
      `**Start** must look like \`2026-05-31 16:00\` (date, space, 24-hour time). Got \`${value}\`.`,
    );
  }
  return { day: m[1], time: m[2] };
}

/* End may be just a time (same day as start) or a full date and time. */
function parseEnd(value, startDay) {
  const timeOnly = value.match(/^(\d{2}:\d{2})$/);
  if (timeOnly) return { day: startDay, time: timeOnly[1] };

  const full = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
  if (!full) {
    throw new UserError(
      `**End** must be a time like \`20:00\`, or a full \`2026-05-31 20:00\`. Got \`${value}\`.`,
    );
  }
  return { day: full[1], time: full[2] };
}

function subtractMinutes(time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m - minutes + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/* ---------- TOML ---------- */

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function frontMatter(pairs) {
  const lines = Object.entries(pairs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k} = ${v}`);
  return `+++\n${lines.join("\n")}\n+++\n`;
}

/* ---------- images ---------- */

const IMAGE_URL = /https:\/\/(?:github\.com\/user-attachments\/assets|user-images\.githubusercontent\.com)\/[^\s)"'<>]+/g;

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/* The same upload is often reused across both languages and bundles; fetch it once. */
const downloads = new Map();

/* The repo is public, so attachment URLs need no auth. */
function download(url) {
  if (!downloads.has(url)) {
    downloads.set(url, (async () => {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new UserError(`Could not download an uploaded image (${res.status}): ${url}`);

      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      const ext = EXTENSIONS[type];
      if (!ext) {
        throw new UserError(
          `An upload is not an image Hugo can process (got \`${type || "unknown"}\`). Use JPEG, PNG, WebP or GIF.`,
        );
      }
      return { ext, bytes: Buffer.from(await res.arrayBuffer()) };
    })());
  }
  return downloads.get(url);
}

function imageUrls(text) {
  return [...new Set(text.match(IMAGE_URL) ?? [])];
}

async function writeImage(dir, name, image) {
  await mkdir(dir, { recursive: true });
  const file = `${name}.${image.ext}`;
  await writeFile(path.join(dir, file), image.bytes);
  return file;
}

/* Returns the first image dragged into a cover field, or null when the field is empty. */
async function coverImage(id, { optional = false } = {}) {
  const value = optional ? field(id) : required(id, "Cover image");
  if (!value) return null;
  const [url] = imageUrls(value);
  if (!url) {
    throw new UserError("**Cover image** did not contain an image. Drag an image file into that box.");
  }
  return download(url);
}

/*
  Rewrites images the author dragged into the body into the site's figure shortcode,
  so they get the WebP/JPEG <picture> pipeline in partials/img.html. The markdown alt
  text becomes the caption. Images are saved into the page bundle alongside index.*.md,
  numbered in the order they appear across every body written into that bundle.
*/
const bundleImageNames = new Map();

async function rewriteBody(body, bundle) {
  const names = bundleImageNames.get(bundle) ?? new Map();
  bundleImageNames.set(bundle, names);

  let out = body;
  for (const url of imageUrls(body)) {
    if (!names.has(url)) {
      names.set(url, await writeImage(bundle, `image-${names.size + 1}`, await download(url)));
    }
    const file = names.get(url);
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    /* ![caption](url) and GitHub's <img src="url"> first, so the alt text is not lost,
       then any bare occurrences. */
    out = out
      .replace(
        new RegExp(`!\\[([^\\]]*)\\]\\(\\s*${escaped}\\s*\\)`, "g"),
        (_, caption) => figure(file, caption),
      )
      .replace(
        new RegExp(`<img\\b[^>]*\\bsrc="${escaped}"[^>]*>`, "g"),
        (tag) => figure(file, tag.match(/\balt="([^"]*)"/)?.[1] ?? ""),
      )
      .replace(new RegExp(escaped, "g"), file);
  }

  return out.trim();
}

function figure(file, caption) {
  const text = caption.trim();
  /* GitHub fills alt with "image" or the upload's filename when the author did not write one. */
  if (!text || /^image$/i.test(text) || /\.(jpe?g|png|webp|gif)$/i.test(text)) {
    return `{{< figure src="${file}" >}}`;
  }
  return `{{< figure src="${file}" caption="${text.replace(/"/g, "'")}" >}}`;
}

/* The gallery shortcode is zero-config: it globs <bundle>/gallery/. */
async function writeGallery(bundle) {
  const urls = imageUrls(field("gallery"));
  for (const [i, url] of urls.entries()) {
    await writeImage(path.join(bundle, "gallery"), String(i + 1).padStart(2, "0"), await download(url));
  }
  return urls.length > 0;
}

/* Authors type `1 | feffe | May`; the shortcode expects the player name bolded. */
function resultsTable() {
  const placements = field("results")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((p) => p.trim());
      if (parts.length < 3) {
        throw new UserError(
          `Each **Placements** line needs \`place | player | character\`, e.g. \`1 | feffe | May\`. Got \`${line}\`.`,
        );
      }
      const [place, player, ...rest] = parts;
      const name = /^\*\*.*\*\*$/.test(player) ? player : `**${player}**`;
      return `${place} | ${name} | ${rest.join(" | ")}`;
    });

  if (placements.length === 0) return "";
  /* Matches the hand-written results posts: a "## Top 8" section after the write-up. */
  return `## Top ${placements.length}\n\n` +
    `{{< tournament-results >}}\n${placements.join("\n")}\n{{< /tournament-results >}}`;
}

/* ---------- announcement logistics ---------- */

/*
  Price, check-in and start time are already fields in data.toml, so the sentence that
  repeats them in the announcement is generated rather than hand-typed. Parts drop out
  when the matching field is blank (free event, no signup link).
*/
function logistics(lang, { price, checkinTime, startTime, tournamentUrl }) {
  const t = lang === "sv"
    ? {
        entry: (p) => `Inträde ${p} kr`,
        free: "Gratis inträde",
        signup: (u) => `Anmäl dig på [turneringssidan](${u}).`,
      }
    : {
        entry: (p) => `Entry ${p} SEK`,
        free: "Free entry",
        signup: (u) => `Sign up on the [tournament page](${u}).`,
      };

  const parts = [price ? t.entry(price) : t.free, `check-in ${checkinTime}`, `start ${startTime}`];
  const sentences = [`${parts.join(", ")}.`];
  if (tournamentUrl) sentences.push(t.signup(tournamentUrl));
  return sentences.join(" ");
}

/* ---------- form: new tournament (event + announcement) ---------- */

async function newTournament() {
  const slug = validSlug(required("slug", "Event slug"), "Event slug", "kappa-kabrak-4");

  const eventDir = path.join(REPO, "content/events", slug);
  const newsDir = path.join(REPO, "content/news", `${slug}-announcement`);
  await mustNotExist(eventDir, "Event slug");
  await mustNotExist(newsDir, "Event slug");

  const start = parseStart(required("start", "Start"));
  const end = parseEnd(required("end", "End"), start.day);
  if (localDateTime(end.day, end.time) <= localDateTime(start.day, start.time)) {
    throw new UserError("**End** must be after **Start**.");
  }

  const checkinTime = field("checkin_time") ||
    subtractMinutes(start.time, CHECKIN_MINUTES_BEFORE_START);
  if (!/^\d{2}:\d{2}$/.test(checkinTime)) {
    throw new UserError(`**Check-in** must be a time like \`15:30\`. Got \`${checkinTime}\`.`);
  }

  const price = field("price");
  if (price && !/^\d+$/.test(price)) {
    throw new UserError(`**Price** must be a whole number of kronor, or blank if free. Got \`${price}\`.`);
  }

  const tournamentUrl = field("tournament_url");
  const discordUrl = field("discord_url");

  const location = field("venue").startsWith("Kappa Bar")
    ? KAPPA_BAR
    : {
        name: required("venue_name", "Venue name"),
        street: field("venue_street"),
        postal_code: field("venue_postal_code"),
        city: field("venue_city"),
        country: "SE",
      };

  /* Read every required text field before anything is written, so a failure here
     cannot leave a half-built bundle on the branch. */
  const text = Object.fromEntries(
    LANGS.map((lang) => [
      lang,
      {
        title: required(`title_${lang}`, `Title (${lang})`),
        summary: required(`summary_${lang}`, `Summary (${lang})`),
        body: required(`body_${lang}`, `Description (${lang})`),
        announcement: field(`announcement_${lang}`),
      },
    ]),
  );

  /* The event and the announcement share one cover file, which is why it goes in
     static/images/ rather than either page bundle. */
  const coverFile = await writeImage(path.join(REPO, "static/images"), `${slug}-cover`, await coverImage("cover"));
  const cover = `/images/${coverFile}`;

  await mkdir(eventDir, { recursive: true });
  await mkdir(newsDir, { recursive: true });

  await writeFile(
    path.join(eventDir, "data.toml"),
    [
      `start_date = ${tomlString(localDateTime(start.day, start.time))}`,
      `end_date = ${tomlString(localDateTime(end.day, end.time))}`,
      ...(price ? [`price = ${price}`, `price_currency = "SEK"`] : []),
      `cover = ${tomlString(cover)}`,
      `checkin_time = ${tomlString(checkinTime)}`,
      ...(tournamentUrl ? [`tournament_url = ${tomlString(tournamentUrl)}`] : []),
      ...(discordUrl ? [`discord_url = ${tomlString(discordUrl)}`] : []),
      "",
      "[location]",
      `name = ${tomlString(location.name)}`,
      ...(location.street ? [`street = ${tomlString(location.street)}`] : []),
      ...(location.postal_code ? [`postal_code = ${tomlString(location.postal_code)}`] : []),
      ...(location.city ? [`city = ${tomlString(location.city)}`] : []),
      `country = ${tomlString(location.country)}`,
      "",
    ].join("\n"),
  );

  const now = new Date();

  for (const lang of LANGS) {
    const { title, summary, body, announcement } = text[lang];

    await writeFile(
      path.join(eventDir, `index.${lang}.md`),
      frontMatter({
        title: tomlString(title),
        date: today(),
        draft: "false",
        summary: tomlString(summary),
      }) + `\n${await rewriteBody(body, eventDir)}\n`,
    );

    /* Images in the body belong to whichever bundle renders them, so each bundle gets
       its own copy. Rewriting per bundle keeps the src filenames correct in both. */
    await writeFile(
      path.join(newsDir, `index.${lang}.md`),
      frontMatter({
        title: tomlString(title),
        date: tomlString(rfc3339(now)),
        draft: "false",
        cover: tomlString(cover),
        event_link: `[${tomlString(slug)}]`,
        event_role: tomlString("announcement"),
      }) +
        `\n${await rewriteBody(announcement || body, newsDir)}\n\n` +
        `${logistics(lang, { price, checkinTime, startTime: start.time, tournamentUrl })}\n`,
    );
  }

  return {
    title: `Ny turnering: ${text.sv.title}`,
    summary: [
      `Adds the event \`content/events/${slug}\` and its announcement post \`content/news/${slug}-announcement\`.`,
      "",
      `- **When:** ${start.day} ${start.time} to ${end.day === start.day ? "" : `${end.day} `}${end.time}, check-in ${checkinTime}`,
      `- **Where:** ${location.name}`,
      `- **Price:** ${price ? `${price} SEK` : "free"}`,
    ].join("\n"),
  };
}

/* ---------- form: news post (optionally linked to an event) ---------- */

const ROLES = [
  ["Announcement", "announcement"],
  ["Recap", "recap"],
];

async function newsPost() {
  const slug = validSlug(required("slug", "Post slug"), "Post slug", "kappa-kabrak-4-results");
  const newsDir = path.join(REPO, "content/news", slug);
  await mustNotExist(newsDir, "Post slug");

  const notes = [];

  const eventSlug = field("event_slug");
  let role = "";
  if (eventSlug) {
    validSlug(eventSlug, "Event slug", "kappa-kabrak-4");
    role = ROLES.find(([label]) => field("event_role").startsWith(label))?.[1] ?? "";

    /* The event may live in another open PR (e.g. a tournament form filed the same day),
       so a missing event is flagged on the PR instead of blocking it. */
    if (!(await exists(path.join(REPO, "content/events", eventSlug)))) {
      const events = (await readdir(path.join(REPO, "content/events"), { withFileTypes: true }))
        .filter((e) => e.isDirectory() && e.name !== "archive")
        .map((e) => `\`${e.name}\``);
      notes.push(
        `> [!WARNING]\n> There is no event \`${eventSlug}\` on master yet. The link only works once that event exists. ` +
          `Existing events: ${events.join(", ")}.`,
      );
    }
  }

  /* Read and validate everything before anything is written, so a failure here
     cannot leave a half-built bundle on the branch. */
  const text = Object.fromEntries(
    LANGS.map((lang) => [
      lang,
      {
        title: required(`title_${lang}`, `Title (${lang})`),
        intro: field(`intro_${lang}`),
        body: required(`body_${lang}`, `Text (${lang})`),
      },
    ]),
  );
  const results = resultsTable();

  const cover = await coverImage("cover", { optional: true });
  const coverFile = cover ? await writeImage(newsDir, "cover", cover) : "";
  const hasGallery = await writeGallery(newsDir);

  const now = new Date();

  for (const lang of LANGS) {
    const { title, intro, body } = text[lang];

    const sections = [];
    if (intro) sections.push(await rewriteBody(intro, newsDir), "<!--more-->");
    sections.push(await rewriteBody(body, newsDir));
    if (results) sections.push(results);
    if (hasGallery) sections.push(`## ${lang === "sv" ? "Galleri" : "Gallery"}`, "{{< gallery >}}");

    await mkdir(newsDir, { recursive: true });
    await writeFile(
      path.join(newsDir, `index.${lang}.md`),
      frontMatter({
        title: tomlString(title),
        date: tomlString(rfc3339(now)),
        draft: "false",
        cover: coverFile && tomlString(coverFile),
        event_link: eventSlug && `[${tomlString(eventSlug)}]`,
        event_role: eventSlug && role && tomlString(role),
      }) + `\n${sections.join("\n\n")}\n`,
    );
  }

  const linked = eventSlug
    ? ` linked to the event \`${eventSlug}\`${role ? ` as ${role === "recap" ? "a recap" : "an announcement"}` : ""}`
    : "";
  return {
    title: `Nyhet: ${text.sv.title}`,
    summary: [`Adds the news post \`content/news/${slug}\`${linked}.`, ...notes].join("\n\n"),
  };
}

/* ---------- plumbing ---------- */

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${randomUUID()}`;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

const BUILDERS = {
  "new-tournament": newTournament,
  "news-post": newsPost,
};

const formType = process.argv[2];
const build = BUILDERS[formType];
if (!build) {
  console.error(`Unknown form type: ${formType}. Expected one of ${Object.keys(BUILDERS).join(", ")}.`);
  process.exit(2);
}

try {
  const result = await build();
  /* Keyed on the issue, not the slug, so renaming the slug in an edit updates the
     same PR instead of opening a second one. */
  result.branch = `issue-form/${issueNumber}`;
  for (const [key, value] of Object.entries(result)) await setOutput(key, value);
  console.log(result.summary);
} catch (error) {
  if (!(error instanceof UserError)) throw error;
  await setOutput("error", error.message);
  console.error(error.message);
  process.exit(1);
}
