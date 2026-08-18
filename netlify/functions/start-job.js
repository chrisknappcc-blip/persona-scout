// start-job.js
// Saves contacts to Azure Blob, initializes chunk metadata.
// Does NOT trigger background functions — the frontend handles that
// so it can confirm each worker fired successfully.

const CHUNK_SIZE = 3500;
const CONTAINER = 'persona-scout';
const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || 'carepathiqdata';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function blobUrl(path) {
  const sas = process.env.AZURE_STORAGE_SAS_TOKEN || '';
  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${path}?${sas}`;
}

async function writeBlob(path, data) {
  const body = JSON.stringify(data);
  const resp = await fetch(blobUrl(path), {
    method: 'PUT',
    headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Blob write failed (${resp.status}): ${t.slice(0, 200)}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  let contacts;
  try {
    ({ contacts } = JSON.parse(event.body));
    if (!Array.isArray(contacts) || contacts.length === 0) throw new Error('No contacts');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Split into chunks
  const chunks = [];
  for (let i = 0; i < contacts.length; i += CHUNK_SIZE) {
    chunks.push(contacts.slice(i, i + CHUNK_SIZE));
  }

  try {
    // Write metadata
    await writeBlob(`${jobId}/metadata.json`, {
      jobId,
      total: contacts.length,
      chunkCount: chunks.length,
      createdAt: new Date().toISOString(),
      status: 'processing',
    });

    // Write each chunk's contacts + initialize status
    for (let i = 0; i < chunks.length; i++) {
      await writeBlob(`${jobId}/chunks/${i}/contacts.json`, chunks[i]);
      await writeBlob(`${jobId}/chunks/${i}/status.json`, {
        chunkIndex: i,
        total: chunks[i].length,
        processed: 0,
        status: 'queued',
        startedAt: null,
        completedAt: null,
      });
    }

    // Return jobId and chunk count — frontend fires the background workers
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, total: contacts.length, chunkCount: chunks.length }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
};
