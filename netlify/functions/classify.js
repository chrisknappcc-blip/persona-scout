const PERSONAS = [
  { v: "Executive/Leadership", d: "CEO, COO, CFO, President, EVP, SVP, General Counsel, C-suite, Board member, Chief of Staff" },
  { v: "Clinical Operations", d: "VP/Director Clinical Operations, Clinical Director, Service Line Operations" },
  { v: "Finance", d: "CFO, VP/Director Finance, Revenue Cycle, Controller, Reimbursement, Financial Planning" },
  { v: "Operating Officer", d: "COO, VP/Director Operations, Hospital Administration, Facility Operations" },
  { v: "Nursing Officer", d: "CNO, VP/Director Nursing, Chief Nursing, Director of Nursing, Nurse Executive" },
  { v: "Strategy", d: "CSO, VP/Director Strategy, Strategic Planning, Corporate Development" },
  { v: "Business Development", d: "VP/Director Business Development, Partnerships, Growth, Network Development, Referral" },
  { v: "Innovation", d: "CIO, CTO, CDO, Chief Innovation, VP/Director Digital Health, IT, Informatics, Data Analytics" },
  { v: "Ambulatory/Urgent Care", d: "VP/Director Ambulatory, Outpatient, Urgent Care, Primary Care Operations, Telehealth" },
  { v: "Medical Officer", d: "CMO, Medical Director (general), Associate CMO, physician leader at system level" },
  { v: "Patient Experience", d: "VP/Director Patient Experience, Customer Experience, Patient Satisfaction" },
  { v: "Population Health", d: "VP/Director Population Health, Accountable Care, Community Health, Health Equity" },
  { v: "Emergency Department", d: "Director/Medical Director Emergency Medicine, ED operations, Trauma Director" },
  { v: "Medical Group", d: "Medical Group Director, Physician Practice Administrator, IPA leadership" },
  { v: "Chief Clinical Officer", d: "Chief Clinical Officer (CCO) specifically" },
  { v: "Medical Information (Medical)", d: "CMIO, Chief Medical Information Officer, Medical Informatics Director" },
  { v: "Quality Officer", d: "Chief Quality Officer, VP/Director Quality, Patient Safety, Accreditation, Risk Management" },
  { v: "Access/Patient Access", d: "Director Patient Access, Access Management, Scheduling, Registration" },
  { v: "Case Management", d: "VP/Director Case Management, Care Coordination, Discharge Planning, Utilization Review" },
  { v: "Value Based Care", d: "VP/Director Value-Based Care, ACO leadership, HEDIS, Quality Reporting" },
  { v: "Physician Executive", d: "Physician executives, Department Medical Directors, Division Chiefs" },
  { v: "Service Line", d: "VP/Director specific clinical service line: Cardiology, Oncology, Orthopedics, Neurology, Women's Health, Surgical" },
  { v: "Vendor/Payor", d: "Insurance, pharma, vendor, consultant, investment firm — NOT a health system employee" },
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }),
    };
  }

  let contacts;
  try {
    ({ contacts } = JSON.parse(event.body));
    if (!Array.isArray(contacts) || contacts.length === 0) throw new Error("No contacts");
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: `Bad request: ${e.message}` }),
    };
  }

  const pList = PERSONAS.map((p, i) => `${i + 1}. "${p.v}": ${p.d}`).join("\n");
  const prompt = `You classify healthcare professionals for Care Continuity, a referral analytics company selling to health systems.

PERSONAS — use the EXACT quoted name:
${pList}

Rules:
- Classify primarily from job title; use company as context
- Health system employees only — if clearly a vendor/payer/pharma/consultant → "Vendor/Payor"
- Return null for: admin support staff, pure bedside clinicians (RN, MD with no leadership), overly vague titles, students, retirees
- Confidence: 90-100=obvious, 70-89=likely, 50-69=best guess, below 50 → null

Return ONLY a JSON array, no markdown or explanation:
[{"id":"...","persona":"exact name or null","confidence":0-100,"reason":"short phrase"}]

Contacts:
${JSON.stringify(contacts.map(c => ({ id: c.id, title: c.title, company: c.company })))}`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${txt.slice(0, 300)}`);
    }

    const data = await resp.json();
    if (data.error) throw new Error(JSON.stringify(data.error));

    const raw = data.content?.[0]?.text || "[]";
    const s = raw.indexOf("["), e = raw.lastIndexOf("]");
    if (s === -1 || e === -1) throw new Error(`No JSON array in response: ${raw.slice(0, 200)}`);
    const results = JSON.parse(raw.slice(s, e + 1));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ results }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
