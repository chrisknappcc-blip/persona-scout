// process-chunk-background.js
// Netlify background function. Reads its chunk of contacts, classifies via Anthropic,
// writes results incrementally to Azure Blob.
// SAVE POINT: On startup, reads any existing results and resumes from last completed batch.
// If chunk is already complete, exits immediately.

const CONTAINER = 'persona-scout';
const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || 'carepathiqdata';
const BATCH_SIZE = 20;
const WRITE_EVERY = 5; // write results to blob every N batches

function blobUrl(path) {
  const sas = process.env.AZURE_STORAGE_SAS_TOKEN || '';
  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${path}?${sas}`;
}

async function readBlob(path) {
  const resp = await fetch(blobUrl(path));
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Blob read failed (${resp.status}): ${path}`);
  return resp.json();
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
    throw new Error(`Blob write failed (${resp.status}): ${t.slice(0, 150)}`);
  }
}

const CLASSIFICATION_PROMPT = `You are a precise healthcare executive classifier for Care Continuity, a referral analytics platform sold to health systems. Accuracy matters — misclassifications waste sales effort.

TASK: Classify each contact's job title into exactly ONE persona. Read every disambiguation rule before classifying.

═══ PERSONAS WITH DISAMBIGUATION ═══

1. "Executive/Leadership"
   INCLUDES: CEO, COO, CFO, CNO, CMO, CIO, CTO, CSO, CDO, CISO, President, EVP, SVP (standalone), General Counsel, Board member, Chief of Staff, Group President, Regional President, Chair
   EXCLUDES: VP/SVP/Director WITH a functional qualifier → use the functional category

2. "Clinical Operations"
   INCLUDES: Titles containing "Clinical Operations", "Clinic Operations", "Clinical Director" (no specific service line), "Director of Clinical Services", "Director Clinical [anything]"
   *** KEY RULE: "Clinic Operations" = Clinical Operations. Do NOT classify as Ambulatory. ***
   EXCLUDES: "Nursing Operations" → Nursing Officer; "Plant/Facility Operations" → Operating Officer; explicit "Ambulatory/Outpatient" → Ambulatory/Urgent Care

3. "Finance"
   INCLUDES: CFO, VP/Director Finance, Revenue Cycle, Controller, Reimbursement, Revenue Integrity, Financial Planning, Budget, Accounting, Treasurer, Chief Accounting Officer, Government Finance

4. "Operating Officer"
   INCLUDES: COO, VP/Director Operations (NO clinical qualifier), Hospital Operations
   *** KEY RULE: "Director, Operations" with NO qualifier = Operating Officer ***
   EXCLUDES: "Clinical Operations" → Clinical Operations; "Nursing Operations" → Nursing Officer
   *** IMPORTANT: Facilities, Plant, Supply Chain, Procurement, Logistics, Food Service, Environmental Services, Hospitality, Security, Linen → return NULL. These are not target personas. ***

5. "Nursing Officer"
   INCLUDES: CNO, VP/Director Nursing, Chief Nursing, Director of Nursing, Nursing Operations, Nursing Services, Nursing Excellence, Nursing Practice, Nursing Support Services, Nurse Executive, Advanced Practice Providers [leadership]
   *** KEY RULE: ANY title where "Nursing" is the primary qualifier → Nursing Officer ***

6. "Strategy"
   INCLUDES: CSO, VP/Director Strategy, Strategic Planning, Strategic Development, Corporate Development, M&A

7. "Business Development"
   INCLUDES: VP/Director Business Development, Partnerships, Growth, Network Development, Referral Development, Director Development

8. "Innovation"
   INCLUDES: CIO, CTO, CDO, CISO, Chief Innovation, VP/Director Digital Health, Health IT, Informatics, Technology, Data Analytics, Data Science, Cybersecurity, Digital Engagement, Enterprise Applications, EHR Operations, Clinical Informatics

9. "Ambulatory/Urgent Care"
   INCLUDES: VP/Director Ambulatory Care, Outpatient Services, Urgent Care, Primary Care Operations, Telehealth, Ambulatory Surgery
   *** KEY RULE: Title must EXPLICITLY contain "Ambulatory", "Outpatient", "Urgent Care", "Primary Care", or "Telehealth" ***
   EXCLUDES: "Clinic Operations" or "Clinical Operations" → Clinical Operations

10. "Medical Officer"
    INCLUDES: CMO, Medical Director (general, no specific service line), Associate CMO, VP Medical Affairs, Chief Physician Executive
    EXCLUDES: "Medical Director, [specific service line]" → Physician Executive; CMIO → Medical Information

11. "Patient Experience"
    INCLUDES: VP/Director Patient Experience, Customer Experience, Patient Satisfaction, Patient Relations, Service Excellence, Loyalty Programs

12. "Population Health"
    INCLUDES: VP/Director Population Health, Accountable Care, Community Health, Health Equity, Social Determinants, Community Benefit

13. "Emergency Department"
    INCLUDES: Director/Medical Director Emergency Medicine, Emergency Department, ED, Trauma Director

14. "Medical Group"
    INCLUDES: Medical Group Director, Physician Practice Administrator, Group Practice, IPA, Physician Network

15. "Chief Clinical Officer"
    INCLUDES: ONLY titles literally containing "Chief Clinical Officer" or CCO

16. "Medical Information (Medical)"
    INCLUDES: CMIO, Chief Medical Information Officer, Medical Informatics Director, Clinical Informatics (physician-led)

17. "Quality Officer"
    INCLUDES: Chief Quality Officer, VP/Director Quality, Patient Safety, Accreditation, Regulatory Compliance, Risk Management, Infection Control [leadership]

18. "Access/Patient Access"
    INCLUDES: Director Patient Access, Access Management, Scheduling, Registration, Revenue Cycle Access, Transfer Center, Patient Logistics, Patient Placement, Bed Management, Patient Flow Command Center

19. "Case Management"
    INCLUDES: VP/Director Case Management, Care Coordination, Care Management, Discharge Planning, Utilization Review, Transition of Care

20. "Value Based Care"
    INCLUDES: VP/Director Value-Based Care, ACO, HEDIS, Quality Reporting, Value-Based Programs, Risk-Based Contracting

21. "Physician Executive"
    INCLUDES: Medical Directors of a SPECIFIC named clinical department (e.g. "Medical Director, Cardiology"), Department Chair, Division Chief, Section Chief

22. "Service Line"
    INCLUDES: VP/Director of a NAMED clinical service line: Cardiology, Oncology, Orthopedics, Neurology, Women's Health, Surgical Services, Cancer, Heart & Vascular, Behavioral Health, Rehabilitation, Musculoskeletal

23. "Vendor/Payor"
    INCLUDES: Insurance, pharma, vendors, consultants, investment firms — NOT a health system employee

═══ PRIORITY ORDER ═══
1. "Nursing" in title → Nursing Officer
2. "Clinical Operations" or "Clinic Operations" → Clinical Operations
3. Explicit "Ambulatory", "Outpatient", "Urgent Care" → Ambulatory/Urgent Care
4. "Chief [Function]" → functional category
5. "Operations" alone → Operating Officer
6. Specific service line named → Service Line or Physician Executive

═══ RETURN NULL FOR ═══
- Admin support (Executive Assistant, Secretary, Coordinator without Director/VP/Chief)
- Bedside clinicians with no leadership (RN, MD with NO Director/VP/Chair/Chief prefix)
- Students, interns, residents, fellows, retirees
- Confidence < 50
- Facilities / Plant Operations / Campus Planning / Real Estate roles (not a target persona)
- Supply Chain / Procurement / Purchasing / Vendor Management / Contracting roles (not a target persona)
- Environmental Services / Food Services / Hospitality / Linen / Security / Parking roles (not a target persona)
- General counsel / Legal / Compliance / Risk (unless clearly Quality Officer with patient safety focus)

═══ CONFIDENCE ═══ 90-100: Unambiguous | 70-89: Strong match | 50-69: Best guess | <50: null

Return ONLY a valid JSON array, no markdown:
[{"id":"...","persona":"exact persona name or null","confidence":0-100,"reason":"title keywords that drove classification"}]

Contacts:`;

