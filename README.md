# Multimode Mind

A multi-store memory layer for AI agents, exposed over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

An open-source project by Old Cart Technology LLC.

> Agent memory is an architecture problem, not a storage problem. The differentiator is the router, not the stores.

Most agent-memory tools ask you to pick a store (a vector database, a key-value cache, a pile of Markdown notes) and then bend your workflow to fit it. Multimode Mind takes the opposite position: your knowledge already lives in several places, and it should stay there. Multimode Mind wraps the stores you already have behind a single `retrieve()` router that returns one ranked context bundle with full provenance.

## Design

Multimode Mind is a TypeScript MCP server that sits in front of up to five memory stores (plus an append-only audit log):

| Store | Backend | Role |
|---|---|---|
| **markdown** | Plain `.md` files (Obsidian-compatible, vault-agnostic) | Existing notes, read non-destructively |
| **sqlite** | `better-sqlite3` *(or Postgres)* | Structured, queryable memory |
| **leveldb** | `level` | Fast key-value session state |
| **files** | Flat files + JSON metadata index | Arbitrary document memory |
| **vector** | `vectra` *(or pgvector)* | Semantic search |

A single router fans out to every available store in parallel, scores each candidate, merges what the stores agree on, and returns one ranked bundle. Every result carries its source, so an agent always knows where a memory came from. How that ranking works is the [next section](#retrieval). It is the part that makes this a router rather than a fan-out.

**Wrap, don't migrate.** Point Multimode Mind at your existing Markdown vault and it reads it in place, with no import step and no lock-in.

### Pluggable backends

The structured and semantic slots are pluggable. Keep the zero-config local defaults (SQLite + Vectra), or point them at a **Postgres** database you already run. One connection can back both the structured store and, via **pgvector**, the semantic store. Same "wrap, don't migrate" principle, scaled from your notes to your database of record.

Select backends in the dashboard (`[b]`) or via environment:

```bash
MMIND_BACKEND_STRUCTURED=postgres   # sqlite | postgres
MMIND_BACKEND_VECTOR=pgvector       # vectra | pgvector
MMIND_POSTGRES_URL=postgresql://user@host/db   # credentials via env, never on disk
```

## Retrieval

Picking the best answer out of five stores is not a similarity search. A note in your vault and a note the agent wrote about itself an hour ago are not the same kind of evidence, and neither embeddings nor keywords can tell you which one to believe. So the router scores relevance, then scales it by three things a raw score does not know.

**Relevance** blends embedding similarity with an IDF-weighted keyword score (BM25), so a query term that is rare in your corpus counts for more than one that appears everywhere. The two signals are reported separately by each store: a store with no embeddings returns "no opinion" rather than a similarity of zero, which is a different claim entirely.

**Recency** is an exponential half-life decay, per store, with a floor. Session scratch halves in days; your vault halves in years. It is a multiplier and not a tiebreaker. A strongly relevant old note still beats a weakly relevant new one, which is the behavior you want the first time an agent confidently cites something it just made up.

**Corroboration** collapses near-duplicates into a single result that lists every store it was found in, keeps the best score, and adds a bounded bonus for agreement. Finding the same fact in three places is evidence; showing it to the agent three times is just noise in the context window.

**Trust** is two tiers, not a per-store dial. Content you wrote or filed on purpose is `curated`; content the agent generated is `generated`. One flag, one multiplier, and the reason it is coarse is that a numeric weight per store is a knob nobody can calibrate honestly.

When two memories contradict each other, the router says so. `retrieve` returns a `conflicts` array naming the pair, the kind of disagreement (`numeric`, `temporal`, `negation`, `correction`), which one it would trust, and why, including the uncomfortable case where it kept the older memory because the newer one is agent-generated. Pass `explain: true` and every result carries its full derivation: both relevance signals, the blend, and each multiplier that scaled it.

None of this is tuned by feel. `npm run eval` grades the router against a labeled corpus and the baseline ranking it replaced, and fails the build if any case regresses; `npm run eval:explain [case]` prints the arithmetic for a single query.

### Tuning

Defaults are sane and the whole table is editable, from the dashboard's `[t]` panel, or by environment for a client entry or a test that needs to pin the ranking regardless of what is saved:

```bash
MMIND_RANK_SEMANTIC_WEIGHT=0.7      # embedding similarity
MMIND_RANK_LEXICAL_WEIGHT=0.3       # IDF-weighted keyword match
MMIND_RANK_RECENCY_FLOOR=0.4        # lowest an old memory decays to
MMIND_RANK_HALFLIFE_MARKDOWN=1095   # per store: MARKDOWN|SQLITE|LEVELDB|FILES|VECTOR
MMIND_RANK_TRUST_CURATED=1.15       # and MMIND_RANK_TRUST_GENERATED
MMIND_RANK_CORROBORATION_BOOST=0.12 # per extra agreeing store, capped
MMIND_RANK_DUPLICATE_THRESHOLD=0.82 # token overlap that means "the same note"
MMIND_RANK_CONFLICT_DETECTION=off   # default on
```

## Access and audit

Your notes are yours, and an agent with write access to them is a bad default. Every store carries a read or read/write mode, set in the dashboard (`[a]`) or by `MMIND_ACCESS_<STORE>`; the Markdown vault ships **read-only**. A write to a read-only store is refused, not silently dropped.

Alongside the five stores is an append-only audit log recording every query, read, write, and denial. It is system-managed: the agent cannot write to it, cannot retrieve from it, and cannot turn it off. Read it in the dashboard (`[l]`), or point it somewhere else with `MMIND_AUDIT_PATH`.

## Tools

The server exposes three MCP tools:

- **`retrieve`** searches all stores and returns a ranked context bundle with provenance, conflicts, and optional per-result score derivation
- **`store`** persists content (with an auto-generated embedding) to a target store, subject to that store's access mode
- **`sources`** reports the health and entry counts of every configured store

## Install

```bash
npm install -g multimodemind
```

## Usage

Run as an MCP server over stdio. Pass your Markdown vault as the first argument:

```bash
mmind "/path/to/your/vault"
```

Store data is written to `~/.mmind` by default, so `mmind` works from any
directory. Everything can also be configured via environment variables (which
take precedence over the positional argument):

| Variable | Default | Purpose |
|---|---|---|
| `MMIND_VAULT_PATH` | *(first CLI arg, else disabled)* | Markdown vault directory |
| `MMIND_SQLITE_PATH` | `~/.mmind/memory.db` | SQLite database file |
| `MMIND_LEVELDB_PATH` | `~/.mmind/leveldb` | LevelDB directory |
| `MMIND_FILES_PATH` | `~/.mmind/files` | Files directory |
| `MMIND_VECTOR_PATH` | `~/.mmind/vector-index` | Vector index directory |
| `OPENAI_API_KEY` | *(unset)* | Enables OpenAI embeddings; falls back to a local model when absent |

### Embeddings

Embeddings are pluggable. With `OPENAI_API_KEY` set, Multimode Mind uses `text-embedding-3-small`. Without it, it falls back to a local `@huggingface/transformers` model (downloaded once, ~23 MB) so retrieval works fully offline.

### Terminal dashboard

A built-in terminal dashboard shows store status and handles configuration interactively: paths, per-store access (`[a]`), backends (`[b]`), the retrieval weights (`[t]`), and the audit log (`[l]`):

```bash
npm run dashboard
```

Ranking changes are saved immediately, but the server reads them at startup, so restart it for an edit to take effect.

## Roadmap

Shipped: the three tools, five stores, pluggable Postgres/pgvector backends, per-store access control, the audit log, and the ranking router (decay, corroboration, trust, conflict detection, and the eval harness that keeps them honest).

Next up, roughly in order: recognizing agreement between differently-worded claims (corroboration currently keys on near-duplicates), audit log rotation, and more backends such as MySQL, Redis, and Qdrant.

## License

MIT © 2026 Old Cart Technology LLC
