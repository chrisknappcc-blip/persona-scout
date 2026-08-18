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

const CLASSIFICATION_PROMPT = `You are a precise healthcare executive classifier for Care Continuity, a referral analytics platform sold to health systems. Misclassifications waste sales effort — accuracy is critical.

TASK: Classify each contact's job title into exactly ONE persona. A title that doesn't clearly fit any persona should return null.

═══ PERSONAS ═══

"Executive/Leadership"
  ABBREVS: CEO, COO, CFO, CHRO, CLO, CAO
  KEYWORD TRIGGERS (title contains any of these): Chief Executive, Chief Operating, Chief Financial, Chief Administrative, Chief Human Resources, Chief People, Chief Legal, Chief Compliance, Chief of Staff, General Counsel, Board Chair, Board Member, Trustee, Chairman, Chairwoman
  ✗ NOT HERE: SVP/VP WITH functional qualifier (e.g. SVP Operations → Operating Officer)
  ✗ NOT HERE: Chief Nursing Officer → Nursing Officer
  ✗ NOT HERE: Chief Medical Officer → Medical Officer
  ✗ NOT HERE: Chief Information Officer → Innovation
  ✗ NOT HERE: Chief Digital Officer → Innovation
  ✗ NOT HERE: Chief Quality Officer → Quality Officer
  ✗ NOT HERE: Chief Clinical Officer → Chief Clinical Officer
  ✗ NOT HERE: Chief Medical Information Officer → Medical Information

"Clinical Operations"
  KEYWORD TRIGGERS (title contains any of these): Clinical Operations, Clinic Operations, Clinical Services, Clinical Programs, Clinical Excellence, Clinical Performance, Clinical Director, Clinical Integration, Clinical Practice, Clinical Effectiveness, Clinical Affairs
  ✗ NOT HERE: Nursing Operations → Nursing Officer
  ✗ NOT HERE: Ambulatory/Outpatient/Clinic Operations where 'Clinic' = outpatient clinic → still Clinical Operations NOT Ambulatory
  ✗ NOT HERE: Director, Clinic Operations → Clinical Operations (NOT Ambulatory)
  ✗ NOT HERE: Plant/Facility Operations → NULL
  ✗ NOT HERE: Director, [specific service line] Operations → Service Line

"Finance"
  KEYWORD TRIGGERS (title contains any of these): Financial, Finance, Revenue Cycle, Reimbursement, Controller, Comptroller, Treasury, Treasurer, Budget, Accounting, Accounts, Revenue Integrity, Charge Capture, Coding, Billing, Managed Care (finance)
  ✗ NOT HERE: Patient Financial Services (registration/access focus) → Access/Patient Access
  ✗ NOT HERE: Chief Financial Officer of a vendor/pharma company → Vendor/Payor

"Operating Officer"
  ABBREVS: COO, Chief Operating Officer
  KEY RULE: Director Operations WITH qualifier goes to qualifier's category. Without any qualifier = Operating Officer.
  ✗ NOT HERE: Clinical Operations → Clinical Operations
  ✗ NOT HERE: Nursing Operations → Nursing Officer
  ✗ NOT HERE: VP Operations, Ambulatory → Ambulatory/Urgent Care
  ✗ NOT HERE: Facilities/Plant/Campus Operations → NULL
  ✗ NOT HERE: Supply Chain/Procurement → NULL
  ✗ NOT HERE: Environmental Services → NULL
  ✗ NOT HERE: Food Services/Hospitality → NULL
  ✗ NOT HERE: Security Operations → NULL

"Nursing Officer"
  KEYWORD TRIGGERS (title contains any of these): Nursing, Nurse Executive, Patient Care Services, Advanced Practice, APP, APRN, Nurse Practitioner, Perioperative Nursing, Nursing Practice, Nursing Excellence, Nursing Informatics, Clinical Nurse
  KEY RULE: ANY title with 'Nursing' as the primary qualifier = Nursing Officer, even if 'Operations' also appears

"Strategy"
  KEYWORD TRIGGERS (title contains any of these): Strategy, Strategic Planning, Strategic Development, Corporate Development, Strategic Initiatives, Business Strategy, Strategic Growth, Strategic Partnerships, Strategic Operations, Long-Range Planning, System Planning, Enterprise Strategy

"Business Development"
  KEYWORD TRIGGERS (title contains any of these): Business Development, Network Development, Referral Development, Physician Relations, Referral Relations, Referring Physician, Market Development, Growth, Partnerships, Strategic Partnerships, Physician Outreach, Physician Liaison, Outreach, Community Relations, Physician Development, Service Development

"Innovation"
  ABBREVS: CIO, CTO, CDO, CISO, CMIO
  KEYWORD TRIGGERS (title contains any of these): Information Technology, Information Systems, Health IT, Digital Health, Digital Transformation, Technology, Informatics, Data Analytics, Business Intelligence, Cybersecurity, Information Security, Enterprise Applications, EHR, Epic, Health Information, Telehealth Technology, Innovation, Data Science, Artificial Intelligence, AI
  ✗ NOT HERE: CMIO/Chief Medical Information Officer → Medical Information (Medical)
  ✗ NOT HERE: Medical Director Informatics → Medical Information (Medical)
  ✗ NOT HERE: Director of Innovation Programs (operational) → may be Clinical Operations or Strategy

"Ambulatory/Urgent Care"
  KEYWORD TRIGGERS (title contains any of these): Ambulatory, Outpatient, Urgent Care, Primary Care, Telehealth (clinical ops), Ambulatory Surgery, Ambulatory Services
  KEY RULE: Title MUST explicitly contain Ambulatory, Outpatient, Urgent Care, Primary Care, or Telehealth. 'Clinic Operations' alone is NOT sufficient.
  ✗ NOT HERE: Director Clinic Operations → Clinical Operations (NOT Ambulatory)
  ✗ NOT HERE: Director Clinical Operations → Clinical Operations

"Medical Officer"
  ABBREVS: CMO, ACMO
  KEYWORD TRIGGERS (title contains any of these): Chief Medical, Medical Affairs, Physician Executive (system-level)
  ✗ NOT HERE: Medical Director, [specific department name] → Physician Executive
  ✗ NOT HERE: Chief Medical Information Officer → Medical Information (Medical)
  ✗ NOT HERE: Medical Director of Informatics → Medical Information (Medical)
  ✗ NOT HERE: Medical Director Emergency Medicine → Emergency Department

"Patient Experience"
  KEYWORD TRIGGERS (title contains any of these): Patient Experience, Customer Experience, Patient Satisfaction, Service Excellence, Patient Relations, Patient Advocacy, Patient Engagement, Loyalty Programs, Experience Design, Patient-Centered

"Population Health"
  KEYWORD TRIGGERS (title contains any of these): Population Health, Community Health, Health Equity, Social Determinants, SDOH, Community Benefit, Accountable Care (community focus), Public Health, Community Wellness, Health Disparities, Social Impact
  ✗ NOT HERE: VP Accountable Care (HEDIS/payer contracting focus) → Value Based Care
  ✗ NOT HERE: Director ACO Operations (contracting focus) → Value Based Care

"Emergency Department"
  KEYWORD TRIGGERS (title contains any of these): Emergency Medicine, Emergency Department, Emergency Services, Emergency Care, Trauma, ED, ER, Emergency Operations (clinical)

"Medical Group"
  KEYWORD TRIGGERS (title contains any of these): Medical Group, Physician Practice, Physician Group, Group Practice, IPA, Physician Organization, Physician Network (admin), Physician Services (practice management), Medical Foundation
  ✗ NOT HERE: VP Physician Relations → Business Development
  ✗ NOT HERE: Director Physician Liaison → Business Development
  ✗ NOT HERE: VP Physician Services (system clinical leadership) → Medical Officer

"Chief Clinical Officer"
  KEYWORD TRIGGERS (title contains any of these): Chief Clinical Officer, CCO
  KEY RULE: EXTREMELY specific. Only 'Chief Clinical Officer' qualifies. Chief Clinical Operations Officer → Clinical Operations.

"Medical Information (Medical)"
  ABBREVS: CMIO
  KEYWORD TRIGGERS (title contains any of these): Medical Information, Medical Informatics, Clinical Informatics (physician-led), Chief Medical Information, Chief Medical Informatics
  KEY RULE: Physician-led informatics only. Non-physician informatics → Innovation.

"Quality Officer"
  KEYWORD TRIGGERS (title contains any of these): Quality, Patient Safety, Accreditation, Regulatory, Infection Control, Performance Improvement, Process Improvement, Joint Commission, Compliance (clinical/patient safety), Risk Management (clinical), Quality Improvement, Quality Management
  ✗ NOT HERE: Chief Compliance Officer (general corporate/legal) → null or Executive/Leadership
  ✗ NOT HERE: Chief Risk Officer (financial/enterprise) → null
  ✗ NOT HERE: Director IT Risk/Security → Innovation

"Access/Patient Access"
  KEYWORD TRIGGERS (title contains any of these): Patient Access, Access Management, Registration, Admitting, Scheduling, Centralized Scheduling, Transfer Center, Patient Placement, Patient Logistics, Bed Management, Patient Flow, Access Services, Prior Authorization, Pre-Registration, Pre-Authorization, Revenue Cycle Access

"Case Management"
  KEYWORD TRIGGERS (title contains any of these): Case Management, Care Management, Care Coordination, Utilization Management, Utilization Review, Discharge Planning, Social Work (healthcare), Social Services (healthcare), Transitions of Care, Post-Acute, Care Transitions, Complex Care

"Value Based Care"
  KEYWORD TRIGGERS (title contains any of these): Value Based Care, Value-Based Care, Accountable Care Organization, ACO, Bundled Payments, HEDIS, Quality Reporting, Risk Contracting, Risk-Based, Value-Based Programs, CMS Programs, MSSP, Alternative Payment, Population Health Programs (VBC focus)

"Physician Executive"
  KEY RULE: Medical Director WITH a specific department name. Chair/Chief/Division of a specific clinical specialty.

"Service Line"
  KEYWORD TRIGGERS (title contains any of these): Heart, Cardiac, Cardiology, Cardiovascular, Oncology, Cancer, Orthopedic, Musculoskeletal, Neuroscience, Neuro, Women's Health, Obstetrics, Maternal, Surgical Services, Surgery, Behavioral Health, Psychiatry, Mental Health, Rehabilitation, Physical Therapy
  KEY RULE: VP/Director/Senior Director of a named clinical service line — administrative leadership, not physician
  ✗ NOT HERE: Medical Director [service line] → Physician Executive (physician-led)
  ✗ NOT HERE: Chair [specialty] → Physician Executive

═══ PRIORITY DISAMBIGUATION RULES ═══
1. "Nursing" anywhere as primary qualifier → Nursing Officer (beats Clinical Ops, Operating Officer)
2. "Clinical Operations" or "Clinic Operations" → Clinical Operations (beats Ambulatory — "clinic" ≠ ambulatory)
3. "Ambulatory", "Outpatient", "Urgent Care", "Primary Care" explicit in title → Ambulatory/Urgent Care
4. "Medical Director, [department name]" → Physician Executive (not Medical Officer)
5. "Medical Director" alone (no department) → Medical Officer
6. "Chief [Function]" → the functional category (Chief Nursing → Nursing Officer, Chief Medical → Medical Officer)
7. "Operations" alone, no qualifier → Operating Officer
8. Named clinical service line + VP/Director (non-physician) → Service Line

═══ RETURN NULL FOR ═══
These are not target personas — return null even for senior titles:
  - Facilities / Real Estate / Campus Planning
  - Supply Chain / Procurement / Purchasing / Contracting (non-clinical)
  - Environmental Services / Housekeeping / Linen / Laundry
  - Food Services / Nutrition Services / Hospitality / Culinary
  - Security / Public Safety / Parking
  - Human Resources / Talent Acquisition / Workforce / Benefits / Compensation
  - Marketing / Communications / Public Relations / Brand
  - Legal / General Counsel (unless system-level Executive/Leadership)
  - Finance (vendor/pharma company → Vendor/Payor)
  - Fundraising / Philanthropy (foundation only, not health system BD)
  - Administrative Support (Executive Assistant, Secretary, Coordinator, Scheduler at non-director level)
  - Bedside Clinical (RN, LPN, CNA, Physician/MD with no leadership prefix, NP/PA with no leadership prefix)
  - Education / Academic (Professor, Instructor, Resident, Fellow, Student)
  - Research (Researcher, Principal Investigator, Research Coordinator — no leadership title)
  - Retired / Former / Emeritus
Specific patterns to exclude: Plant Operations, Facilities Management, Facility Operations, Campus Planning, Real Estate, Construction, Capital Projects, Supply Chain, Procurement, Purchasing, Vendor Management, Contracting (non-clinical), Materials Management, Environmental Services, Housekeeping, EVS, Food Service, Food & Nutrition, Culinary, Cafeteria, Hospitality Services, Guest Services, Linen Services, Laundry, Textile, Security, Public Safety, Parking, Human Resources, HR, Talent Acquisition, Recruiting, Workforce Development (HR context), Compensation & Benefits, Marketing, Communications, Public Relations, Brand, Media Relations, Social Media

Also null: Admin support (Executive/Administrative Assistant, Coordinator, Secretary without VP/Director/Chief prefix), bedside clinicians (RN, MD, NP, PA with NO leadership prefix), students/residents/fellows/interns, retirees, titles with confidence < 50

═══ CONFIDENCE ═══
90-100: Keyword unambiguously maps to exactly one persona
70-89: Strong match, minor uncertainty
50-69: Best interpretation with meaningful uncertainty
< 50: Return null — do not guess

Return ONLY a valid JSON array, no markdown, no preamble:
[{"id":"...","persona":"exact persona name or null","confidence":0-100,"reason":"the specific title keywords that drove this classification"}]

Contacts to classify:`;

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
