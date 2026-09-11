# Proto, build plan

**Deadline:** Mon 14 Sep 2026, 5:00 PM PDT (= 1:00 AM Tue 15 Sep WAT)

## What Proto is

A general contractor hires ~30 subcontractors on a project. Each sub works under a
qualifier's state licence. Most firms verify those licences **once**, at onboarding,
and never again, which leaves them exposed for the rest of the project.

A licence can go delinquent in month seven of a fourteen-month job. Nobody is
notified. The sub keeps working, keeps pulling permits, keeps getting paid, on a
dead licence. When it surfaces, the exposure lands on the GC: unenforceable
contracts, void liens, voided GL cover, OSHA controlling-employer citations.

Proto re-verifies the whole roster against the live state registry, continuously,
and ranks what is actually dangerous.

**A reminder knows one date you typed in. Proto reads the registry of record.**

## Scope

In: Florida DBPR, one project roster (~30 subs), licence status + permit activity +
scope-match, exposure ranking, renewal/notice packet, crash-safe resume.

Out: second state registry, insurance/workers-comp, AgentCore deployment, auth,
database, multi-tenancy, web UI. A clean terminal control room beats a half-built
dashboard.

## Days

- **Day 0**, DONE. Accounts, repo, SDK, smoke gate passing.
- **Day 1**, DONE. Live DBPR + permit connectors, deterministic exposure engine
      (7 unit tests), 16-subcontractor roster sourced from the live registry.
- **Day 2**, DONE. Strands Graph (triage -> notice), run journal with atomic
      per-subcontractor commits. Killed at 5 of 16, resumed at 6, completed.
- **Day 3**, README and architecture diagram DONE. Remaining: public GitHub repo,
      5-minute video (budget 4 hours), Devpost form. Submit in the afternoon.

## Scoring notes

Judged equally on Technical Implementation, Design, Potential Impact, Creativity &
Originality, Presentation, plus "how thoroughly and skillfully does the project use
Strands Agents?"

So use the real primitives, not a thin wrapper: `tool()` with Zod schemas,
`addHook()` lifecycle hooks, structured output, `SessionManager`/`Snapshot` for
recovery, and a Graph for the parallel roster sweep.

Two things win this: the **ranking** (a delinquent qualifier carrying 9 open permits
outranks 12 cosmetic expiries, with the why-line computed from real permit counts),
and the **kill-and-resume** on camera at minute four.

## Non-negotiables

- Explanations are recomputed from record fields. The model never invents a reason.
- Licence maths is pure functions, unit-tested. No LLM in the arithmetic.
- The README must carry a disclosure line for pre-existing modules incorporated
  into the project, the rules require it.
