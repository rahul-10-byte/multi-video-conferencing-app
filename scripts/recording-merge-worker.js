#!/usr/bin/env node
/**
 * Off-hours batch merge: find S3 manifests, queue them, run same logic as
 * lambda/recording-processor (reuses its handler).
 *
 * Env (same ideas as backend + Lambda):
 *   S3_BUCKET or VC_RECORDING_S3_BUCKET  — required
 *   S3_PREFIX or VC_RECORDING_S3_PREFIX  — default "recordings"
 *   AWS_REGION or AWS_DEFAULT_REGION
 *   FFMPEG_PATH — e.g. /usr/bin/ffmpeg on EC2
 *   MERGE_MAX_JOBS — cap per run (default 50)
 *   MERGE_SINCE_DAYS — only manifests with S3 LastModified within this many days (default: 1)
 *   MERGE_USE_MANIFEST_TIME — if "true", filter by manifest stoppedAt (needs extra GetObject per key)
 *   MERGE_SINCE_DAYS=  empty + --all  — scan all manifests (use with --limit)
 *
 * CLI overrides:
 *   --since-days=N  (0 with --all: see --all)
 *   --all             no date cutoff on S3 list (still use --limit)
 *   --limit=N
 *   --force         re-merge even if processing-result.json says completed
 *   --bucket=... --prefix=...
 *
 * Crontab example (2 AM, India server):
 *   0 2 * * * cd /opt/vc && set -a && . /opt/vc/.env && set +a && /usr/bin/node scripts/recording-merge-worker.js --since-days=2 >>/var/log/vc-merge.log 2>&1
 */

require("dotenv").config();

const path = require("path");
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");

const bucket =
  process.env.S3_BUCKET ||
  process.env.VC_RECORDING_S3_BUCKET ||
  "";
const prefix =
  String(process.env.S3_PREFIX || process.env.VC_RECORDING_S3_PREFIX || "recordings").replace(
    /^\/+|\/+$/g,
    ""
  );

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseArgs(argv) {
  const rawSince = process.env.MERGE_SINCE_DAYS;
  let initialSince = 1;
  if (rawSince !== undefined && rawSince !== "") {
    const n = Number(rawSince);
    initialSince = Number.isFinite(n) ? n : 1;
  } else if (rawSince === "") {
    initialSince = null;
  }
  const out = {
    sinceDays: initialSince,
    all: process.env.MERGE_ALL === "true",
    limit: process.env.MERGE_MAX_JOBS !== undefined ? Number(process.env.MERGE_MAX_JOBS) : 50,
    force: false,
    bucket: "",
    prefix: "",
    useManifestTime: process.env.MERGE_USE_MANIFEST_TIME === "true"
  };
  for (const a of argv.slice(2)) {
    if (a === "--force") out.force = true;
    else if (a === "--all") out.all = true;
    else if (a.startsWith("--since-days=")) out.sinceDays = Number(a.split("=")[1]);
    else if (a.startsWith("--limit=")) out.limit = Number(a.split("=")[1]);
    else if (a.startsWith("--bucket=")) out.bucket = a.split("=").slice(1).join("=");
    else if (a.startsWith("--prefix=")) out.prefix = a.split("=").slice(1).join("=");
  }
  if (!Number.isFinite(out.limit) || out.limit < 1) out.limit = 50;
  if (out.all) {
    out.sinceDays = null;
  } else if (out.sinceDays !== null && (!Number.isFinite(out.sinceDays) || out.sinceDays < 0)) {
    out.sinceDays = 1;
  }
  return out;
}

