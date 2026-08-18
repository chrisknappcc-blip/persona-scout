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

  const prompt = `You are a precise healthcare executive classifier for Care Continuity, a referral analytics platform sold to health systems. Accuracy matters — misclassifications waste sales effort.

TASK: Classify each contact's job title into exactly ONE persona. Read every disambiguation rule before classifying.

═══ PERSONAS WITH DISAMBIGUATION ═══

1. "Executive/Leadership"
   INCLUDES: CEO, COO, CFO, CNO, CMO, CIO, CTO, CSO, CDO, CISO, President, EVP, SVP (standalone), General Counsel, Board member, Chief of Staff, Group President, Regional President, Chair
   EXCLUDES: VP/SVP/Director WITH a functional qualifier (those go to the functional category)

2. "Clinical Operations"
   INCLUDES: Titles containing "Clinical Operations", "Clinic Operations", "Clinical Director" (no specific service line), "Director of Clinical Services", "Director Clinical [anything]"
   *** KEY RULE: "Clinic Operations" = Clinical Operations. Do NOT classify as Ambulatory just because "clinic" sounds outpatient. ***
   EXCLUDES: "Nursing Operations" → Nursing Officer; "Plant/Facility/Environmental Operations" → Operating Officer; explicit "Ambulatory/Outpatient" → Ambulatory/Urgent Care

3. "Finance"
   INCLUDES: CFO, VP/Director Finance, Revenue Cycle, Controller, Reimbursement, Revenue Integrity, Financial Planning, Budget, Accounting, Treasurer, Chief Accounting Officer, Government Finance, Finance & Budget

4. "Operating Officer"
   INCLUDES: COO, VP/Director Operations (NO clinical qualifier), Hospital Operations, Facility Operations, Plant Operations, Environmental Services, Supply Chain, Logistics, Food Services, Hospitality, Security, Linen, Facilities Management, Campus Planning
   *** KEY RULE: "Director, Operations" with NO qualifier = Operating Officer ***
   EXCLUDES: "Clinical Operations" → Clinical Operations; "Nursing Operations" → Nursing Officer

5. "Nursing Officer"
   INCLUDES: CNO, VP/Director Nursing, Chief Nursing, Director of Nursing, Nursing Operations, Nursing Services, Nursing Excellence, Nursing Practice, Nursing Support Services, Nurse Executive, Advanced Practice Providers [leadership], Perioperative Nursing [leadership]
   *** KEY RULE: ANY title where "Nursing" is the primary qualifier → Nursing Officer, even if "Operations" also appears ***

6. "Strategy"
   INCLUDES: CSO, VP/Director Strategy, Strategic Planning, Strategic Development, Corporate Development, M&A

7. "Business Development"
   INCLUDES: VP/Director Business Development, Partnerships, Growth, Network Development, Referral Development, Director Development (philanthropy or BD context in health systems)

8. "Innovation"
   INCLUDES: CIO, CTO, CDO, CISO, Chief Innovation, VP/Director Digital Health, Health IT, Informatics, Technology, Data Analytics, Data Science, Cybersecurity, Digital Engagement, Enterprise Applications, EHR Operations, Clinical Informatics, System Director Clinical Informatics

9. "Ambulatory/Urgent Care"
   INCLUDES: VP/Director Ambulatory Care, Outpatient Services, Urgent Care, Primary Care Operations, Telehealth, Ambulatory Surgery
   *** KEY RULE: Title must EXPLICITLY contain "Ambulatory", "Outpatient", "Urgent Care", "Primary Care", or "Telehealth" ***
   EXCLUDES: "Clinic Operations" or "Clinical Operations" → Clinical Operations

10. "Medical Officer"
    INCLUDES: CMO, Medical Director (general, no specific service line named), Associate CMO, VP Medical Affairs, Chief Physician Executive
    EXCLUDES: "Medical Director, [Cardiology/Oncology/etc]" → Physician Executive; CMIO roles → Medical Information

11. "Patient Experience"
    INCLUDES: VP/Director Patient Experience, Customer Experience, Patient Satisfaction, Patient Relations, Service Excellence, Loyalty Programs

12. "Population Health"
    INCLUDES: VP/Director Population Health, Accountable Care, Community Health, Health Equity, Social Determinants, Community Benefit

13. "Emergency Department"
    INCLUDES: Director/Medical Director Emergency Medicine, Emergency Department, ED, Trauma Director

14. "Medical Group"
    INCLUDES: Medical Group Director, Physician Practice Administrator, Group Practice, IPA, Physician Network, Practice Operations (medical group context)

15. "Chief Clinical Officer"
    INCLUDES: ONLY titles literally containing "Chief Clinical Officer" or CCO in a clinical context

16. "Medical Information (Medical)"
    INCLUDES: CMIO, Chief Medical Information Officer, Medical Informatics Director, Clinical Informatics (physician-led)

17. "Quality Officer"
    INCLUDES: Chief Quality Officer, VP/Director Quality, Patient Safety, Accreditation, Regulatory Compliance, Risk Management, Infection Control [leadership]

18. "Access/Patient Access"
    INCLUDES: Director Patient Access, Access Management, Scheduling, Registration, Revenue Cycle Access

19. "Case Management"
    INCLUDES: VP/Director Case Management, Care Coordination, Care Management, Discharge Planning, Utilization Review, Transition of Care

20. "Value Based Care"
    INCLUDES: VP/Director Value-Based Care, ACO, HEDIS, Quality Reporting, Value-Based Programs, Risk-Based Contracting

21. "Physician Executive"
    INCLUDES: Medical Directors of a SPECIFIC named clinical department (e.g. "Medical Director, Cardiology", "Medical Director, Radiation Oncology"), Department Chair, Division Chief, Section Chief

22. "Service Line"
    INCLUDES: VP/Director of a NAMED clinical service line: Cardiology, Oncology, Orthopedics, Neurology, Women's Health, Surgical Services, Cancer, Heart & Vascular, Behavioral Health, Rehabilitation, Musculoskeletal, Digestive Health, Spine, Stroke, Trauma

23. "Vendor/Payor"
    INCLUDES: Insurance, pharma, vendors, consultants, investment firms — anyone NOT employed by a health system

═══ PRIORITY ORDER when title matches multiple categories ═══
1. "Nursing" in title → Nursing Officer (beats Operating Officer, Clinical Operations)
2. "Clinical Operations" or "Clinic Operations" in title → Clinical Operations (beats Ambulatory)
3. Explicit "Ambulatory", "Outpatient", "Urgent Care" → Ambulatory/Urgent Care
4. "Chief [Function]" → the functional category
5. "Operations" alone, no qualifier → Operating Officer
6. Specific service line named → Service Line or Physician Executive

═══ RETURN NULL FOR ═══
- Pure admin support: Executive Assistant, Administrative Assistant, Secretary, Coordinator (without "Director/VP/Chief")
- Bedside clinicians: RN, Registered Nurse, Physician/MD with NO Director/VP/Chair/Chief prefix
- Students, interns, residents, fellows, retirees
- Titles too vague to classify at ≥50 confidence

═══ CONFIDENCE ═══
90-100: Title keywords directly and unambiguously map to ONE persona
70-89: Strong match, minor ambiguity
50-69: Best interpretation, notable uncertainty
<50: Return null

Return ONLY a valid JSON array, no markdown, no preamble:
[{"id":"...","persona":"exact persona name or null","confidence":0-100,"reason":"specific title keywords that drove classification"}]

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
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
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
