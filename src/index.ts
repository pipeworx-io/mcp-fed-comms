interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * Federal Reserve communications from federalreserve.gov: the FOMC meeting calendar, each policy statement with the rate decision, vote and a sentence-level redline against the prior statement, meeting minutes by section, Board speeches and testimony, and the Beige Book by district.
 *
 * Auth: none (keyless HTML/RSS on federalreserve.gov).
 *
 * Page shapes this pack depends on (verified 2026-08-28):
 *   - Calendar rows: `<div class="... fomc-meeting">` with `fomc-meeting__month`
 *     (may be "April/May" for a cross-month meeting) and `fomc-meeting__date`
 *     ("27-28", "17-18*" — the asterisk marks an SEP meeting — or
 *     "22 (notation vote)"). Statement / implementation-note / minutes links
 *     sit inside the same row.
 *   - Statement: `/newsevents/pressreleases/monetary{YYYYMMDD}a.htm`; the
 *     implementation note is the same slug with `a1`; the once-a-year
 *     "Statement on Longer-Run Goals" is `b`. First paragraph carries the
 *     tally ("by a 9 – 3 vote"); dissents are a "Voting against ..." paragraph.
 *   - Minutes: `/monetarypolicy/fomcminutes{YYYYMMDD}.htm`; sections are
 *     `<p><strong>Heading</strong><br /> text…</p>`.
 *   - Beige Book: `/monetarypolicy/beigebook{YYYYMM}-{district}.htm`
 *     (`-summary` is the national summary); the edition landing page is only
 *     the "About this publication" boilerplate. Editions are listed at
 *     `/monetarypolicy/publications/beige-book-default.htm`.
 *   - Feeds: `/feeds/speeches.xml`, `/feeds/testimony.xml`, ~20 items each.
 *     Item titles are "Lastname, Title".
 */


const ORIGIN = 'https://www.federalreserve.gov';
const CALENDAR_URL = `${ORIGIN}/monetarypolicy/fomccalendars.htm`;
const BEIGE_INDEX_URL = `${ORIGIN}/monetarypolicy/publications/beige-book-default.htm`;
const SPEECHES_FEED = `${ORIGIN}/feeds/speeches.xml`;
const TESTIMONY_FEED = `${ORIGIN}/feeds/testimony.xml`;
// federalreserve.gov sits behind a bot-filtering CDN that is happier with a
// browser-shaped UA than with a library one.
const UA = 'Mozilla/5.0 (compatible; pipeworx-mcp-fed-comms/1.0; +https://pipeworx.io)';
const FETCH_TIMEOUT_MS = 12_000;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const DISTRICTS: { n: number; name: string; slug: string; aliases: string[] }[] = [
  { n: 1, name: 'Boston', slug: 'boston', aliases: ['first', '1st', 'ma', 'new england'] },
  { n: 2, name: 'New York', slug: 'new-york', aliases: ['second', '2nd', 'ny', 'nyc'] },
  { n: 3, name: 'Philadelphia', slug: 'philadelphia', aliases: ['third', '3rd', 'philly', 'pa'] },
  { n: 4, name: 'Cleveland', slug: 'cleveland', aliases: ['fourth', '4th', 'oh'] },
  { n: 5, name: 'Richmond', slug: 'richmond', aliases: ['fifth', '5th', 'va'] },
  { n: 6, name: 'Atlanta', slug: 'atlanta', aliases: ['sixth', '6th', 'ga'] },
  { n: 7, name: 'Chicago', slug: 'chicago', aliases: ['seventh', '7th', 'il'] },
  { n: 8, name: 'St. Louis', slug: 'st-louis', aliases: ['eighth', '8th', 'st louis', 'saint louis', 'mo'] },
  { n: 9, name: 'Minneapolis', slug: 'minneapolis', aliases: ['ninth', '9th', 'mn'] },
  { n: 10, name: 'Kansas City', slug: 'kansas-city', aliases: ['tenth', '10th', 'kc', 'ks'] },
  { n: 11, name: 'Dallas', slug: 'dallas', aliases: ['eleventh', '11th', 'tx', 'texas'] },
  { n: 12, name: 'San Francisco', slug: 'san-francisco', aliases: ['twelfth', '12th', 'sf', 'ca', 'california'] },
];

