// Copies attachment objects to a moved thread's new path, in Fluxer's CDN
// bucket (docs/design/history-rewrite.md, "Threads"). Fluxer stores a file
// at attachments/{channelId}/{attachmentId}/{filename} and builds every URL
// from the message's channel, so a thread that takes a new ID needs its
// files under the new ID too. The old objects are left in place.
//
// Run inside Fluxer's API container, which has the S3 client and settings:
//   node copy-thread-files.mjs < moves.jsonl
// Each input line is {"from": "<key>", "to": "<key>"}. Prints counts only.
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const require = createRequire('/usr/src/app/fluxer_api/package.json');
const { CopyObjectCommand, HeadObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const KEY = /^attachments\/\d{1,20}\/\d{1,20}\/[^\0]{1,255}$/;
const CONCURRENCY = 8;
const MAX_LINES = 100_000;

const bucket = process.env.FLUXER_S3_BUCKET_CDN;
if (!bucket) throw new Error('FLUXER_S3_BUCKET_CDN is not set');
const s3 = new S3Client({
    endpoint: process.env.FLUXER_S3_ENDPOINT,
    region: process.env.FLUXER_S3_REGION || 'us-east-1',
    forcePathStyle: process.env.FLUXER_S3_FORCE_PATH_STYLE !== 'false',
    credentials: {
        accessKeyId: process.env.FLUXER_S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.FLUXER_S3_SECRET_ACCESS_KEY,
    },
});

async function exists(key) {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404) return false;
        throw error;
    }
}

const counts = { copied: 0, present: 0, missing: 0, failed: 0 };

async function copy({ from, to }) {
    if (!KEY.test(from) || !KEY.test(to)) throw new Error('bad key');
    if (await exists(to)) return void counts.present++;
    if (!(await exists(from))) return void counts.missing++;
    const source = `${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
    await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: source }));
    counts.copied++;
}

const moves = [];
for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === '') continue;
    if (moves.length >= MAX_LINES) throw new Error('too many lines');
    moves.push(JSON.parse(line));
}
let next = 0;
async function worker() {
    while (next < moves.length) {
        const move = moves[next++];
        try {
            await copy(move);
        } catch {
            counts.failed++;
        }
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(JSON.stringify({ total: moves.length, ...counts }));
if (counts.failed > 0) process.exit(1);
