# Gateway approval correlation

Gateway verification must reject the same approval correlation failures as the standalone verifier, including across ledger pages. Core verification will retain a map of validated decisions supplied by the caller, scoped to one verification run. Both gateway verification methods share that run logic.

The standalone verifier remains independent: its package has no dependencies and docs/verify.md promises a built-ins-only independent implementation. Sharing runtime code would break that property. A contract suite instead runs identical hashed fixtures through core, the standalone verifier, and both gateway methods, with one-row pages. Decision validation, including the existing policyRev requirement, remains unchanged.
