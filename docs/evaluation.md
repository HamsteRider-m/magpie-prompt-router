# Product Evaluation & Experimental Validation (`magpie-prompt-router`)

> Evaluation date: 2026-11-20 · Target version: `0.1.0` · Perspective: Product Manager (Qualitative + Quantitative)

## 1. Executive Summary

- **Overall Score**: **86.8 / 100 (A)** (upgraded from **83.9 / 100** after shipping P1/P2 UX, observability, and multi-gateway sync improvements) — Ready for public open-source sharing and daily engineering use.
- **Core Strength**: Rare combination of **gateway-level determinism** (zero runtime dependencies, zero LLM classifier latency, `< 0.01 ms` per route decision), **strict wire safety** (7 immutable keys + `config.tools`/`toolConfig` guards, fail-open semantics, verified across 407 formal invariant cases), and **multi-surface ergonomics** (Web UI + `mpr` CLI + `.prompt-router.md` + companion Skill + opt-in decision tracing).
- **Remaining Gap**: Online GitHub repository rename (`magpie-prompt-router`) & first npm `0.1.0` publish.

---

## 2. Evaluation Rubric & Weighted Scorecard

Each dimension is scored on a **0–10** scale using explicit quantitative indicators and qualitative product criteria:

| Dimension | Weight | Score (/10) | Weighted | Quantitative Evidence | Qualitative Assessment |
| --- | :---: | :---: | :---: | --- | --- |
| **1. Problem-Solution Fit & Positioning** | 20% | **8.8** | 17.6 | Targets 5 major hosts (Alma, Pi, Claude Code, Codex, OpenCode) across 4 wire protocols; 0 bundled redteam/jailbreak payloads | Solves a real, recurring pain point (host persona bloat & per-project prompt fragmentation). Cleanly repositioned as a neutral conditional prompt router, differentiating sharply from flat allowlist plugins. |
| **2. Core Capability & Routing Expressiveness** | 15% | **9.0** | 13.5 | 5 modes (`strict`, `replace`, `fallback`, `append`, `off`), 5 rule dimensions, 4 protocols, sticky + single-turn chat directives, project-file auto-discovery, 4 default excluded globs (`*nmem*`, `*embedding*`, `*rerank*`, `*jev*`) | Expressive precedence chain covers both declarative workspace governance and ad-hoc conversational overrides without leaking directives upstream. |
| **3. Usability & Onboarding DX** | 15% | **8.6** | 12.9 | 3 configuration surfaces (Magpie Web UI + `mpr` CLI + `.prompt-router.md`), 1 companion `SKILL.md`, `mpr export`/`import` multi-gateway sync, smart single-turn default (`replace` when persona is named under `defaultMode: "off"`) | Project-level `.prompt-router.md`, `mpr` CLI, and `export`/`import` make single- and multi-gateway setups smooth; explicit `/route once <personaId>` no longer silently skips. |
| **4. Engineering Reliability, Safety & Performance** | 20% | **9.3** | 18.6 | Zero runtime deps, 36/36 unit tests pass across Node & Bun, 407/407 formal invariant checks pass, 1,000 engine iterations in ~2.7–6.5 ms | Exceptional engineering hygiene. Early ReDoS (11.7 s on 200 KB input) and multi-block Anthropic `strict` leakage were caught and fixed with regression tests. |
| **5. Ecosystem Compatibility & Distribution Readiness** | 15% | **7.6** | 11.4 | Magpie hooks + Liquid Glass theme tokens + inline SVG icon + GitHub Actions CI/CD (`ci.yml`, `release.yml`, `verify-package.mjs`) | Technically compliant with Magpie's middleware contract and ready for npm + Discover. Held back only by pending GitHub repo rename and first npm publish. |
| **6. Observability & Debuggability** | 15% | **8.5** | 12.75 | Interactive Web UI simulator (18 parity cases) + `mpr status --recent` / `mpr test` + bounded 20-entry `getRecentDecisions()` ring buffer + opt-in `traceLog` | Both pre-flight dry-runs and live gateway hit tracing are now supported with zero hot-path disk I/O by default. |
| **Total** | **100%** | — | **86.8 / 100** | **36/36 tests · 0 deps · CI/CD ready** | **Production-ready v0.1 open-source release (A)** |

### Rubric Anchor Definitions
- **9.0–10.0 (Best-in-Class)**: Proven in production/benchmarks, zero known major UX or reliability gaps.
- **8.0–8.9 (Strong)**: Complete core value, minor polish or distribution gaps remaining.
- **7.0–7.9 (Solid, Needs Polish)**: Functional and usable, but clear friction points affect first-time users or operators.
- **< 7.0 (Needs Work)**: Structural gaps blocking adoption or safety.

---

## 3. Codebase & Packaging Quantitative Snapshot

Measured on `main` (`0.1.0`):

| Metric | Value |
| --- | --- |
| Runtime dependencies | `0` (Node/Bun built-ins only: `node:fs`, `node:os`, `node:path`) |
| Core runtime size | `src/engine.js`: 257 lines (14.4 KB) · `src/hooks.js`: 389 lines (18.1 KB) |
| Settings UI size | `page/app.js`: 231 lines · `page/index.html`: 46 lines · `page/style.css`: 111 lines |
| Terminal CLI & Skill | `bin/magpie-prompt-router.mjs`: 306 lines · `skills/magpie-prompt-router/SKILL.md`: 71 lines |
| Packed npm artifact | 12 files · **30.7 KB** tarball (`103.4 KB` unpacked) |
| Automated test suite | **34 pass / 0 fail** across 5 test files (Node v26: 656 ms; Bun 1.3.14: 329 ms) |
| CI/CD coverage | Node 20 & 22 matrix, Bun test, manifest/tarball/clean-repo verification, tag-triggered npm + GitHub Release |