async function listManifestKeys(s3, bucketName, prefixNorm, sinceCutoffMs) {
  const keys = [];
  let continuationToken;
  const prefixWithSlash = prefixNorm ? `${prefixNorm}/` : "";
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefixWithSlash,
        ContinuationToken: continuationToken
      })
    );
    for (const obj of resp.Contents || []) {
      if (!obj.Key || !obj.Key.endsWith("/manifest.json")) continue;
      if (sinceCutoffMs != null && obj.LastModified && obj.LastModified.getTime() < sinceCutoffMs) {
        continue;
      }
      keys.push({
        key: obj.Key,
        lastModified: obj.LastModified
      });
    }
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  keys.sort((a, b) => a.lastModified - b.lastModified);
  return keys;
}

async function getProcessingState(s3, bucketName, manifestKey) {
  const dir = path.posix.dirname(manifestKey);
  const resultKey = `${dir}/processing-result.json`;
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: resultKey }));
    const raw = await streamToBuffer(r.Body);
    return JSON.parse(raw.toString("utf8"));
  } catch (e) {
    const code = e?.name || e?.$metadata?.httpStatusCode;
    if (code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function manifestStoppedAtDay(s3, bucketName, manifestKey) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: manifestKey }));
  const raw = await streamToBuffer(r.Body);
  const j = JSON.parse(raw.toString("utf8"));
  const stopped = j.stoppedAt || j.startedAt;
  if (!stopped) return null;
  const d = new Date(stopped);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv);
  const resolvedBucket = args.bucket || bucket;
  if (!resolvedBucket) {
    console.error("missing bucket: set S3_BUCKET or VC_RECORDING_S3_BUCKET or --bucket=");
    process.exit(1);
  }
  const resolvedPrefix = (args.prefix || prefix).replace(/^\/+|\/+$/g, "");

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1";
  const s3 = new S3Client({ region });

  let sinceCutoffMs = null;
  if (args.sinceDays != null) {
    sinceCutoffMs = Date.now() - args.sinceDays * 86400000;
  }

  console.log(
    `[merge-worker] start bucket=${resolvedBucket} prefix=${resolvedPrefix} region=${region} sinceDays=${args.sinceDays ?? "all"} sinceCutoffMs=${sinceCutoffMs ?? "none"} limit=${args.limit} force=${args.force}`
  );

  let manifests = await listManifestKeys(s3, resolvedBucket, resolvedPrefix, sinceCutoffMs);

  if (args.useManifestTime && args.sinceDays != null && !args.all) {
    const dayCutoff = new Date();
    dayCutoff.setUTCDate(dayCutoff.getUTCDate() - args.sinceDays);
    const cutoffDay = dayCutoff.toISOString().slice(0, 10);
    const filtered = [];
    for (const m of manifests) {
      try {
        const day = await manifestStoppedAtDay(s3, resolvedBucket, m.key);
        if (day && day >= cutoffDay) filtered.push(m);
      } catch (_e) {
        filtered.push(m);
      }
    }
    manifests = filtered;
    console.log(`[merge-worker] manifest-time filter kept ${manifests.length} manifests (stoppedAt since ${cutoffDay})`);
  }

  const processorPath = path.join(__dirname, "..", "lambda", "recording-processor", "index.js");
  const { handler } = require(processorPath);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const { key: manifestKey } of manifests) {
    if (done >= args.limit) break;

    if (!args.force) {
      const state = await getProcessingState(s3, resolvedBucket, manifestKey);
      if (state && state.state === "completed") {
        skipped += 1;
        console.log(`[merge-worker] skip completed manifestKey=${manifestKey}`);
        continue;
      }
    }

    console.log(`[merge-worker] processing manifestKey=${manifestKey}`);
    try {
      await handler({
        bucket: resolvedBucket,
        manifestKey
      });
      done += 1;
      console.log(`[merge-worker] ok manifestKey=${manifestKey}`);
    } catch (e) {
      failed += 1;
      console.error(`[merge-worker] fail manifestKey=${manifestKey} ${e?.message || e}`);
    }
  }

  console.log(`[merge-worker] finished processed=${done} skipped=${skipped} failed=${failed} totalListed=${manifests.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
