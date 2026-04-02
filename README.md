# OpenDiligence

OpenDiligence is a prototype due diligence report generator inspired by the Xapien workflow. This version focuses on a strong demo loop:

- structured intake form
- staged report generation with progress polling
- executive summary and risk overview
- source-linked findings for corporate, sanctions, media, and associations
- live enrichment from ICIJ Offshore Leaks, GLEIF LEI data, and the FCA Warning List
- SQLite-backed local persistence for jobs and finished reports
- optional API protection and rate limiting for local/demo deployments

## Getting started

```bash
npm install
npm run dev
```

Prompt regression checks are available separately:

```bash
npm run test:prompts
```

Live prompt evals are also available when `OPENAI_API_KEY` is configured:

```bash
npm run evals
npm run evals -- --suite=request_extraction
```

Open `http://localhost:3000`.

To enable the first live integration, copy `.env.example` to `.env.local` and add your Companies House API key:

```bash
COMPANIES_HOUSE_API_KEY=your_key_here
OPENSANCTIONS_API_KEY=your_key_here
BRAVE_SEARCH_API_KEY=your_key_here
OPENAI_API_KEY=your_key_here
APP_ACCESS_KEY=optional_demo_password
```

## Current architecture

- `src/app/page.tsx`: single-page workflow for report submission, progress, and output
- `src/app/api/reports/route.ts`: creates report jobs
- `src/app/api/reports/[id]/route.ts`: polls job status and returns the finished report
- `src/app/api/agent/route.ts`: natural-language agent entrypoint for starting runs and asking follow-up questions
- `src/lib/report-store.ts`: orchestration, fallbacks, and synthesis wiring
- `src/lib/agent.ts`: agent-facing intent parsing and grounded follow-up answers
- `src/lib/types.ts`: report and API typings
- `src/lib/providers/companies-house.ts`: live Companies House lookup and mapping
- `src/lib/providers/opensanctions.ts`: live sanctions and PEP screening
- `src/lib/providers/brave-search.ts`: live web/PDF search extraction for media findings
- `src/lib/providers/media-verification.ts`: source-text verification and person-level media filtering
- `src/lib/providers/icij-offshore-leaks.ts`: public ICIJ Offshore Leaks reconciliation matches
- `src/lib/providers/gleif.ts`: public GLEIF LEI and parent relationship enrichment
- `src/lib/providers/fca-warning-list.ts`: public FCA warning-list search and warning extraction
- `src/lib/report-persistence.ts`: SQLite-backed job persistence
- `src/lib/api-guard.ts`: optional access-key auth and rate limiting
- `src/lib/env.ts`: environment variable helpers

## Notes

- Without API keys, the prototype uses seeded report generation so the full user flow still works.
- With `COMPANIES_HOUSE_API_KEY` configured, organisation searches will prefer live Companies House company profile, officers, and PSC data.
- With `OPENSANCTIONS_API_KEY` configured, sanctions screening will prefer live OpenSanctions match results for both people and organisations.
- With `BRAVE_SEARCH_API_KEY` configured, adverse and positive media sections will prefer live Brave Search results, fetch HTML and PDF text when possible, and verify synthesized media summaries against source content.
- ICIJ Offshore Leaks, GLEIF, and FCA Warning List enrichments are public-source lookups and do not require additional API keys.
- When `APP_ACCESS_KEY` is set, the UI and API expect that key on report creation and polling requests.
- Reports now persist to `data/report-jobs.sqlite`, so completed jobs survive local restarts.
- Individual/person reports use extra media filtering to drop unrelated common-name results where possible, but ambiguous names still benefit significantly from DOB and context input.

## Agent-first usage

The UI still exposes a form and report view, but the repo now also supports an agent-facing entrypoint:

```bash
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Screen Acme Holdings Ltd in the UK and check adverse media\"}"
```

That endpoint will:

1. extract a `ReportRequest` from natural language
2. start a normal report job using the existing orchestration layer
3. return a `report_id` for polling and follow-up questions

Once the report is complete, ask grounded follow-up questions:

```bash
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"What are the main risk drivers?\",\"report_id\":\"<report-id>\"}"
```

This is the first practical step toward an agent-native diligence product: the report pipeline becomes a tool the agent calls, rather than the final UX.

## Additional Data Sources

The next recommended enrichment pass is to add more free or open-source diligence data beyond Companies House, OpenSanctions, and Brave Search.

Priority order:

1. `ICIJ Offshore Leaks Database`
   Best for Panama Papers, Pandora Papers, Paradise Papers, offshore entities, intermediaries, officers, and addresses.
   Important caveat: inclusion is a risk signal, not proof of wrongdoing.
   Source: https://offshoreleaks.icij.org/

2. `GLEIF Global LEI Index`
   Best for entity identifiers, official names, addresses, and direct/ultimate parent relationships.
   Useful for ownership and control mapping.
   Source: https://www.gleif.org/lei-data/global-lei-index

3. `UK FCA Warning List`
   Best for unauthorised firms, scam warnings, and retail/investment risk flags.
   Source: https://www.fca.org.uk/scamsmart/about-fca-warning-list

4. `UK Charity Register`
   Best for charity links, trustees, and regulatory status.
   Source: https://www.gov.uk/find-charity-information

5. `UK Individual Insolvency Register`
   Best for bankruptcy, IVA, and DRO checks on individuals.
   Source: https://www.insolvencydirect.bis.gov.uk/eiir/eiir/

6. `World Bank Debarred Firms and Individuals`
   Best for procurement and integrity exclusions.
   Source: https://www.worldbank.org/debarr

7. `SEC EDGAR`
   Best for US public-company filings, beneficial ownership disclosures, and litigation/disclosure context.
   Source: https://www.sec.gov/search-filings

8. `OpenCorporates`
   Best for cross-jurisdiction company and officer search.
   Source: https://api.opencorporates.com/

Recommended next implementation order:

1. `ICIJ Offshore Leaks`
2. `GLEIF`
3. `FCA Warning List`
4. `UK Insolvency Register`
5. `World Bank Debarments`
6. `SEC EDGAR`

The best next build for demo impact is `ICIJ Offshore Leaks`, because it adds a highly legible offshore/leaks signal with strong narrative value.
