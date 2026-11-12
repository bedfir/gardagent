# Verify a published image

This procedure applies to images published by the M13 release workflow. Historical images may have no signature or attestations. Publication and end-to-end verification cannot be tested before a human pushes a release tag. The workflow has only been reviewed statically; the first-release checklist below remains mandatory.

## Tools and trusted inputs

Install Cosign 2.4.3, Docker with Buildx 0.24 or later, and jq 1.6 or later from sources you trust. The workflow uses Cosign 2.4.3. Network access to GHCR and public Sigstore services is required. For a private image, authenticate to GHCR first using your own read-only credentials; never include credentials in reports.

Choose the exact release tag and obtain its expected source commit and image index digest through a channel you trust, for example the maintainer's release record. Tags are mutable. A digest obtained only by resolving a tag does not establish which release you intended to trust. The Git tag has a `v` prefix; the corresponding image version tag omits it.

Replace both placeholders below; these commands intentionally fail if left unchanged:

```sh
export TAG='v1.0.0'
export IMAGE='ghcr.io/bedfir/gardagent'
export DIGEST='sha256:REPLACE_WITH_64_HEX_DIGITS'
export SOURCE_COMMIT='REPLACE_WITH_40_HEX_DIGITS'
printf '%s\n' "$DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || exit 1
printf '%s\n' "$SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$' || exit 1
export REF="${IMAGE}@${DIGEST}"
```

## 1. Authenticate the image index

```sh
cosign verify \
  --certificate-identity "https://github.com/bedfir/gardagent/.github/workflows/release.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$REF" > signature-verification.json
```

Require exit status zero. Do not disable certificate, transparency-log or signature checks. Cosign verifies the signature over the index digest, the certificate identity and issuer, and transparency-log evidence. This proves that a job with this workflow/tag identity signed that digest. It does not prove the code is safe, the tag was authorized by a particular human, or the build infrastructure was uncompromised.

The signed OCI index contains the runnable `linux/amd64` manifest and BuildKit attestation manifests. Their descriptors bind their contents by digest. Verify this index, not only the platform image digest. BuildKit attestations here are covered by the index signature; they are not separate Cosign DSSE attestations, so `cosign verify-attestation` is not the extraction command for this workflow.

## 2. Retrieve and inspect provenance

Use exactly the same immutable reference after signature verification:

```sh
docker buildx imagetools inspect "$REF" --raw > image-index.json
docker buildx imagetools inspect "$REF" \
  --format '{{ json .Provenance.SLSA }}' > provenance.json
jq -e 'type == "object" and length > 0' provenance.json >/dev/null
jq . provenance.json
```

Buildx follows the index's attestation descriptors and resolves the SLSA predicate for the runnable platform. Reject missing or null provenance. Inspect the build invocation/config source and materials: the Git source must be `https://github.com/bedfir/gardagent` (a Git URL suffix is possible), its ref must match the selected release, and its revision must equal `$SOURCE_COMMIT`. Inspect the Dockerfile entry point and resolved base-image materials. The raw index must contain one runnable `linux/amd64` descriptor plus attestation descriptors referring to that platform manifest. Investigate any additional runnable platform or unexpected source before using the image.

This is BuildKit's record of how the image was built, attached by the signed workflow. It is not an independent observation of the build. Maximal provenance includes build parameters and materials; never pass secrets as build arguments. This workflow supplies no secret build arguments. Registry login and signing use the workflow's ephemeral credentials.

## 3. Retrieve and inspect the SBOM

```sh
docker buildx imagetools inspect "$REF" \
  --format '{{ json .SBOM.SPDX }}' > sbom.spdx.json
jq -e '.spdxVersion == "SPDX-2.3" and (.packages | type == "array") and (.packages | length > 0)' \
  sbom.spdx.json >/dev/null
jq -r '.packages[] | [.name, (.versionInfo // "unknown")] | @tsv' sbom.spdx.json
```

BuildKit's SBOM scanner inventories the built image and attaches an SPDX document to the same index. Successful signature verification binds that inventory to the index you selected. It does not guarantee complete package detection, absence of vulnerabilities, accurate licensing, or safety. Check that the inventory contains the runtime operating-system and application dependencies you expect; review it using your own vulnerability and license tools. Retain the index, signature verification output, provenance and SBOM alongside the digest in your release records. A registry may remove evidence later.

Only after all checks pass, run or deploy the immutable reference:

```sh
docker pull "$REF"
```

## Workflow correspondence and limits

On a `v*` tag push, the job checks out source without persistent credentials, configures Buildx, logs into GHCR, and derives version tags (plus `latest` for tags without a hyphen). Buildx uses its default Git context at the triggering revision, builds `linux/amd64`, pushes with `sbom: true` and `provenance: mode=max`, and returns the index digest. Cosign signs that digest using GitHub OIDC, recording evidence in the public Sigstore transparency log. A failed signing step fails the job but can leave an unsigned image/tag in GHCR; publication alone is never sufficient verification. There is no rollback or separate GitHub release asset upload.

Every action is pinned to a commit. Only the image job has `contents: read`, `packages: write` and `id-token: write`. No long-lived signing key is configured. Tool downloads, the hosted runner and BuildKit's default SBOM scanner still form part of the trusted build infrastructure.

Builds are **not reproducible bit for bit**. The Dockerfile uses floating base-image tags and enables Corepack, build tools and the scanner can change, and build metadata includes time-dependent values. Reproducibility would require digest-pinned base images and scanner, fixed toolchain and package-manager binaries, strictly locked dependency resolution, controlled timestamps and deterministic application/OCI output, followed by independent rebuilds and digest comparisons. Signing is not evidence of reproducibility.

## First tagged release: maintainer checklist

A human must perform these checks after pushing the first intended release tag; agents have not run them:

- Confirm all pinned action commits resolve to the intended upstream actions, their input compatibility, and the downloaded Cosign version. Static local review cannot authenticate upstream commit contents.
- Confirm GitHub grants the job only the listed permissions and OIDC works with Sigstore; check GHCR publication and intended visibility, including anonymous reads if public distribution is intended.
- Record the source commit, workflow run and Buildx output index digest. Confirm version tagging, stable-only `latest`, and the selected platform.
- Run every command above on a clean verification machine. Confirm the actual certificate identity, issuer and transparency inclusion; reject a wrong tag identity and a different digest as negative checks.
- Confirm Buildx extracts both documents, the SPDX version and dependency coverage, and the provenance source/ref/revision and base-image materials. Verify attestation subjects refer to the runnable manifest in the signed index. If extraction or source fields differ from this guide, stop and correct the workflow or guide before claiming verification.
- Confirm a tag resolving to an unsigned image is rejected. Confirm replacing/removing an attestation changes the index digest and cannot pass verification against the recorded digest.
- Pull and smoke-test the verified digest, including the console. Retain verification records outside GHCR. Record the actual results and any limitations; do not describe this release chain as exercised until these checks succeed.