---

## 4. Sanitized Experimental & Validation Results

> Note: All records below are sanitized from internal development experiments and live gateway validations. Private hostnames, local ports, provider group identifiers, account details, and test prompt contents have been removed.

### Experiment A — Live Gateway Strict Replacement & Directive Wire Stripping
- **Setup**: Sent a single-turn strict directive through a live local Magpie gateway routing to a production upstream chat model, comparing baseline host system prompt vs. strict replacement with the minimal built-in persona.
- **Quantitative Result**:
  - `prompt_tokens` dropped from **4,475 → 4,454** (`-21` tokens).
  - HTTP status: `200 OK`; directive text was stripped cleanly from the wire payload before reaching upstream.
- **Takeaway**: Confirmed end-to-end system prompt replacement and wire directive stripping work on live gateway traffic while leaving the upstream model's native safety boundaries untouched.

### Experiment B — Multi-Variant Live Gateway Comparison & `defaultMode: "off"` Edge Case
- **Setup**: Executed 6 live gateway comparison runs (`HTTP 200` across all 6 runs, low reasoning effort, capped output tokens) comparing unrouted baseline vs. 5 single-turn directive variants against boundary-testing prompts.
- **Quantitative Result**:
  - **6 / 6** requests succeeded cleanly (`HTTP 200`, zero gateway errors or malformed wire payloads).
  - When `defaultMode` was `"off"` and a single-turn directive specified only `<personaId>` *without* an explicit mode (`strict` / `replace` / `append`), the directive was stripped cleanly while prompt injection stayed skipped (**`prompt_tokens = 99`**, identical to the unrouted baseline).
- **Takeaway**: Verified safe fail-closed injection under `defaultMode: "off"`, and highlighted a UX pitfall: users expecting `/route once <personaId>` to activate injection without typing a mode can be surprised unless documented or given an implicit default active mode.

### Experiment C — Independent Adversarial Audit & Regression Fixes (Performance & Protocol Isolation)
Two high-severity issues were discovered during independent pre-release review and resolved before `0.1.0`:
1. **Large-Payload Regex Backtracking (ReDoS)**:
   - *Before fix*: Lazy `[\s\S]*?` context scrubbing on unmatched 200 KB–1 MB payloads took **~11.7 s** locally (**~11.05 s** in live host), stalling subsequent small requests at **~11.07 s** on the shared gateway process.
   - *After fix*: Added prefix-window short-circuiting (`sentAt > 8192`) and strict boundary anchors. Current benchmark runs **1,000 engine iterations in ~2.7–6.5 ms** (`< 0.01 ms/request`).
2. **Anthropic `strict` Multi-Block Leakage**:
   - *Before fix*: On payloads with three ~10 KB `system` blocks, `strict` mode replaced only block 0 and leaked trailing host blocks.
   - *After fix*: `strict` mode collapses Anthropic `system` to a single target block, while `replace`/`append` preserve surviving block metadata and `cache_control` object identity.

### Experiment D — Formal Invariant Verification & Zero-Dependency E2E Validation
- **Formal Invariant Suite**: Evaluated **400 deterministic cross-protocol request combinations** (fixed seed) plus **7 null/malformed payloads** across `chat`, `responses`, `anthropic`, and `gemini`:
  - **100% pass** on all 6 invariants: fail-open on bad input, zero in-place input mutation, exact structural equality of all 7 immutable wire keys + `config.tools`/`toolConfig`, idempotent account-fallback retry restoration, zero directive leakage on the wire, and auxiliary-model immunity.
  - Fault-injection check confirmed the harness reliably catches counterexamples when `src/hooks.js` is intentionally broken.
- **Zero-Dependency E2E Suite**: Verified isolated config loading, all four protocol rewrites, and live DOM simulator clicks on a local HTTP server.

---

## 5. Prioritized Product Roadmap & Shipped Optimizations

- **P1 — `/route once <personaId>` UX Fix (Shipped)**: Explicit `/route once <personaId>` and `@route <personaId>` under `defaultMode: "off"` now default that turn to `replace` (with full `page/app.js` simulator parity), while explicit `off` still wins.
- **P1 — Lightweight Runtime Traceability (Shipped)**: Added a bounded 20-entry in-memory ring buffer (`getRecentDecisions()`) plus opt-in `traceLog` (`mpr set-default --trace on`) readable via `mpr status --recent` (zero prompt text or secrets logged).
- **P2 — Multi-Gateway Sync Helper (Shipped)**: Added `mpr export [--out <file>]` and `mpr import <file>` to sync personas, rules, and defaults cleanly across local and remote Hub Magpie instances.
- **P0 — Distribution Hygiene (Pending User Action)**: Rename the GitHub repository to `magpie-prompt-router`, add the `magpie-plugin` topic, close the legacy registry PR, configure `NPM_TOKEN`, and tag `v0.1.0`.
