# Proto

**Continuous subcontractor licence verification for construction projects.**

Verified in January. Still valid in September?

---

## The problem

A general contractor runs twenty to forty subcontractors on a project, each working
under a qualifying agent's state licence. Most firms verify those licences **once**,
at onboarding, file the certificates, and move on. That leaves the contractor exposed
for the rest of the project.

A licence can go delinquent in month seven of a fourteen-month job. Nobody is
notified. The subcontractor keeps working and keeps getting paid.

When it surfaces, the exposure lands on the general contractor: contracts with an
unlicensed contractor are void and unenforceable, liens cannot be filed, general
liability cover may be voided for work performed in violation of licensing law, and
under OSHA's multi-employer policy the GC is the controlling employer.

A calendar reminder knows one date somebody typed in. **Proto reads the registry of
record.**

## What it does

Proto re-verifies an entire project roster against the live Florida DBPR registry,
cross-references county permit activity, ranks by what is genuinely dangerous, and
drafts the notice.

The ranking is the point. Real output, live data, nothing seeded:

```
■ CRITICAL  3JW CONSTRUCTION, INC.
   CCC1332414 · Certified Roofing Contractor
   → Licence status is SUSPENDED (registry reads "Suspended, Active").
   → 1 permit pulled under this licence this year, most recently 2026-02-26.
   → Work is in progress on a licence that cannot lawfully support it.
   action: Stop work and withhold the next draw until the licence is reinstated.

· ok  24 HR AIR SERVICE INC
   CAC1814637 · Certified Air Conditioning Contractor
   → 5 permits on record, the last 8 months ago (2025-12-22), work from that job
     may still be open. Licence is in good standing, so this is context, not exposure.

4 of 16 need attention.
```

Both subcontractors have open work. Only one is a finding. A date-based reminder
cannot tell them apart.

## Architecture

```mermaid
flowchart LR
    R[roster<br/>the subcontractors] --> V

    subgraph agent [Agent, decides depth]
        V[verify<br/>how far to dig, per subcontractor]
        V --> T1[lookup_license]
        V --> T2[get_permit_activity]
        V --> T3[check_scope]
    end

    T1 --> E
    T2 --> E
    T3 --> E

    subgraph engine [Engine, deterministic, no model]
        E[exposure scoring<br/>pure functions, 20 tests]
        E --> J[(journal and history)]
    end

    J --> G

    subgraph graph [Strands graph]
        G[triage<br/>what to act on first] --> N[notice<br/>drafts the letter]
    end

    N --> O[briefing and notice]
```

**The split is deliberate, and it runs in one direction.** The agent decides which
sources to consult for a given subcontractor: a licence current for another two years
needs nothing further, a suspended one needs its permit history, because open work
under a dead licence is the finding that matters. That judgement saves real requests
against a public government service.

What the agent may not do is decide what any of it means. The tools write what they
found into a facts record, the deterministic engine scores that record, and the graph
at the end only orders the morning and drafts the letter. A model that misreported a
status could not change what Proto reports, only waste a call.

If the model is unavailable the sweep still runs. It falls back to reading every
source about everyone, which is wasteful and correct, in that order.

Every reason Proto gives is recomputed from the record in front of it, so an
explanation cannot drift from its evidence. A language model narrating its own
reasoning about liability is the failure mode this project exists to avoid.

## Resumability

A sweep is a long sequence of calls against two public services. If it dies at
subcontractor nine, restarting from one means thirty more requests at a government
portal to re-learn what was already known, and on a large roster that is why the
check quietly stops being run at all.

Each subcontractor is committed to a run journal the moment it is verified, written
to a temporary file and renamed so a kill mid-write leaves the previous good journal
intact. A resumed run skips what is settled and continues from the first unsettled
name.

```
$ npm run sweep
  CCC1332414  CRITICAL  2 calls
  CAC1816423  NONE      1 call
  ^C

$ npm run sweep
  CCC1332414  already verified
  CAC1816423  already verified
  CFC1429225  NONE      1 call
```

## Adding subcontractors