const tools: McpToolExport['tools'] = [
  {
    name: 'fomc_calendar',
    description:
      'FOMC meeting calendar from the Federal Reserve Board: every scheduled and unscheduled meeting of a year with dates, whether it carries a Summary of Economic Projections (SEP), statement, press-conference, implementation-note and minutes links (with the minutes release date), plus next_meeting and days_until from today. Answers "when is the next FOMC meeting", "what are the Fed meeting dates in 2026", "when do the minutes for the July meeting come out".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        year: { type: 'integer', description: 'Calendar year, e.g. 2026. Default: the current year. The Fed page carries roughly the last 6 years plus next year.' },
      },
    },
  },
  {
    name: 'fomc_statement',
    description:
      'FOMC post-meeting policy statement from the Federal Reserve with the rate decision parsed (target range, hold/cut/hike, basis points), the vote tally with named dissenters and what they preferred, the implementation-note URL, and diff_vs_prior — a sentence-level redline against the previous statement listing sentences added, removed and changed (date and roll-call lines excluded). Answers "what changed in the latest Fed statement", "did the FOMC cut rates", "who dissented at the Fed meeting".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Statement date as YYYY-MM-DD or YYYY-MM (e.g. "2026-06-17" or "2026-06"). Default: the most recent released statement.' },
        compare_to: { type: 'string', description: 'Date of the statement to diff against (YYYY-MM-DD or YYYY-MM). Default: the statement immediately before the selected one.' },
        include_text: { type: 'boolean', description: 'Include the full statement text (default true). Set false for a compact rate-decision + diff answer.' },
      },
    },
  },
  {
    name: 'fomc_minutes',
    description:
      'Minutes of an FOMC meeting from the Federal Reserve Board: full text split into its sections (Developments in Financial Markets, Staff Review of the Economic Situation, Participants\' Views, Committee Policy Actions, votes, attendance) with an optional section filter. Answers "what did the FOMC minutes say about inflation", "summarize participants\' views in the latest Fed minutes", "who attended the June FOMC meeting".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        date: { type: 'string', description: 'Meeting date as YYYY-MM-DD or YYYY-MM (e.g. "2026-06"). Default: the most recently released minutes.' },
        section: { type: 'string', description: 'Case-insensitive substring of a section heading, e.g. "Participants\' Views", "Policy Actions", "Staff Economic Outlook". Returns only that section\'s text.' },
      },
    },
  },
  {
    name: 'fed_speeches',
    description:
      'Recent speeches and congressional testimony by Federal Reserve Board governors and the Chair, from the Board\'s speeches and testimony feeds: title, speaker with official title, date, venue, URL and the opening paragraph. Filter by days back and speaker surname. Answers "what did Fed governors say this week", "latest speech by Waller", "Powell testimony".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'integer', description: 'Look back this many days (default 14). The feeds only carry the latest ~20 items each, so the window is capped by what the feed still holds — see feed_window in the response.' },
        speaker: { type: 'string', description: 'Surname to filter on, case-insensitive substring, e.g. "Cook", "Warsh", "Jefferson".' },
        include_testimony: { type: 'boolean', description: 'Also read the testimony feed (default true).' },
        limit: { type: 'integer', description: 'Max items to return and open for their first paragraph (default 10, max 25).' },
      },
    },
  },
  {
    name: 'beige_book',
    description:
      'Beige Book from the Federal Reserve — the eight-times-a-year summary of current economic conditions gathered by the 12 Federal Reserve Districts: the national summary or one district\'s report (Boston, New York, Philadelphia, Cleveland, Richmond, Atlanta, Chicago, St. Louis, Minneapolis, Kansas City, Dallas, San Francisco) split into its sections (Overall Economic Activity, Labor Markets, Prices, and the district\'s industry sections). Answers "what does the latest Beige Book say about the Dallas district", "Beige Book labor market conditions", "regional economic conditions per the Fed".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edition: { type: 'string', description: 'Edition as YYYY-MM or YYYYMM (e.g. "2026-07"). Default: the latest published edition.' },
        district: { type: 'string', description: 'District name, city, or number 1–12 (e.g. "Dallas", "Kansas City", "11"). Default: the national summary.' },
      },
    },
  },
];

// ── HTTP + HTML helpers ─────────────────────────────────────────────

// Dated pages (a statement, a set of minutes, a Beige Book) never change once
// published, so a per-isolate memo saves the second fetch inside a burst —
// e.g. the diff needs two statements and a follow-up call needs the same two.
const pageMemo = new Map<string, string | null>();

async function fetchText(url: string, accept = 'text/html'): Promise<string | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await httpError(res, 'federalreserve.gov');
  return res.text();
}

