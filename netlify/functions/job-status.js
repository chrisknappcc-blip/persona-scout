// job-status.js
// Returns job progress. Accepts ?offset=N so the client only receives
// results it hasn't seen yet — avoids re-downloading the full result set on every poll.

const CONTAINER = 'persona-scout';
const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || 'carepathiqdata';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function blobUrl(path) {
  const sas = process.env.AZURE_STORAGE_SAS_TOKEN || '';
  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${path}?${sas}`;
}

async function readBlob(path) {
  const resp = await fetch(blobUrl(path));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Blob read failed (${resp.status})`);
  return resp.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { jobId, offset: offsetStr } = event.queryStringParameters || {};
  const offset = parseInt(offsetStr || '0', 10) || 0;

  if (!jobId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'jobId required' }) };

  try {
    const metadata = await readBlob(`${jobId}/metadata.json`);
    if (!metadata) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Job not found' }) };

    const { chunkCount, total } = metadata;

    // Read all chunk statuses in parallel
    const statusResults = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        readBlob(`${jobId}/chunks/${i}/status.json`).catch(() => null)
      )
    );

    let totalProcessed = 0;
    let allComplete = true;
    let anyError = false;
    const chunkSummaries = [];

    for (const s of statusResults) {
      if (!s) { allComplete = false; chunkSummaries.push({ status: 'queued', processed: 0, total: 0 }); continue; }
      totalProcessed += s.processed || 0;
      if (s.status !== 'complete') allComplete = false;
      if (s.status === 'error') anyError = true;
      chunkSummaries.push({
        index: s.chunkIndex,
        status: s.status,
        processed: s.processed || 0,
        total: s.total || 0,
        resumedFrom: s.resumedFromIdx || null,
      });
    }

    const overallStatus = anyError && allComplete ? 'complete_with_errors'
      : anyError ? 'error'
      : allComplete ? 'complete'
      : 'processing';

    // Read results from chunks that have data, aggregate them in chunk order
    // Only read chunks that have completed at least one write
    const resultReads = await Promise.all(
      statusResults.map((s, i) => {
        if (!s || s.processed === 0) return Promise.resolve([]);
        return readBlob(`${jobId}/chunks/${i}/results.json`).catch(() => []);
      })
    );

    // Concatenate in order: chunk 0 results, chunk 1 results, ...
    const allResults = resultReads.flat();
    const totalResultCount = allResults.length;

    // Only send results the client hasn't seen yet
    const newResults = offset < totalResultCount ? allResults.slice(offset) : [];

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        status: overallStatus,
        total,
        processed: totalProcessed,
        pct: total ? Math.round((totalProcessed / total) * 100) : 0,
        chunks: chunkSummaries,
        totalResultCount,   // client uses this to track offset
        newResults,         // only what the client hasn't seen
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