The people this is built for keep their roster in a spreadsheet, an email, or their
head, never in a JSON file. So there are three ways in, and all three resolve the
business name from the registry rather than trusting what was typed:

- **One at a time**, paste a licence number; Proto names it and catches a typo immediately
- **Paste a list**, a column straight out of a spreadsheet; any line containing a
  licence number works, headers are ignored
- **Google Sheet**, paste the link. Proto reads the published CSV, so there is no
  OAuth, no API key, and the contractor keeps editing the sheet they already use

## Control room

```bash
npm run serve      # http://localhost:8787
```

A live dashboard over the same sweep the CLI runs, not a reimplementation, the
same event stream. Subcontractors resolve one by one as the registry answers,
findings rank themselves by exposure, and **Kill mid-sweep** stops the run the way
a closed laptop would. Press *Run sweep* again and it continues from the journal
rather than starting over.

## Quick start

```bash
npm install
cp .env.example .env          # add a model provider key
npm test                      # the engine, the journal, the record
npm run serve                 # control room at http://localhost:8787
npm run sweep                 # headless, no browser needed
npm run brief                 # triage and notice over the last check
```

## Model providers

Proto is provider-agnostic; the agent logic never names a vendor.

| Provider | Set | Notes |
|---|---|---|
| Google AI Studio | `PROTO_MODEL_PROVIDER=google` | Free tier, reliable tool calling |
| OpenRouter | `PROTO_MODEL_PROVIDER=openrouter` | Use a tool-capable model |
| Groq | `PROTO_MODEL_PROVIDER=groq` | Free tier |
| Amazon Bedrock | `PROTO_MODEL_PROVIDER=bedrock` | Needs AWS credentials and model access |

Swapping providers is one environment variable. No code change.

## Built with Strands Agents

- `Agent` with a constrained system prompt per role
- `tool()` with Zod input schemas for registry lookups
- `addHook(BeforeToolCallEvent / AfterToolCallEvent)` for tool-level tracing
- `Graph` with typed edges for the triage → notice pipeline
- `BeforeNodeCallEvent` / `AfterNodeCallEvent` for node-level lifecycle
- Bounded execution via `maxSteps`, `timeout`, `nodeTimeout`

Node 22+. Connectors use built-ins only, no scraping or HTTP dependencies.

## Scope

Implemented: Florida DBPR, Miami-Dade permit activity, exposure scoring, resumable
sweep, triage and notice.

The registry and permit sources are each one module behind a small interface. Adding
a county or a second state is an entry in `COUNTY_SOURCES` and a connector, not a
redesign. Insurance certificates and workers' compensation exemptions are the natural
next source and are deliberately not implemented here.

## Data

Licence status and permit activity are matters of public record, published by the
Florida Department of Business and Professional Regulation and county permit
services. Proto queries them for their intended purpose: letting a contractor
confirm that the firms working under them are in good standing.

The sample roster names licensed businesses only. It is a worked example, not an
allegation about any firm's conduct.

## Disclosure

This project incorporates pre-existing Florida DBPR licence and county permit
connector modules authored by me, adapted for this application.

## The static pages

```bash
npm run build     # -> site/
```

The landing page, the deck and the icon sheet are static and can be served from
anywhere. The build bakes in the icon sprite the server normally injects at
request time. `vercel.json` is set up for this, so a Vercel deploy needs no
configuration beyond pointing it at the repository.

The control room is deliberately not part of that build. It needs a process that
stays alive for the watch, a writable disk for the record, and minutes rather
than seconds for a sweep. A serverless function provides none of the three, so
run it locally, or on a host that keeps a process.

## Running it somewhere else

`npm start` serves on `PORT`, or 8787 if unset, and reads configuration from the
environment rather than a file, so nothing needs to exist on disk to boot.

One thing to know before deploying: projects, rosters, schedules and sweep
history are written to `data/`, and the run journal to `.proto-state/`. On a host
with an ephemeral filesystem those are lost on every redeploy, which means the
watch starts again from nothing. Attach a volume, or treat a hosted instance as a
demonstration rather than a record.

## Licence

MIT
