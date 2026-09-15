#!/usr/bin/env python3
"""Assemble a ChefStatus producer receipt (Atlas CF#665).

Artifact, runtime backend, and visible GUI identity are separate reads.
Display fields come from the compiled app (HTML meta), never from /healthz.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-preview\.\d+)?$")
TRACE = re.compile(r"^[0-9a-f]{32}$")
INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
BINDING_KEYS = (
    "tenantId",
    "projectId",
    "repositoryId",
    "connectorId",
    "providerRepositoryId",
    "configurationRevision",
    "environmentId",
)
OPERATION_STATUSES = frozenset(
    {"queued", "claimed", "running", "blocked", "succeeded", "failed"}
)
VERSION_META = re.compile(
    r'<meta\s+name="ocx-build-version"\s+content="([^"]+)"\s*/?>',
    re.I,
)
SHA_META = re.compile(
    r'<meta\s+name="ocx-build-sha"\s+content="([^"]+)"\s*/?>',
    re.I,
)


def fail(message: str) -> None:
    raise SystemExit(message)


def parse_build_version_meta(html: str) -> str | None:
    match = VERSION_META.search(html)
    if match and VERSION.match(match.group(1)):
        return match.group(1)
    return None


def parse_build_sha_meta(html: str) -> str | None:
    match = SHA_META.search(html)
    if match and SHA.match(match.group(1)):
        return match.group(1)
    return None


def parse_digest(value: str, name: str) -> str:
    digest = value[value.rfind("@") + 1 :] if "@" in value else value
    if not DIGEST.match(digest):
        fail(f"{name} must be sha256: plus 64 hex")
    return digest


def load_binding(path: Path) -> dict:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        fail("binding must be a JSON object")
    binding = {}
    for key in BINDING_KEYS:
        if key not in raw:
            fail(f"binding missing {key}")
        value = raw[key]
        if key == "configurationRevision":
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                fail("binding.configurationRevision must be a positive integer")
            binding[key] = value
            continue
        if not isinstance(value, str) or not value or len(value) > 256:
            fail(f"binding.{key} must be a non-empty string")
        binding[key] = value
    return binding


def observed(binding: dict, value: dict, source_revision: str, now: str, fresh_until: str, trace_id: str) -> dict:
    for key, entry in value.items():
        if not isinstance(entry, str) or not entry or len(entry) > 256:
            fail(f"{key} must be a string of 1-256 chars")
    return {
        "kind": "observed",
        "value": value,
        "freshUntil": fresh_until,
        "provenance": {
            "connectorId": binding["connectorId"],
            "providerResourceId": binding["providerRepositoryId"],
            "sourceRevision": source_revision,
            "observedAt": now,
            "ingestedAt": now,
            "traceId": trace_id,
        },
    }


def assemble_receipt(
    *,
    binding: dict,
    now: str,
    fresh_until: str,
    trace_id: str,
    artifact: dict,
    runtime_backend: dict,
    display: dict,
    operation: dict,
) -> dict:
    if not display.get("independent") and display.get("version"):
        fail("display fields require an independent HTML/browser read; do not copy /healthz")
    if display.get("version") and display.get("source_sha") and display.get("artifact_digest") and display.get("verification_ref"):
        runtime = observed(
            binding,
            {
                "version": runtime_backend["version"],
                "sourceSha": runtime_backend["sourceSha"],
                "artifactDigest": runtime_backend["artifactDigest"],
                "displayVersion": display["version"],
                "displaySourceSha": display["source_sha"],
                "displayArtifactDigest": display["artifact_digest"],
                "verificationRef": display["verification_ref"],
            },
            runtime_backend["sourceSha"],
            now,
            fresh_until,
            trace_id,
        )
    else:
        if not display.get("version"):
            reason = "display_version_unobservable"
        elif not display.get("source_sha"):
            reason = "display_source_sha_unobservable"
        elif not display.get("artifact_digest"):
            reason = "display_artifact_digest_unobservable"
        else:
            reason = "display_verification_ref_unobservable"
        runtime = {"kind": "unknown", "reason": reason}
    return {
        "schemaVersion": "1",
        "binding": binding,
        "artifact": observed(binding, artifact, artifact["sourceSha"], now, fresh_until, trace_id),
        "runtime": runtime,
        "operation": observed(binding, operation, operation["desiredSha"], now, fresh_until, trace_id),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["assemble"])
    parser.add_argument("--binding", required=True)
    parser.add_argument("--now", required=True)
    parser.add_argument("--fresh-until", required=True)
    parser.add_argument("--trace-id")
    parser.add_argument("--artifact-version", required=True)
    parser.add_argument("--artifact-source-sha", required=True)
    parser.add_argument("--artifact-digest", required=True)
    parser.add_argument("--runtime-version", required=True)
    parser.add_argument("--runtime-source-sha", required=True)
    parser.add_argument("--runtime-digest", required=True)
    parser.add_argument("--display-html")
    parser.add_argument("--display-version")
    parser.add_argument("--display-source-sha")
    parser.add_argument("--display-digest")
    parser.add_argument("--verification-ref", required=True)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--operation-owner", required=True)
    parser.add_argument("--operation-status", required=True)
    parser.add_argument("--desired-sha", required=True)
    parser.add_argument("--authority", required=True)
    parser.add_argument("--evidence-ref", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    if not INSTANT.match(args.now) or not INSTANT.match(args.fresh_until):
        fail("--now and --fresh-until must be UTC YYYY-MM-DDTHH:MM:SSZ")
    if args.operation_status not in OPERATION_STATUSES:
        fail("--operation-status is not an admitted operation status")
    if not SHA.match(args.artifact_source_sha) or not SHA.match(args.runtime_source_sha) or not SHA.match(args.desired_sha):
        fail("source SHAs must be 40 hex")
    if not VERSION.match(args.artifact_version) or not VERSION.match(args.runtime_version):
        fail("versions must be X.Y.Z or X.Y.Z-preview.N")
    trace_id = args.trace_id or uuid.uuid4().hex
    if not TRACE.match(trace_id):
        fail("--trace-id must be 32 hex")
    display_version = args.display_version
    display_sha = args.display_source_sha
    independent = False
    if args.display_html:
        html = Path(args.display_html).read_text(encoding="utf-8")
        display_version = parse_build_version_meta(html)
        display_sha = parse_build_sha_meta(html)
        independent = True
    receipt = assemble_receipt(
        binding=load_binding(Path(args.binding)),
        now=args.now,
        fresh_until=args.fresh_until,
        trace_id=trace_id,
        artifact={
            "version": args.artifact_version,
            "sourceSha": args.artifact_source_sha,
            "artifactDigest": parse_digest(args.artifact_digest, "--artifact-digest"),
        },
        runtime_backend={
            "version": args.runtime_version,
            "sourceSha": args.runtime_source_sha,
            "artifactDigest": parse_digest(args.runtime_digest, "--runtime-digest"),
        },
        display={
            "version": display_version if display_version and VERSION.match(display_version) else None,
            "source_sha": display_sha if display_sha and SHA.match(display_sha) else None,
            "artifact_digest": args.display_digest,
            "verification_ref": args.verification_ref,
            "independent": independent,
        },
        operation={
            "id": args.operation_id,
            "owner": args.operation_owner,
            "status": args.operation_status,
            "desiredSha": args.desired_sha,
            "authority": args.authority,
            "evidenceRef": args.evidence_ref,
        },
    )
    Path(args.out).write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