async function classifyBatch(apiKey, batch) {
  const prompt = CLASSIFICATION_PROMPT + '\n' + JSON.stringify(batch.map(c => ({ id: c.id, title: c.title, company: c.company })));

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${t.slice(0, 200)}`);
  }

  const d = await resp.json();
  if (d.error) throw new Error(JSON.stringify(d.error));

  const raw = d.content?.[0]?.text || '[]';
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s === -1 || e === -1) throw new Error(`No JSON array: ${raw.slice(0, 150)}`);
  return JSON.parse(raw.slice(s, e + 1));
}

exports.handler = async (event) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: 'ANTHROPIC_API_KEY not set' };

  let jobId, chunkIndex;
  try {
    ({ jobId, chunkIndex } = JSON.parse(event.body));
  } catch (e) {
    return { statusCode: 400, body: 'Bad request' };
  }

  const statusPath = `${jobId}/chunks/${chunkIndex}/status.json`;
  const resultsPath = `${jobId}/chunks/${chunkIndex}/results.json`;
  const contactsPath = `${jobId}/chunks/${chunkIndex}/contacts.json`;

  try {
    // ── SAVE POINT: Check if already complete ──────────────────────────────
    const existingStatus = await readBlob(statusPath) || {};
    if (existingStatus.status === 'complete') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'already complete' }) };
    }

    // ── SAVE POINT: Resume from last written position ──────────────────────
    const existingResults = await readBlob(resultsPath) || [];
    const resumeFromIdx = existingResults.length; // How many contacts already classified

    // Read contacts
    const contacts = await readBlob(contactsPath);
    if (!contacts) throw new Error('Contacts not found in blob');

    // If we already processed everything (results exist but status wasn't updated), fix it
    if (resumeFromIdx >= contacts.length) {
      await writeBlob(statusPath, {
        chunkIndex, total: contacts.length, processed: contacts.length,
        status: 'complete',
        startedAt: existingStatus.startedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resumedAt: resumeFromIdx > 0 ? new Date().toISOString() : null,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'already fully processed' }) };
    }

    // Mark as processing, note resume point
    await writeBlob(statusPath, {
      ...existingStatus,
      status: 'processing',
      total: contacts.length,
      processed: resumeFromIdx,
      startedAt: existingStatus.startedAt || new Date().toISOString(),
      resumedAt: resumeFromIdx > 0 ? new Date().toISOString() : null,
      resumedFromIdx: resumeFromIdx > 0 ? resumeFromIdx : null,
    });

    // ── Process remaining contacts ─────────────────────────────────────────
    const results = [...existingResults];
    let processed = resumeFromIdx;
    let batchCount = 0;

    for (let i = resumeFromIdx; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      let classified = [];

      try {
        classified = await classifyBatch(apiKey, batch);
      } catch (e) {
        classified = batch.map(c => ({ id: c.id, persona: null, confidence: 0, reason: `error: ${e.message.slice(0, 50)}` }));
      }

      const merged = batch.map(c => {
        const r = classified.find(x => String(x.id) === String(c.id)) || {};
        const persona = r.persona || null;
        return {
          id: c.id, fn: c.fn, ln: c.ln, title: c.title,
          company: c.company, email: c.email,
          sp: persona, fp: persona,
          conf: r.confidence || 0, reason: r.reason || '',
          status: persona ? 'pending' : 'skipped',
        };
      });

      results.push(...merged);
      processed += batch.length;
      batchCount++;

      // Write checkpoint every WRITE_EVERY batches or on last batch
      const isLast = processed >= contacts.length;
      if (batchCount % WRITE_EVERY === 0 || isLast) {
        await writeBlob(resultsPath, results);
        await writeBlob(statusPath, {
          chunkIndex,
          total: contacts.length,
          processed,
          status: isLast ? 'complete' : 'processing',
          startedAt: existingStatus.startedAt || new Date().toISOString(),
          completedAt: isLast ? new Date().toISOString() : null,
          resumedFromIdx: resumeFromIdx > 0 ? resumeFromIdx : null,
        });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, processed, resumedFrom: resumeFromIdx }) };

  } catch (e) {
    try {
      await writeBlob(statusPath, { chunkIndex, status: 'error', error: e.message });
    } catch (_) {}
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
