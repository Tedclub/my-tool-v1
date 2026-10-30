import { validateStaticSnapshot } from "./static-snapshot.js";

// Static-only reader: this function never contacts workers.dev or Primary APIs.
export async function readStaticSnapshot(manifestUrl, { fetcher = fetch, now = new Date() } = {}) {
  const read = async url => {
    const response = await fetcher(url, { headers: { Accept: "application/json" },
      cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("STATIC_HTTP_" + response.status);
    return response.json();
  };
  const url = new URL(manifestUrl);
  const manifest = await read(url.href);
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.snapshot_hash || "")) throw new Error("INVALID_MANIFEST_HASH");
  const path = "/v2/snapshots/" + manifest.snapshot_hash.slice(7) + "/";
  const resolve = (value, filename) => {
    const target = new URL(value, url);
    if (target.origin !== url.origin || !target.pathname.endsWith(path + filename) ||
        target.search || target.hash) throw new Error("INVALID_MANIFEST_FILE_PATH");
    return target.href;
  };
  const summaryUrl = resolve(manifest.files?.summary, "summary.json");
  const compactUrl = resolve(manifest.files?.twse_compact, "TWSE-compact.json");
  const [summary, compact] = await Promise.all([read(summaryUrl), read(compactUrl)]);
  const validation = validateStaticSnapshot(manifest, summary, compact, now);
  return { manifest, summary, compact, validation, urls: { manifest: url.href, summary: summaryUrl, compact: compactUrl } };
}

export async function usableStaticCandidates(manifestUrl, options) {
  try {
    const snapshot = await readStaticSnapshot(manifestUrl, options);
    return { status: snapshot.validation.ok ? "PASS" : "DATA_FAIL",
      scan_date: snapshot.manifest.scan_date, snapshot_hash: snapshot.manifest.snapshot_hash,
      retrieved_candidate_count: snapshot.compact.candidates.length,
      candidates: snapshot.validation.ok ? snapshot.compact.candidates : [],
      warnings: snapshot.validation.warnings };
  } catch {
    return { status: "RETRIEVAL_FAIL", candidates: [], warnings: ["STATIC_RETRIEVAL_FAILED"] };
  }
}
