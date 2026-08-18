const CONTAINER = 'persona-scout';
const ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT_NAME || 'carepathiqdata';
const BATCH_SIZE = 20;
const WRITE_EVERY = 5;

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

// ─── CLASSIFICATION PROMPT ────────────────────────────────────────────────────
const PROMPT = `You are a healthcare sales classifier for Care Continuity, a referral analytics platform sold to health systems. You identify decision-makers and influencers in health system leadership.

CRITICAL SENIORITY RULE: Only classify contacts at Director level or above.
Return null for: Manager, Coordinator, Specialist, Analyst, Associate (without Director prefix), Supervisor, Lead, staff-level nurses (RN/LPN/CNA), staff-level physicians (MD/DO with no Director/Chair/Chief/VP prefix), residents, fellows, students, interns, administrative assistants, secretaries, retirees, volunteers.
"Associate Director" and "Assistant Director" are acceptable. "Manager" alone is not.

━━━ PERSONAS (use EXACT names shown) ━━━

"Executive Officer"
INCLUDES: CEO, COO (see Operating Officer), CFO (see Finance Officer), President, Group President, Regional President, System President, Hospital President, EVP, SVP (standalone, no functional qualifier), General Counsel (system-level), Chief of Staff, Chief Administrative Officer, Board Chair, Board Member, Trustee, Executive Chair
ABBREVS: CEO, CAO (admin), EVP, SVP
✗ NOT HERE: SVP/VP with functional qualifier → use that function's persona; CNO → Nursing Officer; CMO → Medical Officer; CIO → Innovation Officer; CFO → Finance Officer; CSO → Strategy Officer; CQO → Chief Quality Officer; CCO → Chief Clinical Officer; CMIO → Medical Information Officer

"Clinical Operations"
INCLUDES: "Clinical Operations", "Clinic Operations", "Clinical Services", "Clinical Programs", "Clinical Excellence", "Clinical Director" (no specific service line), "Clinical Integration", "Clinical Practice", "Clinical Affairs"
KEY RULE: "Clinic Operations" and "Director, Clinical Operations" = this persona. Do NOT send to Ambulatory.
✗ NOT HERE: Nursing Operations → Nursing Officer; Ambulatory/Outpatient → Ambulatory; Plant/Facility → null

"Finance Officer"
INCLUDES: CFO, Controller, Comptroller, VP/Director Finance, Revenue Cycle, Revenue Integrity, Reimbursement, Budget, Accounting, Treasurer, Financial Planning, Charge Capture, Coding, Billing, Government Programs (finance context), HIM (coding/billing focus)
ABBREVS: CFO, CAO (finance)
Director-level minimum: VP Finance, Director Finance, Regional Director Finance

"Operating Officer"
INCLUDES: COO, VP/Director Operations (NO clinical qualifier), Hospital Operations
"Director, Operations" with NO qualifier = this persona
✗ NOT HERE: Clinical Operations → Clinical Operations; Nursing Operations → Nursing Officer; Ambulatory → Ambulatory; Facilities/Supply Chain/Environmental Services → null

"Nursing Officer"
INCLUDES: CNO, VP/Director Nursing, Chief Nursing, Director of Nursing, Nursing Operations, Nursing Services, Nursing Excellence, Nursing Practice, Nursing Support Services, Nurse Executive, Advanced Practice Providers (Director-level+), APP Director, APRN Director, Perioperative Nursing (Director+)
ABBREVS: CNO, ACNO
ANY title where "Nursing" is the primary qualifier = this persona

"Strategy Officer"
INCLUDES: CSO, VP/Director Strategy, Strategic Planning, Corporate Development, Strategic Initiatives, Business Strategy, Strategic Growth, Long-Range Planning, Enterprise Strategy, Strategic Operations
ABBREVS: CSO

"Business Development"
INCLUDES: VP/Director Business Development, Network Development, Referral Development, Physician Relations, Physician Outreach, Physician Liaison, Market Development, Growth (BD context), Partnerships, Service Development, Outreach Programs
Director-level minimum: VP BD, Director BD, Director Physician Relations

"Innovation Officer"
INCLUDES: CIO, CTO, CDO (Chief Digital Officer), CISO, Chief Innovation Officer, VP/Director Information Technology, VP/Director Digital Health, VP/Director Digital Transformation, VP/Director Information Systems, VP/Director Health IT, Director/VP Informatics (non-physician), Director/VP Cybersecurity, VP/Director Information Security, VP/Director Enterprise Applications, Director EHR, Director Epic, Director Telehealth (technology focus)
ABBREVS: CIO, CTO, CDO (digital), CISO
✗ NOT HERE: CMIO/Medical Director Informatics → Medical Information Officer; Data Analytics/Business Intelligence → Analytics

"Analytics"
INCLUDES: Chief Analytics Officer, VP/Director Analytics, VP/Director Data Analytics, VP/Director Business Analytics, VP/Director Business Intelligence, VP/Director Data Science, VP/Director Enterprise Analytics, VP/Director Clinical Analytics, VP/Director Health Analytics, VP/Director Population Health Analytics, Chief Data Officer (data/analytics focus — not IT infrastructure)
ABBREVS: CAO (analytics context)
KEY DISTINCTION: Analytics = data analysis, reporting, BI, data science. Innovation Officer = IT systems, digital health platforms, technology infrastructure.

"Ambulatory"
INCLUDES: VP/Director Ambulatory Care, VP/Director Ambulatory Services, VP/Director Ambulatory Operations, VP/Director Outpatient Services, VP/Director Outpatient Operations, VP/Director Primary Care Operations, VP/Director Primary Care Services, VP/Director Telehealth (clinical/patient care focus)
KEYWORD RULE: Title must EXPLICITLY contain "Ambulatory", "Outpatient", or "Primary Care"
✗ NOT HERE: "Clinic Operations" → Clinical Operations; "Urgent Care" → Urgent Care (separate persona)

"Urgent Care"
INCLUDES: VP/Director Urgent Care, VP/Director Urgent Care Operations, Medical Director Urgent Care, Director Walk-In Care, VP/Director Retail Health (urgent care context), Director Convenient Care, VP/Director Immediate Care
KEYWORD RULE: Title must EXPLICITLY contain "Urgent Care", "Walk-In", "Retail Health", or "Immediate Care"

"Medical Group"
INCLUDES: President/CEO/Administrator Medical Group, Director Medical Group Operations, VP/Director Physician Practice, VP/Director Physician Practices, VP/Director Group Practice, Director IPA, Medical Foundation Director/Administrator, VP/Director Physician Network (practice management context)
✗ NOT HERE: VP Physician Relations → Business Development; VP Physician Services (clinical leadership) → Medical Officer

"Medical Information Officer"
INCLUDES: CMIO, Chief Medical Information Officer, Chief Medical Informatics Officer, Medical Director Informatics, Medical Director Health IT, Medical Director EHR, VP Medical Informatics, Director Medical Informatics
ABBREVS: CMIO
Physician-led informatics only. Non-physician IT/informatics roles → Innovation Officer.

"Medical Officer"
INCLUDES: CMO, Chief Medical Officer, Associate CMO, Deputy CMO, VP Medical Affairs, SVP Medical Affairs, Chief Physician Executive (system-level), Medical Director (NO specific department)
ABBREVS: CMO, ACMO
✗ NOT HERE: Medical Director + specific department (Cardiology, Oncology, etc.) → Chief Physician Executive; CMIO → Medical Information Officer

"Patient Access"
INCLUDES: VP/Director Patient Access, VP/Director Access Management, Director Admitting, Director Registration, Director Scheduling, Director Centralized Scheduling, Director Transfer Center, Director Patient Placement, Director Patient Logistics, Director Bed Management, Director Patient Flow, Director Patient Flow Command Center, Director Prior Authorization, Director Financial Clearance, Director Pre-Service
Director-level minimum required.

"Patient Experience"
INCLUDES: VP/Director Patient Experience, Chief Experience Officer (patient context), VP/Director Customer Experience, VP/Director Service Excellence, VP/Director Patient Satisfaction, VP/Director Patient Relations, VP/Director Patient Advocacy, VP/Director Patient Engagement, Director Loyalty Programs
Director-level minimum required.

"Population Health"
INCLUDES: VP/Director Population Health, Chief Population Health Officer, VP/Director Community Health, VP/Director Health Equity, VP/Director Social Determinants, VP/Director SDOH, VP/Director Community Benefit, Chief Community Health Officer, VP/Director Accountable Care (community/population focus), VP/Director Community Wellness
✗ NOT HERE: ACO ops with HEDIS/payer contracting focus → Value Based Care

"ED Contact"
INCLUDES: Medical Director Emergency Medicine, Medical Director ED/ER, Director Emergency Department, Director Emergency Medicine, Director Emergency Services, Chair of Emergency Medicine, Chief of Emergency Medicine, VP Emergency Services
Director-level or physician leadership minimum.
✗ NOT HERE: Director Emergency Management (disaster preparedness) → null

"Chief Clinical Officer"
ONLY: Titles literally containing "Chief Clinical Officer" or CCO (clinical context). Nothing else qualifies.

"Chief Quality Officer"
INCLUDES: Chief Quality Officer, CQO, VP/Director Quality, VP/Director Patient Safety, VP/Director Quality Improvement, VP/Director Quality Management, VP/Director Accreditation, VP/Director Regulatory Affairs, VP/Director Infection Control (Director+), VP/Director Infection Prevention, VP/Director Performance Improvement, VP/Director Process Improvement, VP/Director Risk Management (clinical/patient safety focus), VP/Director Clinical Quality, Director Lean/Six Sigma (healthcare), VP/Director Compliance (patient safety focus)
ABBREVS: CQO
✗ NOT HERE: General corporate/legal compliance → null; IT security/risk → Innovation Officer

"Chief Physician Executive"
INCLUDES: Medical Director WITH a specific named department or specialty: Medical Director Cardiology, Medical Director Oncology, Medical Director Orthopedics, Medical Director Neurology, Medical Director Radiology, Medical Director Anesthesia, Medical Director Surgery, Medical Director Pediatrics, Medical Director OB/GYN, Medical Director Psychiatry, Medical Director Behavioral Health, Medical Director ICU/Critical Care, Medical Director NICU, Medical Director Rehabilitation, Medical Director Stroke, Medical Director Transplant, Medical Director Palliative Care, Medical Director Hospice, Medical Director Laboratory, Medical Director Radiation Oncology, Medical Director Interventional Cardiology, Medical Director Electrophysiology, Medical Director Vascular, Medical Director Gastroenterology, Medical Director Pulmonology, Medical Director Wound Care, Medical Director PACU, Medical Director Urgent Care, Medical Director Emergency Medicine → ED Contact
Also: Department Chair (any specialty), Division Chief (any specialty), Section Chief (any specialty), Associate Medical Director (specific department)
KEY RULE: Medical Director + department name = Chief Physician Executive; Medical Director alone (no department) = Medical Officer

"Case Management"
INCLUDES: VP/Director Case Management, VP/Director Care Management, VP/Director Care Coordination, VP/Director Utilization Management, VP/Director Utilization Review, VP/Director Discharge Planning, VP/Director Social Work (healthcare), VP/Director Transitions of Care, VP/Director Complex Care, VP/Director Post-Acute Care
Director-level minimum required.

"Service Line"
INCLUDES: VP/Director of a NAMED clinical service line (non-physician, administrative leadership):
Cardiology/Heart & Vascular, Oncology/Cancer, Orthopedics/Musculoskeletal/Spine, Neuroscience/Neurology, Women's Health/OB/Maternal, Surgical Services/Perioperative, Behavioral Health/Psychiatry/Mental Health, Rehabilitation/Physical Medicine, Digestive Health/GI/Gastroenterology, Pulmonary/Respiratory, Trauma, Transplant, Wound Care, Palliative/Hospice, Home Health
Examples: VP Cardiovascular Services, Director Cancer Services, VP Orthopedic Service Line, Director Behavioral Health Services, VP Surgical Services, Director Perioperative Services
✗ NOT HERE: Medical Director [service line] → Chief Physician Executive (physician-led)

"Value Based Care"
INCLUDES: VP/Director Value Based Care, VP/Director Accountable Care (HEDIS/payer contracting focus), CEO/Director ACO, VP/Director Bundled Payments, VP/Director HEDIS, VP/Director Quality Reporting (payer-facing), VP/Director Risk Contracting, VP/Director CMS Programs, VP/Director MSSP, VP/Director Alternative Payment Models
✗ NOT HERE: Community health focus → Population Health

━━━ PRIORITY DISAMBIGUATION ━━━
1. "Nursing" as primary qualifier → Nursing Officer
2. "Clinical Operations" or "Clinic Operations" → Clinical Operations (NOT Ambulatory)
3. "Ambulatory" or "Outpatient" or "Primary Care" explicitly → Ambulatory
4. "Urgent Care" or "Walk-In" explicitly → Urgent Care
5. Medical Director + department name → Chief Physician Executive
6. Medical Director alone → Medical Officer
7. "Operations" alone, no qualifier → Operating Officer
8. Analytics/BI/Data Science → Analytics; IT/Digital/Information Systems → Innovation Officer
9. Named clinical service line + VP/Director (non-physician) → Service Line

━━━ RETURN NULL FOR ━━━
SENIORITY: Manager, Coordinator, Specialist, Analyst (not Director Analytics), Supervisor, Lead, staff-level clinicians
CLINICAL (non-leadership): RN, Registered Nurse, LPN, CNA, Physician/MD/DO with NO Director/VP/Chair/Chief prefix, Nurse Practitioner/NP/PA without leadership prefix, Resident, Fellow
EXCLUDED FUNCTIONS (no persona exists for these):
- Facilities, Plant Operations, Campus Planning, Real Estate, Construction
- Supply Chain, Procurement, Purchasing, Vendor Management, Materials Management
- Environmental Services, Housekeeping, Food Services, Hospitality, Linen, Security, Parking
- Human Resources, Talent Acquisition, Recruiting, Compensation & Benefits
- Marketing, Communications, Public Relations, Social Media, Brand
- Legal (non-system-level General Counsel), Attorney, Compliance (non-clinical)
- IT Support, Help Desk, Systems Administrator (below Director level)
- Administrative Assistant, Executive Assistant, Secretary, Office Manager

━━━ CONFIDENCE ━━━
90-100: Keyword unambiguously maps to one persona and meets seniority threshold
70-89: Strong match, minor uncertainty on persona or seniority
50-69: Best interpretation with notable uncertainty
< 50: Return null

Return ONLY a valid JSON array, no markdown, no preamble:
[{"id":"...","persona":"exact persona name","confidence":0-100,"reason":"title keywords that drove this — note if seniority concern"}]

Contacts:`;

