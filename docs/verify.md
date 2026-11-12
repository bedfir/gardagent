# Verify a ledger offline

The `@gardagent/verify` package verifies a ledger handed to you without connecting to a gateway, database or network. It uses only Node.js built-ins and an independent implementation of [the ledger format](ledger-format.md). Run it with a supported Node.js version after building the repository:

```sh
pnpm --filter @gardagent/verify build
node packages/verify/dist/cli.js ledger.ndjson
node packages/verify/dist/cli.js --json ledger.ndjson checkpoint.json older-checkpoint.json
```

The CLI accepts one export file followed by zero or more checkpoint JSON files. Exit code 0 means the complete export and every supplied checkpoint passed; any malformed input, unavailable file, chain failure or missing checkpoint produces exit code 1. No files are modified. The current implementation reads the export into memory; allow memory proportional to the file size and use this tool only on files that fit available memory.

## Prepare the export

Ask the sender for the NDJSON output of `GET /admin/ledger/export.ndjson`, starting at sequence 1. For multiple pages, the sender must capture the first page's `checkpoint.sequence` and `checkpoint.head_hash`, then request each following page using `afterSeq=nextAfterSeq`, `headSequence` and `headHash` until `nextAfterSeq` is null. Concatenate the complete responses in order, retaining each metadata line and newline. Do not supply CSV, an `/admin/ledger` JSON response, an isolated subrange or a single unfinished page.

Every page must refer to the same captured sequence and hash; its timestamp may differ. The verifier checks page cursors, genesis, sequence continuity, links, hashes, supported versions, field constraints, version ordering and approval decision binding. The last entry must match the embedded captured head. An empty export must capture sequence zero and the genesis hash.

For independent comparison, obtain checkpoints saved earlier outside the ledger database, for example a JSON response from `GET /admin/ledger/checkpoint`. Establish their provenance separately through a trusted channel. Supply each as an additional file argument. The tool checks whether the exact hash at each checkpoint's sequence is present; all supplied checkpoints must be contained for success. A checkpoint with a later sequence than the export fails the comparison even if both files are authentic: obtain a sufficiently recent export before drawing a conclusion.

## Read the result

Text output says `VALID` or `INVALID`, reports the number of entry records in the file, the verified prefix head (sequence and hash), and the first invalid entry's sequence and reason when available. A metadata or parse failure may have no entry sequence. Each supplied checkpoint has a containment result. On invalid JSON the entry count is zero because no records were accepted.

`--json` returns the same information as a JSON object: `valid`, `count`, `head`, `firstInvalid`, `checkpoints` and `limitation`. Checkpoint indexes are zero-based and follow argument order. Each checkpoint reports structural `valid`, `contained`, and a failure `reason`. File and argument errors instead return `{ "valid": false, "error": "..." }`. Only a result with `valid: true` and exit status zero is successful; a prefix head from a failing result is not a verified full export.

## What success proves

A valid result proves the integrity of the recorded entries relative to the supplied chain and any trusted external checkpoints it contains. Version 1, version 2 and a version 1 prefix followed by version 2 are supported. Approval correlation confirms consistency of recorded references and argument hashes; it does not authenticate a human or demonstrate execution of an action.

It does not prove completeness of what happened, the truth of the events, the origin of the file, or the identity of a human. Someone able to recompute hashes can rewrite an unanchored chain. The embedded export head is useful for detecting incomplete downloads, but arrives with the export and is not an independent trust anchor. Removing a suffix and updating that embedded head yields a self-consistent export: without a trusted external checkpoint the tool cannot detect the removal and explicitly says so, even on success.

A retained checkpoint detects suffix removal below its sequence and rewrites that change its committed prefix. It provides no evidence about entries after its sequence. The tool does not claim completeness beyond that checkpoint. Keep checkpoints outside the ledger database, along with evidence of when and from whom they were obtained.