async function fetchDatedPage(url: string): Promise<string | null> {
  if (pageMemo.has(url)) return pageMemo.get(url) ?? null;
  const text = await fetchText(url);
  if (pageMemo.size > 60) pageMemo.delete(pageMemo.keys().next().value as string);
  pageMemo.set(url, text);
  return text;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<sup>.*?<\/sup>/gs, '') // footnote markers
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/ /g, ' ')
    .replace(/[\u2010\u2011]/g, '-') // the Fed's "3‑3/4" uses a non-breaking hyphen
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The article body of a federalreserve.gov page, share widget and chrome removed. */
function articleHtml(page: string): string {
  const start = page.indexOf('id="article"');
  if (start < 0) return '';
  let end = page.indexOf('id="lastUpdate"', start);
  if (end < 0) end = page.indexOf('<footer', start);
  if (end < 0) end = page.length;
  return page
    .slice(start, end)
    .replace(/<ul class="list-unstyled">\s*<li class=['"]share[\s\S]*?<\/ul>\s*<\/li>\s*<\/ul>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

interface Block { tag: 'h3' | 'h4' | 'h5' | 'p'; text: string; strongLead?: string }

/** Ordered headings and paragraphs of an article. */
function blocks(article: string): Block[] {
  const out: Block[] = [];
  // Stop at the element's own close tag OR the next block open tag: the Fed's
  // press-release template leaves `<p class="releaseTime">` unclosed, and a
  // close-tag-only match would swallow the first real paragraph into it.
  const re = /<(h3|h4|h5|p)\b([^>]*)>([\s\S]*?)(?=<\/(?:h3|h4|h5|p)>|<(?:h3|h4|h5|p)\b)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(article))) {
    const tag = m[1].toLowerCase() as Block['tag'];
    // Byline/dateline paragraphs (speaker, venue, release time) are metadata,
    // not prose — metaOf() reads them; here they would pose as the opening line.
    if (/class=['"][^'"]*\b(speaker|location|article__time|releaseTime)\b/i.test(m[2])) continue;
    const inner = m[3];
    const text = stripTags(inner);
    if (!text) continue;
    const block: Block = { tag, text };
    // Minutes-style section lead: <p><strong>Heading</strong><br /> body…
    const lead = /^\s*((?:<strong>[\s\S]*?<\/strong>\s*)+)<br/i.exec(inner);
    if (tag === 'p' && lead) block.strongLead = stripTags(lead[1]).replace(/\n/g, '');
    out.push(block);
  }
  return out;
}

function metaOf(article: string): { title: string; date: string; speaker?: string; location?: string } {
  const title = stripTags(/<h3[^>]*class=['"]title['"][^>]*>([\s\S]*?)<\/h3>/i.exec(article)?.[1] ?? /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(article)?.[1] ?? '');
  const date = stripTags(/<p[^>]*class=['"]article__time['"][^>]*>([\s\S]*?)<\/p>/i.exec(article)?.[1] ?? '');
  const speaker = /<p[^>]*class=['"]speaker['"][^>]*>([\s\S]*?)<\/p>/i.exec(article)?.[1];
  const location = /<p[^>]*class=['"]location['"][^>]*>([\s\S]*?)<\/p>/i.exec(article)?.[1];
  return {
    title,
    date: isoFromLongDate(date) ?? date,
    ...(speaker ? { speaker: stripTags(speaker) } : {}),
    ...(location ? { location: stripTags(location) } : {}),
  };
}

function isoFromLongDate(s: string): string | undefined {
  const m = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
  if (!m) return undefined;
  const mi = MONTHS.indexOf(m[1]);
  if (mi < 0) return undefined;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function isoFromCompact(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

/** Accepts "2026-06-17", "20260617", "2026-06", "202606", "latest"; returns a YYYYMMDD prefix. */
function normalizeDateArg(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === 'latest' || s === 'current') return undefined;
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 8 || digits.length === 6) return digits;
  throw new Error(`Date "${v}" not understood. Pass YYYY-MM-DD (e.g. "2026-06-17") or YYYY-MM (e.g. "2026-06").`);
}

function intArg(args: Record<string, unknown>, key: string, dflt: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === '') return dflt;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new Error(`"${key}" must be an integer.`);
  return Math.min(max, Math.max(min, n));
}

// ── FOMC calendar ───────────────────────────────────────────────────

interface Meeting {
  year: number;
  month: string;
  days: string;
  start_date: string;
  end_date: string;
  meeting_type: 'scheduled' | 'notation_vote' | 'unscheduled';
  note?: string;
  has_projections: boolean;
  statement_date?: string;
  statement_url?: string;
  implementation_note_url?: string;
  press_conference_url?: string;
  projections_url?: string;
  longer_run_goals_url?: string;
  minutes_date?: string;
  minutes_url?: string;
  minutes_released?: string;
}

let calendarMemo: { at: number; meetings: Meeting[] } | null = null;

async function loadCalendar(): Promise<Meeting[]> {
  // The calendar changes a handful of times a year; a 10-minute memo keeps a
  // burst of statement/minutes calls from re-downloading 160 KB each time.
  if (calendarMemo && Date.now() - calendarMemo.at < 600_000) return calendarMemo.meetings;
  const page = await fetchText(CALENDAR_URL);
  if (!page) throw new Error('federalreserve.gov: FOMC calendar page returned 404.');
  const meetings = parseCalendar(page);
  if (meetings.length === 0) throw new Error('federalreserve.gov: FOMC calendar page parsed to zero meetings — the page layout may have changed.');
  calendarMemo = { at: Date.now(), meetings };
  return meetings;
}

function parseCalendar(page: string): Meeting[] {
  const panels: { year: number; start: number }[] = [];
  const yearRe = /<a id="\d+">(\d{4}) FOMC Meetings<\/a>/g;
  let ym: RegExpExecArray | null;
  while ((ym = yearRe.exec(page))) panels.push({ year: Number(ym[1]), start: ym.index });
  const meetings: Meeting[] = [];
  panels.forEach((panel, i) => {
    const html = page.slice(panel.start, panels[i + 1]?.start ?? page.length);
    const rowRe = /<div class="[^"]*\bfomc-meeting"[^>]*>([\s\S]*?)(?=<div class="[^"]*\bfomc-meeting"|<\/div>\s*<\/div>\s*<div class="panel|$)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(html))) {
      const row = rm[1];
      const month = stripTags(/fomc-meeting__month[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1] ?? '');
      const dateText = stripTags(/fomc-meeting__date[^>]*>([\s\S]*?)<\/div>/.exec(row)?.[1] ?? '');
      if (!month || !dateText) continue;
      const m = buildMeeting(panel.year, month, dateText, row);
      if (m) meetings.push(m);
    }
  });
  meetings.sort((a, b) => a.start_date.localeCompare(b.start_date));
  return meetings;
}

function buildMeeting(year: number, month: string, dateText: string, row: string): Meeting | null {
  const months = month.split('/').map((s) => s.trim());
  const mi0 = MONTHS.findIndex((n) => n.toLowerCase().startsWith(months[0].slice(0, 3).toLowerCase()));
  const mi1 = months.length > 1 ? MONTHS.findIndex((n) => n.toLowerCase().startsWith(months[1].slice(0, 3).toLowerCase())) : mi0;
  if (mi0 < 0) return null;
  const note = /\(([^)]*)\)/.exec(dateText)?.[1]?.trim();
  const dayNums = (dateText.replace(/\([^)]*\)/g, '').match(/\d{1,2}/g) ?? []).map(Number);
  if (dayNums.length === 0) return null;
  const d0 = dayNums[0];
  const d1 = dayNums[dayNums.length - 1];
  const iso = (mi: number, d: number) => `${year}-${String(mi + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const start_date = iso(mi0, d0);
  const end_date = iso(mi1 >= 0 ? mi1 : mi0, d1);
  const link = (re: RegExp) => {
    const x = re.exec(row);
    return x ? `${ORIGIN}${x[1]}` : undefined;
  };
  const statement = /href="(\/newsevents\/pressreleases\/monetary(\d{8})a\.htm)"/.exec(row);
  const minutes = /href="(\/monetarypolicy\/fomcminutes(\d{8})\.htm)"/.exec(row);
  const released = /\(Released\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\)/.exec(stripTags(row));
  const lowerNote = (note ?? '').toLowerCase();
  const meeting_type: Meeting['meeting_type'] = lowerNote.includes('notation') ? 'notation_vote' : lowerNote.includes('unscheduled') ? 'unscheduled' : 'scheduled';
  return {
    year,
    month,
    days: dateText.replace(/\*/g, '').replace(/\([^)]*\)/g, '').trim(),
    start_date,
    end_date,
    meeting_type,
    ...(note ? { note } : {}),
    has_projections: dateText.includes('*') || /fomcprojtabl/.test(row),
    ...(statement ? { statement_date: isoFromCompact(statement[2]), statement_url: `${ORIGIN}${statement[1]}` } : {}),
    implementation_note_url: link(/href="(\/newsevents\/pressreleases\/monetary\d{8}a1\.htm)"/),
    press_conference_url: link(/href="(\/monetarypolicy\/fomcpres?s?conf\d{8}\.htm)"/),
    projections_url: link(/href="(\/monetarypolicy\/fomcprojtabl\d{8}\.htm)"/),
    longer_run_goals_url: link(/href="(\/newsevents\/pressreleases\/monetary\d{8}b\.htm)"/),
    ...(minutes ? { minutes_date: isoFromCompact(minutes[2]), minutes_url: `${ORIGIN}${minutes[1]}` } : {}),
    ...(released ? { minutes_released: isoFromLongDate(released[1]) } : {}),
  };
}

async function fomcCalendar(args: Record<string, unknown>) {
  const all = await loadCalendar();
  const years = [...new Set(all.map((m) => m.year))].sort();
  const today = todayIso();
  const year = args.year === undefined || args.year === null || args.year === '' ? Number(today.slice(0, 4)) : Math.trunc(Number(args.year));
  if (!Number.isFinite(year)) throw new Error('"year" must be an integer like 2026.');
  const meetings = all.filter((m) => m.year === year);
  const next = all.find((m) => m.end_date >= today && m.meeting_type === 'scheduled');
  const last = [...all].reverse().find((m) => m.end_date < today && m.meeting_type === 'scheduled');
  if (meetings.length === 0) {
    return {
      found: false,
      reason: 'year_not_on_calendar',
      hint: `The Fed calendar page lists ${years[0]}–${years[years.length - 1]}. Older meetings are in the historical FOMC materials archive.`,
      years_available: years,
      next_meeting: next ? { ...next, days_until: daysBetween(today, next.start_date) } : null,
    };
  }
  return {
    year,
    as_of: today,
    count: meetings.length,
    scheduled_count: meetings.filter((m) => m.meeting_type === 'scheduled').length,
    meetings,
    next_meeting: next ? { ...next, days_until: daysBetween(today, next.start_date) } : null,
    last_meeting: last ? { ...last, days_since: daysBetween(last.end_date, today) } : null,
    years_available: years,
    source: CALENDAR_URL,
  };
}

// ── FOMC statement + redline ────────────────────────────────────────

interface Statement {
  date: string;
  url: string;
  title: string;
  meeting?: Meeting;
  paragraphs: string[];
  body_paragraphs: string[]; // policy prose only — no tally, roll-call, media or note lines
  vote: { for?: number; against?: number; unanimous?: boolean; dissenters: string[]; dissent_detail?: string; voting_for?: string[] } | null;
  rate_decision: ReturnType<typeof parseRateDecision>;
  implementation_note_url?: string;
}

function pickStatementMeeting(all: Meeting[], want: string | undefined, today: string): { meeting?: Meeting; candidates: Meeting[] } {
  const candidates = all.filter((m) => m.statement_url && m.statement_date! <= today && m.meeting_type !== 'notation_vote');
  if (!want) return { meeting: candidates[candidates.length - 1], candidates };
  const compact = (iso: string) => iso.replace(/-/g, '');
  const exact = all.find((m) => m.statement_url && compact(m.statement_date!).startsWith(want));
  if (exact) return { meeting: exact, candidates };
  // A caller may pass the meeting's first day or its month rather than the release date.
  const byMeeting = all.find((m) => m.statement_url && (compact(m.start_date).startsWith(want) || compact(m.end_date).startsWith(want)));
  return { meeting: byMeeting, candidates };
}

async function loadStatement(meeting: Meeting): Promise<Statement> {
  const page = await fetchDatedPage(meeting.statement_url!);
  if (!page) throw new Error(`federalreserve.gov: statement page ${meeting.statement_url} returned 404.`);
  const art = articleHtml(page);
  const meta = metaOf(art);
  const paras = blocks(art).filter((b) => b.tag === 'p').map((b) => b.text.replace(/\n/g, ' ').trim()).filter(Boolean);
  const isHousekeeping = (p: string) =>
    /^For media inquiries/i.test(p) || /^Implementation Note issued/i.test(p) || /^Last Update/i.test(p) || /^For release at/i.test(p);
  const isRollCall = (p: string) => /^Voting (for|against)/i.test(p) || /approved the following statement for release by a/i.test(p);
  const content = paras.filter((p) => !isHousekeeping(p));
  const body = content.filter((p) => !isRollCall(p));
  return {
    date: meeting.statement_date!,
    url: meeting.statement_url!,
    title: meta.title,
    meeting,
    paragraphs: content,
    body_paragraphs: body,
    vote: parseVote(content),
    rate_decision: parseRateDecision(body),
    implementation_note_url: meeting.implementation_note_url,
  };
}

/**
 * Names out of a roll-call clause. Two shapes occur:
 *   "Beth M. Hammack, Neel Kashkari, and Lorie K. Logan"          (comma list)
 *   "Jerome H. Powell, Chair; Philip N. Jefferson, Vice Chair; …"  (name, title; …)
 */
function splitNames(clause: string): string[] {
  const c = clause.trim().replace(/\.$/, '');
  if (c.includes(';')) {
    return c
      .split(/;\s*/)
      .map((part) => part.replace(/^and\s+/i, '').split(',')[0].trim())
      .filter(Boolean);
  }
  return c
    .replace(/,?\s+and\s+/g, ', ')
    .split(/,\s*/)
    .map((n) => n.trim())
    .filter((n) => n && !/^who\b/i.test(n));
}

/** The names clause of "Voting for/against … were <names>[, who …]." */
function rollCallClause(paragraph: string): string | undefined {
  const m = /^Voting (?:for|against) (?:the monetary policy action|this action) (?:were|was)\s+([\s\S]*)$/i.exec(paragraph.trim());
  if (!m) return undefined;
  const rest = m[1];
  const who = rest.search(/,\s+who\b/i);
  return (who >= 0 ? rest.slice(0, who) : rest).replace(/\.$/, '').trim();
}

function parseVote(paras: string[]): Statement['vote'] {
  const tally = paras.map((p) => /by a\s+(\d+)\s*[–—-]\s*(\d+)\s+vote/i.exec(p)).find(Boolean);
  // Pre-2026 statements put "Voting for … . Voting against … ." in ONE paragraph.
  const rollCalls = paras.filter((p) => /^Voting (for|against)/i.test(p)).flatMap((p) => p.split(/(?<=\.)\s+(?=Voting (?:for|against)\b)/i));
  const against = rollCalls.find((p) => /^Voting against/i.test(p));
  const forP = rollCalls.find((p) => /^Voting for/i.test(p));
  if (!tally && !against && !forP) return null;
  const vote: NonNullable<Statement['vote']> = { dissenters: [] };
  if (tally) {
    vote.for = Number(tally[1]);
    vote.against = Number(tally[2]);
  }
  if (forP) {
    const names = rollCallClause(forP);
    if (names) vote.voting_for = splitNames(names);
    if (vote.for === undefined && vote.voting_for) vote.for = vote.voting_for.length;
  }
  if (against) {
    // "were A, who preferred X; and B and C, who preferred Y." — one clause per
    // preference, so take the names ahead of every ", who".
    const m = /^Voting against (?:the monetary policy action|this action) (?:were|was)\s+([\s\S]*)$/i.exec(against.trim());
    const clauses = (m?.[1] ?? '').split(/;\s*(?:and\s+)?/);
    vote.dissenters = clauses.flatMap((cl) => {
      const who = cl.search(/,\s+who\b/i);
      const names = (who >= 0 ? cl.slice(0, who) : cl).replace(/\.$/, '').trim();
      return names ? splitNames(names) : [];
    });
    vote.dissent_detail = against;
    if (vote.against === undefined) vote.against = vote.dissenters.length;
  } else if (vote.against === undefined && forP) {
    vote.against = 0;
  }
  vote.unanimous = vote.against === 0;
  return vote;
}

function fracToNumber(s: string): number | undefined {
  // "3-1/2" → 3.5 ; "4-1/4" → 4.25 ; "5" → 5 ; "0" → 0 ; "1/4" → 0.25
  const m = /^(\d+)?(?:-|\s)?(?:(\d+)\/(\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  const whole = m[1] ? Number(m[1]) : 0;
  const frac = m[2] && m[3] ? Number(m[2]) / Number(m[3]) : 0;
  return whole + frac;
}

function parseRateDecision(body: string[]) {
  const sentence = body.flatMap(splitSentences).find((s) => /target range for the federal funds rate/i.test(s));
  if (!sentence) return null;
  // "at 3-1/2 to 3-3/4 percent" (hold) or "… by 1/4 percentage point to 4 to 4-1/4 percent" (move)
  const range = /\b(?:at|to)\s+(\d[\d\-\/]*)\s+to\s+(\d[\d\-\/]*)\s+percent/i.exec(sentence);
  const action = /\b(maintain|keep|leave)\b/i.test(sentence) ? 'hold' : /\b(lower|reduce|cut)\b/i.test(sentence) ? 'cut' : /\b(raise|increase)\b/i.test(sentence) ? 'hike' : 'unknown';
  const bp = /by\s+([\d\/ -]+?)\s+percentage point/i.exec(sentence);
  const change = bp ? fracToNumber(bp[1]) : undefined;
  return {
    sentence,
    action,
    target_range_low_pct: range ? fracToNumber(range[1]) : undefined,
    target_range_high_pct: range ? fracToNumber(range[2]) : undefined,
    target_range_text: range ? `${range[1].trim()} to ${range[2].trim()} percent` : undefined,
    change_bp: change !== undefined ? Math.round(change * 100) * (action === 'cut' ? -1 : 1) : action === 'hold' ? 0 : undefined,
  };
}

function splitSentences(p: string): string[] {
  // Protect the abbreviations that appear in Fed prose before splitting on
  // terminal punctuation followed by a capital / quote / paren.
  const protectedText = p.replace(/\b(U\.S|Mr|Ms|Dr|Inc|Vol|No|St|vs|e\.g|i\.e)\./g, (m) => m.replace(/\./g, ''));
  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z“"(])/)
    .map((s) => s.replace(//g, '.').trim())
    .filter((s) => s.length > 0);
}

function normSentence(s: string): string {
  return s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function bigrams(s: string): Set<string> {
  const w = normSentence(s).split(' ').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < w.length - 1; i++) out.add(`${w[i]} ${w[i + 1]}`);
  if (w.length === 1) out.add(w[0]);
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return (2 * inter) / (a.size + b.size);
}

function wordDiff(from: string, to: string): { removed_words: string[]; added_words: string[] } {
  // Longest-common-subsequence over tokens gives the words that actually moved,
  // which is what a reader wants highlighted ("solid" → "moderate").
  const a = from.split(/\s+/);
  const b = to.split(/\s+/);
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { removed_words: removed, added_words: added };
}

function diffStatements(prior: Statement, current: Statement) {
  const before = prior.body_paragraphs.flatMap(splitSentences);
  const after = current.body_paragraphs.flatMap(splitSentences);
  const beforeNorm = before.map(normSentence);
  const afterNorm = after.map(normSentence);
  const afterSet = new Set(afterNorm);
  const beforeSet = new Set(beforeNorm);
  const removedIdx = before.map((_, i) => i).filter((i) => !afterSet.has(beforeNorm[i]));
  const addedIdx = after.map((_, i) => i).filter((i) => !beforeSet.has(afterNorm[i]));
  const unchanged = before.length - removedIdx.length;
  const changed: { from: string; to: string; similarity: number; removed_words: string[]; added_words: string[] }[] = [];
  const usedAdded = new Set<number>();
  const addedGrams = new Map<number, Set<string>>(addedIdx.map((i) => [i, bigrams(after[i])]));
  const removed: string[] = [];
  for (const ri of removedIdx) {
    const rg = bigrams(before[ri]);
    let best = -1;
    let bestScore = 0;
    for (const ai of addedIdx) {
      if (usedAdded.has(ai)) continue;
      const score = dice(rg, addedGrams.get(ai)!);
      if (score > bestScore) { bestScore = score; best = ai; }
    }
    if (best >= 0 && bestScore >= 0.35) {
      usedAdded.add(best);
      changed.push({ from: before[ri], to: after[best], similarity: Math.round(bestScore * 100) / 100, ...wordDiff(before[ri], after[best]) });
    } else {
      removed.push(before[ri]);
    }
  }
  const added = addedIdx.filter((i) => !usedAdded.has(i)).map((i) => after[i]);
  return {
    prior_date: prior.date,
    prior_url: prior.url,
    method: 'sentence-level diff of the policy paragraphs; the vote tally, roll-call/dissent paragraph, release date and media line are excluded',
    sentences_before: before.length,
    sentences_after: after.length,
    unchanged_count: unchanged,
    changed,
    added,
    removed,
    identical: changed.length === 0 && added.length === 0 && removed.length === 0,
    vote_changed: JSON.stringify(prior.vote) !== JSON.stringify(current.vote),
    rate_decision_prior: prior.rate_decision ? { action: prior.rate_decision.action, target_range_text: prior.rate_decision.target_range_text } : null,
  };
}

async function fomcStatement(args: Record<string, unknown>) {
  const all = await loadCalendar();
  const today = todayIso();
  const want = normalizeDateArg(args.date);
  const { meeting, candidates } = pickStatementMeeting(all, want, today);
  const available = candidates.map((m) => m.statement_date!);
  if (!meeting) {
    return {
      found: false,
      reason: want ? 'no_statement_for_date' : 'no_statement_released',
      hint: 'Pass one of the released statement dates in `available`, as YYYY-MM-DD or YYYY-MM.',
      available: available.slice(-12),
    };
  }
  if (meeting.statement_date! > today) {
    return { found: false, reason: 'statement_not_yet_released', hint: `The ${meeting.statement_date} statement is scheduled but not published yet; latest released is ${available[available.length - 1]}.`, available: available.slice(-12) };
  }
  const current = await loadStatement(meeting);
  const compareWant = normalizeDateArg(args.compare_to);
  let prior: Meeting | undefined;
  if (compareWant) {
    prior = pickStatementMeeting(all, compareWant, today).meeting;
    if (!prior) throw new Error(`No statement found for compare_to "${args.compare_to}". Released statements: ${available.slice(-12).join(', ')}.`);
  } else {
    const idx = candidates.findIndex((m) => m.statement_url === meeting.statement_url);
    prior = idx > 0 ? candidates[idx - 1] : idx < 0 ? [...candidates].reverse().find((m) => m.statement_date! < meeting.statement_date!) : undefined;
  }
  const priorStmt = prior ? await loadStatement(prior) : null;
  const includeText = args.include_text !== false;
  const { meeting: mtg, ...rest } = current;
  return {
    date: current.date,
    url: current.url,
    title: current.title,
    meeting: mtg
      ? { start_date: mtg.start_date, end_date: mtg.end_date, meeting_type: mtg.meeting_type, has_projections: mtg.has_projections, press_conference_url: mtg.press_conference_url, projections_url: mtg.projections_url, minutes_url: mtg.minutes_url, minutes_released: mtg.minutes_released }
      : undefined,
    rate_decision: rest.rate_decision,
    vote: rest.vote,
    implementation_note_url: rest.implementation_note_url,
    ...(includeText ? { text: current.paragraphs.join('\n\n'), paragraphs: current.paragraphs } : {}),
    diff_vs_prior: priorStmt ? diffStatements(priorStmt, current) : null,
    is_latest: candidates[candidates.length - 1]?.statement_url === meeting.statement_url,
    available_statements: available.slice(-12),
    source: 'Board of Governors of the Federal Reserve System — FOMC press releases',
  };
}

// ── FOMC minutes ────────────────────────────────────────────────────

async function fomcMinutes(args: Record<string, unknown>) {
  const all = await loadCalendar();
  const today = todayIso();
  const want = normalizeDateArg(args.date);
  const released = all.filter((m) => m.minutes_url && (!m.minutes_released || m.minutes_released <= today));
  const compact = (iso: string) => iso.replace(/-/g, '');
  let meeting: Meeting | undefined;
  if (want) {
    meeting = all.find((m) => m.minutes_url && (compact(m.minutes_date!).startsWith(want) || compact(m.start_date).startsWith(want) || compact(m.end_date).startsWith(want)));
    if (!meeting) {
      const pending = all.find((m) => !m.minutes_url && m.statement_url && (compact(m.start_date).startsWith(want) || compact(m.end_date).startsWith(want)));
      return {
        found: false,
        reason: pending ? 'minutes_not_yet_released' : 'no_minutes_for_date',
        hint: pending
          ? `Minutes for the ${pending.start_date} meeting are released about three weeks after the meeting; latest available is ${released[released.length - 1]?.minutes_date}.`
          : 'Pass one of the dates in `available` as YYYY-MM-DD or YYYY-MM.',
        available: released.map((m) => m.minutes_date).slice(-12),
      };
    }
  } else {
    meeting = released[released.length - 1];
  }
  if (!meeting) return { found: false, reason: 'no_minutes_released', hint: 'The calendar page lists no released minutes.', available: [] };
  const page = await fetchDatedPage(meeting.minutes_url!);
  if (!page) return { found: false, reason: 'minutes_not_yet_released', hint: `Minutes URL ${meeting.minutes_url} is listed but returns 404 — the release is scheduled for ${meeting.minutes_released ?? 'a later date'}.` };
  const art = articleHtml(page);
  const meta = metaOf(art);
  const sections: { heading: string; paragraphs: string[] }[] = [];
  let cur: { heading: string; paragraphs: string[] } | null = null;
  for (const b of blocks(art)) {
    if (b.tag === 'h3') continue;
    if (b.tag === 'h4' || b.tag === 'h5' || b.strongLead) {
      const heading = (b.strongLead ?? b.text).trim();
      // The closing signature ("<strong>Joshua Gallin</strong><br />Secretary")
      // has the section shape but no section; keep it with Attendance.
      if (b.strongLead && cur && b.text.length - b.strongLead.length < 40) {
        cur.paragraphs.push(b.text.replace(/\n/g, ' '));
        continue;
      }
      cur = { heading, paragraphs: [] };
      sections.push(cur);
      if (b.strongLead) {
        const body = b.text.slice(b.strongLead.length).replace(/^\s*\n?/, '').trim();
        if (body) cur.paragraphs.push(body.replace(/\n/g, ' '));
      }
      continue;
    }
    if (!cur) {
      cur = { heading: 'Preamble', paragraphs: [] };
      sections.push(cur);
    }
    cur.paragraphs.push(b.text.replace(/\n/g, ' '));
  }
  const headings = sections.map((s) => s.heading);
  const sectionWant = typeof args.section === 'string' ? args.section.trim().toLowerCase() : '';
  const picked = sectionWant ? sections.filter((s) => s.heading.toLowerCase().includes(sectionWant)) : sections;
  if (sectionWant && picked.length === 0) {
    return { found: false, reason: 'section_not_found', hint: `No section heading contains "${args.section}". Headings: ${headings.join(' | ')}`, meeting_date: meeting.minutes_date, sections: headings };
  }
  const text = picked.map((s) => `${s.heading}\n${s.paragraphs.join('\n\n')}`).join('\n\n');
  return {
    meeting_date: meeting.minutes_date,
    meeting_start: meeting.start_date,
    meeting_end: meeting.end_date,
    released: meeting.minutes_released ?? meta.date ?? null,
    url: meeting.minutes_url,
    pdf_url: meeting.minutes_url!.replace('/monetarypolicy/fomcminutes', '/monetarypolicy/files/fomcminutes').replace(/\.htm$/, '.pdf'),
    title: meta.title,
    sections: headings,
    ...(sectionWant ? { section_filter: args.section, matched_sections: picked.map((s) => s.heading) } : {}),
    text,
    chars: text.length,
    is_latest: released[released.length - 1]?.minutes_url === meeting.minutes_url,
    available: released.map((m) => m.minutes_date).slice(-12),
    source: 'Board of Governors of the Federal Reserve System — FOMC minutes',
  };
}

// ── Speeches + testimony ────────────────────────────────────────────

interface FeedItem { title: string; link: string; description: string; category: string; pubDate: string; published: string }

function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  const field = (block: string, tag: string) => {
    const x = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? '';
    return decodeEntities(x.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
  };
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const pubDate = field(block, 'pubDate');
    const parsed = Date.parse(pubDate);
    // The testimony feed has carried an 1899 pubDate on an item; treat anything
    // before the Board's web era as undated rather than as the window's floor.
    const t = Number.isFinite(parsed) && parsed > Date.UTC(1995, 0, 1) ? parsed : NaN;
    items.push({
      title: field(block, 'title'),
      link: field(block, 'link'),
      description: field(block, 'description'),
      category: field(block, 'category'),
      pubDate,
      published: Number.isFinite(t) ? new Date(t).toISOString() : pubDate,
    });
  }
  return items;
}

async function fedSpeeches(args: Record<string, unknown>) {
  const days = intArg(args, 'days', 14, 1, 3650);
  const limit = intArg(args, 'limit', 10, 1, 25);
  const includeTestimony = args.include_testimony !== false;
  const speakerWant = typeof args.speaker === 'string' ? args.speaker.trim().toLowerCase() : '';
  const feeds = [SPEECHES_FEED, ...(includeTestimony ? [TESTIMONY_FEED] : [])];
  const xmls = await Promise.all(feeds.map((u) => fetchText(u, 'application/rss+xml, application/xml, text/xml')));
  const all = xmls.flatMap((x) => (x ? parseFeed(x) : []));
  const dated = all.filter((i) => /^\d{4}-\d{2}-\d{2}T/.test(i.published));
  const oldest = dated.map((i) => i.published).sort()[0];
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const matched = dated
    .filter((i) => i.published >= since)
    .filter((i) => !speakerWant || i.title.toLowerCase().startsWith(speakerWant) || i.title.toLowerCase().includes(speakerWant))
    .sort((a, b) => b.published.localeCompare(a.published));
  const picked = matched.slice(0, limit);
  const enriched = await Promise.all(
    picked.map(async (i) => {
      const surname = i.title.split(',')[0]?.trim();
      const base = {
        title: i.title.includes(',') ? i.title.slice(i.title.indexOf(',') + 1).trim() : i.title,
        speaker_surname: surname,
        date: i.published.slice(0, 10),
        published: i.published,
        type: i.category || (i.link.includes('/testimony/') ? 'Testimony' : 'Speech'),
        venue: i.description.replace(/^(Speech|Testimony)\s+/i, ''),
        url: i.link,
      };
      try {
        const page = await fetchDatedPage(i.link);
        if (!page) return { ...base, first_paragraph: null };
        const art = articleHtml(page);
        const meta = metaOf(art);
        const firstPara = blocks(art).find((b) => b.tag === 'p' && b.text.length > 80 && !/^(Watch live|Accessible Keys|Thank you\.?$)/i.test(b.text))?.text.replace(/\n/g, ' ');
        return { ...base, speaker: meta.speaker ?? surname, ...(meta.location ? { venue: meta.location } : {}), first_paragraph: firstPara ?? null };
      } catch (e) {
        return { ...base, first_paragraph: null, page_error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  return {
    days,
    since: since.slice(0, 10),
    feed_window: { oldest_item: oldest?.slice(0, 10) ?? null, items_in_feeds: all.length, note: 'The Board feeds hold only the latest ~20 speeches and ~20 testimonies; a `days` window older than oldest_item is truncated.' },
    ...(speakerWant ? { speaker_filter: args.speaker } : {}),
    total_matching: matched.length,
    count: enriched.length,
    items: enriched,
    source: feeds,
  };
}

// ── Beige Book ──────────────────────────────────────────────────────

function resolveDistrict(v: unknown): (typeof DISTRICTS)[number] | 'summary' | null {
  if (v === undefined || v === null || v === '') return 'summary';
  const s = String(v).trim().toLowerCase().replace(/^federal reserve bank of\s+/, '').replace(/\s+district$/, '');
  if (['national', 'summary', 'national summary', 'all', 'overall', 'us', 'u.s.'].includes(s)) return 'summary';
  const n = Number(s);
  if (Number.isInteger(n)) return DISTRICTS.find((d) => d.n === n) ?? null;
  const norm = s.replace(/[.\s]+/g, ' ').trim();
  return (
    DISTRICTS.find((d) => d.name.toLowerCase() === norm || d.slug === norm.replace(/ /g, '-')) ??
    DISTRICTS.find((d) => d.aliases.includes(norm)) ??
    DISTRICTS.find((d) => d.name.toLowerCase().includes(norm) || norm.includes(d.name.toLowerCase())) ??
    null
  );
}

async function latestBeigeEditions(): Promise<string[]> {
  const page = await fetchText(BEIGE_INDEX_URL);
  const found = new Set<string>();
  for (const m of (page ?? '').matchAll(/beigebook(\d{6})(?:-summary)?\.htm/g)) found.add(m[1]);
  return [...found].sort();
}

async function beigeBook(args: Record<string, unknown>) {
  const district = resolveDistrict(args.district);
  if (!district) {
    return { found: false, reason: 'unknown_district', hint: 'Pass a district name, city, or number 1–12.', districts: DISTRICTS.map((d) => `${d.n}: ${d.name}`) };
  }
  const editions = await latestBeigeEditions();
  let edition: string | undefined;
  const wantRaw = args.edition === undefined || args.edition === null || args.edition === '' ? undefined : String(args.edition).trim().toLowerCase();
  if (!wantRaw || wantRaw === 'latest') {
    edition = editions[editions.length - 1];
  } else {
    const digits = wantRaw.replace(/[^0-9]/g, '');
    if (digits.length !== 6) throw new Error(`edition "${args.edition}" not understood — pass YYYY-MM, e.g. "2026-07".`);
    edition = digits;
  }
  if (!edition) throw new Error('federalreserve.gov: could not find any Beige Book edition on the publications index.');
  const slug = district === 'summary' ? 'summary' : district.slug;
  const url = `${ORIGIN}/monetarypolicy/beigebook${edition}-${slug}.htm`;
  const page = await fetchDatedPage(url);
  if (!page) {
    return {
      found: false,
      reason: 'edition_not_found',
      hint: `No Beige Book page at ${url}. Editions on the Fed index: ${editions.slice(-8).map((e) => `${e.slice(0, 4)}-${e.slice(4)}`).join(', ')}. Pre-2017 editions use a different page layout and are not read by this tool.`,
      editions_available: editions.slice(-16).map((e) => `${e.slice(0, 4)}-${e.slice(4)}`),
    };
  }
  const art = articleHtml(page);
  const meta = metaOf(art);
  const sections: { heading: string; text: string }[] = [];
  let cur: { heading: string; text: string } | null = null;
  for (const b of blocks(art)) {
    if (b.tag === 'h3') continue;
    if (b.tag === 'h4' || b.tag === 'h5') {
      cur = { heading: b.text, text: '' };
      sections.push(cur);
      continue;
    }
    if (!cur) { cur = { heading: 'Introduction', text: '' }; sections.push(cur); }
    cur.text += (cur.text ? '\n\n' : '') + b.text.replace(/\n/g, ' ');
  }
  const text = sections.map((s) => `${s.heading}\n${s.text}`).join('\n\n');
  return {
    edition: `${edition.slice(0, 4)}-${edition.slice(4)}`,
    is_latest: edition === editions[editions.length - 1],
    scope: district === 'summary' ? 'national_summary' : 'district',
    ...(district !== 'summary' ? { district: district.name, district_number: district.n } : {}),
    title: meta.title,
    url,
    pdf_url: `${ORIGIN}/monetarypolicy/files/BeigeBook_${edition}.pdf`,
    sections: sections.map((s) => s.heading),
    content: sections,
    text,
    chars: text.length,
    district_urls: Object.fromEntries(DISTRICTS.map((d) => [d.name, `${ORIGIN}/monetarypolicy/beigebook${edition}-${d.slug}.htm`])),
    editions_available: editions.slice(-16).map((e) => `${e.slice(0, 4)}-${e.slice(4)}`),
    source: 'Board of Governors of the Federal Reserve System — Beige Book',
  };
}

// ── Dispatch ────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'fomc_calendar':
      return fomcCalendar(args);
    case 'fomc_statement':
      return fomcStatement(args);
    case 'fomc_minutes':
      return fomcMinutes(args);
    case 'fed_speeches':
      return fedSpeeches(args);
    case 'beige_book':
      return beigeBook(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