async function classifyBatch(apiKey, batch) {
  const prompt = PROMPT + '\n' + JSON.stringify(batch.map(c => ({ id: c.id, title: c.title, company: c.company })));
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
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Anthropic ${resp.status}: ${t.slice(0, 200)}`); }
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
  try { ({ jobId, chunkIndex } = JSON.parse(event.body)); }
  catch (e) { return { statusCode: 400, body: 'Bad request' }; }

  const statusPath  = `${jobId}/chunks/${chunkIndex}/status.json`;
  const resultsPath = `${jobId}/chunks/${chunkIndex}/results.json`;
  const contactsPath = `${jobId}/chunks/${chunkIndex}/contacts.json`;

  try {
    const existingStatus = await readBlob(statusPath) || {};
    if (existingStatus.status === 'complete') {
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'already complete' }) };
    }

    const existingResults = await readBlob(resultsPath) || [];
    const resumeFromIdx = existingResults.length;
    const contacts = await readBlob(contactsPath);
    if (!contacts) throw new Error('Contacts not found in blob');

    if (resumeFromIdx >= contacts.length) {
      await writeBlob(statusPath, { chunkIndex, total: contacts.length, processed: contacts.length, status: 'complete', startedAt: existingStatus.startedAt || new Date().toISOString(), completedAt: new Date().toISOString() });
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'already fully processed' }) };
    }

    await writeBlob(statusPath, { ...existingStatus, status: 'processing', total: contacts.length, processed: resumeFromIdx, startedAt: existingStatus.startedAt || new Date().toISOString(), resumedFromIdx: resumeFromIdx > 0 ? resumeFromIdx : null });

    const results = [...existingResults];
    let processed = resumeFromIdx, batchCount = 0;

    for (let i = resumeFromIdx; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      let classified = [];
      try { classified = await classifyBatch(apiKey, batch); }
      catch (e) { classified = batch.map(c => ({ id: c.id, persona: null, confidence: 0, reason: `error: ${e.message.slice(0, 50)}` })); }

      const merged = batch.map(c => {
        const r = classified.find(x => String(x.id) === String(c.id)) || {};
        const persona = r.persona || null;
        return { id: c.id, fn: c.fn, ln: c.ln, title: c.title, company: c.company, email: c.email, sp: persona, fp: persona, conf: r.confidence || 0, reason: r.reason || '', status: persona ? 'pending' : 'skipped' };
      });

      results.push(...merged);
      processed += batch.length;
      batchCount++;

      const isLast = processed >= contacts.length;
      if (batchCount % WRITE_EVERY === 0 || isLast) {
        await writeBlob(resultsPath, results);
        await writeBlob(statusPath, { chunkIndex, total: contacts.length, processed, status: isLast ? 'complete' : 'processing', startedAt: existingStatus.startedAt || new Date().toISOString(), completedAt: isLast ? new Date().toISOString() : null, resumedFromIdx: resumeFromIdx > 0 ? resumeFromIdx : null });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, processed, resumedFrom: resumeFromIdx }) };
  } catch (e) {
    try { await writeBlob(statusPath, { chunkIndex, status: 'error', error: e.message }); } catch (_) {}
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
