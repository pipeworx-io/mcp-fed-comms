# @pipeworx/fed-comms

Federal Reserve communications as structured data: the FOMC meeting calendar with
`next_meeting`, each post-meeting statement with the rate decision and vote parsed
and a sentence-level redline against the previous statement, meeting minutes split
into sections, Board speeches and testimony, and the Beige Book by district. Read
from the Board of Governors' public pages and RSS feeds on federalreserve.gov.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `fomc_calendar(year?)` — every meeting of a year (scheduled, notation votes,
  unscheduled) with start/end dates, whether it has a Summary of Economic
  Projections, statement / implementation-note / press-conference / minutes
  URLs and the minutes release date, plus `next_meeting` with `days_until` and
  `last_meeting` with `days_since`. Answers "when is the next FOMC meeting".
- `fomc_statement(date?, compare_to?, include_text?)` — the statement text,
  `rate_decision` (sentence, hold/cut/hike, target range as numbers, change in
  bp), `vote` (tally, named dissenters and what they preferred), the
  implementation-note URL, and `diff_vs_prior`: sentences `changed` (with the
  words removed/added), `added`, `removed`, computed against the previous
  statement with the vote tally, roll-call, date and media lines excluded.
  Answers "what changed in the latest Fed statement".
- `fomc_minutes(date?, section?)` — the minutes with section headings
  (Developments in Financial Markets, Staff Review…, Participants' Views,
  Committee Policy Actions, Attendance); `section` is a case-insensitive
  substring filter. Answers "what did the minutes say about inflation".
- `fed_speeches(days?, speaker?, include_testimony?, limit?)` — speeches and
  congressional testimony with speaker + official title, venue, URL and the
  opening paragraph. Answers "latest speech by Waller".
- `beige_book(edition?, district?)` — the national summary or one district's
  report, split into sections (Labor Markets, Prices, and the district's
  industry sections). District accepts a city name, "Kansas City", "St. Louis",
  or the district number 1–12. Answers "what does the Beige Book say about
  Dallas".

## Auth

Keyless.

## Data sources

- <https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm> — meeting
  rows (`div.fomc-meeting`) with statement, implementation-note, press-conference,
  projections and minutes links. The page carries ~6 past years plus next year;
  older meetings are only in the historical-materials archive and return
  `found:false, reason:year_not_on_calendar`.
- <https://www.federalreserve.gov/newsevents/pressreleases/monetary{YYYYMMDD}a.htm>
  — statement; `a1` is the implementation note; `b` (January) is the Statement
  on Longer-Run Goals. The "notation vote" row (e.g. 2025-08-22) links a
  non-policy statement and is excluded from "latest" and from the diff baseline.
- <https://www.federalreserve.gov/monetarypolicy/fomcminutes{YYYYMMDD}.htm> —
  minutes, released ~3 weeks after the meeting. Sections are
  `<p><strong>Heading</strong><br />…`, not `<h4>`.
- <https://www.federalreserve.gov/monetarypolicy/beigebook{YYYYMM}-{district}.htm>
  — `-summary` is the national summary; the bare `beigebook{YYYYMM}.htm` page is
  only the "About this publication" boilerplate. Editions are discovered from
  <https://www.federalreserve.gov/monetarypolicy/publications/beige-book-default.htm>
  (the `/monetarypolicy/beige-book-default.htm` URL 302s there). Pre-2017 editions
  use a different layout and are not parsed.
- <https://www.federalreserve.gov/feeds/speeches.xml> and
  <https://www.federalreserve.gov/feeds/testimony.xml> — ~20 items each, so
  `days` beyond `feed_window.oldest_item` is truncated. The testimony feed has
  carried `Sat, 30 Dec 1899` pubDates on a few items; those are treated as
  undated and dropped.

Gotchas the parser already handles: statements write ranges with a non-breaking
hyphen (`3‑3/4`); the vote tally sits in the first paragraph ("by a 9 – 3 vote")
since 2026, while older statements list every voter in "Voting for … were
Jerome H. Powell, Chair; …" form; the calendar marks SEP meetings with `*` on the
date and puts cross-month meetings under a "April/May" month label.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fed-comms": {
      "url": "https://gateway.pipeworx.io/fed-comms/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fed-comms/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/fomc_calendar \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/fomc_calendar`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fed-comms": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fed-comms"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fed-comms
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fed Comms data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
