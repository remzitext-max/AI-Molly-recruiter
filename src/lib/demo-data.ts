// Synthetic demo content. Every value here is fictional and labelled as such.
import type { Fact } from "./knowledge";

export const DEMO_ORG_NAME = "Demo Freight";

export const SYNTHETIC_FACTS: Fact[] = [
  { key: "company.identity", category: "company", title: "Who we are", content: "Demo Freight is a sample carrier used for this demo, and Molly is the recruiter you'd work with.", keywords: ["company", "who"], confirmed: true },
  { key: "pay.cpm", category: "pay", title: "Mileage pay", content: "In this demo offer, pay is 62 cents per mile on all dispatched miles, paid weekly by direct deposit.", keywords: ["pay", "cents", "per mile", "cpm", "weekly"], confirmed: true },
  { key: "home_time.regional", category: "home_time", title: "Regional home time", content: "In this demo offer, regional drivers are home every weekend, usually Friday night through Sunday.", keywords: ["home", "weekend", "home time"], confirmed: true },
  { key: "equipment.trucks", category: "equipment", title: "Trucks", content: "In this demo offer, trucks are 2023 or newer automatic Freightliners with APUs and inverters.", keywords: ["truck", "automatic", "freightliner", "apu", "inverter"], confirmed: true },
  { key: "area.regional", category: "operating_area", title: "Regional lanes", content: "In this demo offer, regional lanes cover Texas, Oklahoma, Arkansas and Louisiana.", keywords: ["lanes", "area", "regional", "states"], confirmed: true },
  { key: "bonus.signon", category: "bonus", title: "Sign-on bonus", content: "", keywords: ["sign on", "bonus", "signing"], confirmed: false },
  { key: "deductions.escrow", category: "deductions", title: "Deductions and escrow", content: "In this demo offer, there is no escrow and no truck lease. Benefit premiums are deducted only if you enroll.", keywords: ["escrow", "deductions", "lease"], confirmed: true },
  { key: "orientation.location", category: "orientation", title: "Orientation", content: "In this demo offer, orientation is two days in Dallas.", keywords: ["orientation"], confirmed: true },
  { key: "travel.orientation", category: "travel", title: "Travel to orientation", content: "In this demo offer, the hotel and bus ticket for orientation are covered.", keywords: ["travel", "hotel", "bus", "ticket"], confirmed: true },
  { key: "requirements.basic", category: "requirements", title: "Basic requirements", content: "In this demo offer, you need a Class A CDL and at least one year of verifiable experience. Molly confirms final eligibility after a safety review.", keywords: ["requirements", "qualify", "experience needed"], confirmed: true },
  { key: "benefits.health", category: "benefits", title: "Health benefits", content: "In this demo offer, medical, dental and vision start after 60 days.", keywords: ["health", "dental", "vision", "insurance", "benefits"], confirmed: true },
  { key: "contact.molly", category: "recruiter_contact", title: "Recruiter availability", content: "Molly is available Monday through Friday, 8 to 5 Central time.", keywords: ["molly", "recruiter", "available", "contact"], confirmed: true },
];

export interface DemoLead { first: string; last: string; phone: string; state: string; zip: string; persona: string; callPermission: boolean }

// 555-01xx style numbers are reserved for fiction; we use valid-format test numbers
// in area codes with 555-01xx where libphonenumber accepts them.
export const DEMO_LEADS: DemoLead[] = [
  { first: "Marcus", last: "Demo-Reed", phone: "(214) 555-0101", state: "TX", zip: "75201", persona: "interested", callPermission: true },
  { first: "Tanya", last: "Demo-Brooks", phone: "(901) 555-0102", state: "TN", zip: "38103", persona: "unknown_question", callPermission: true },
  { first: "Gary", last: "Demo-Hill", phone: "(405) 555-0103", state: "OK", zip: "73102", persona: "opt_out", callPermission: true },
  { first: "Luis", last: "Demo-Ortega", phone: "(602) 555-0104", state: "AZ", zip: "85004", persona: "busy_callback", callPermission: true },
  { first: "Dana", last: "Demo-Price", phone: "(317) 555-0105", state: "IN", zip: "46204", persona: "wants_human", callPermission: true },
  { first: "Ray", last: "Demo-Coleman", phone: "(501) 555-0106", state: "AR", zip: "72201", persona: "wants_human_transfer_fails", callPermission: true },
  { first: "Kim", last: "Demo-Nguyen", phone: "(504) 555-0107", state: "LA", zip: "70112", persona: "voicemail", callPermission: true },
  { first: "Omar", last: "Demo-Hassan", phone: "(614) 555-0108", state: "OH", zip: "43215", persona: "no_answer", callPermission: true },
  { first: "Beth", last: "Demo-Lowry", phone: "(303) 555-0109", state: "CO", zip: "80202", persona: "eligibility", callPermission: true },
  { first: "Victor", last: "Demo-Stone", phone: "(615) 555-0110", state: "TN", zip: "37203", persona: "injection", callPermission: true },
  { first: "Nina", last: "Demo-Park", phone: "(312) 555-0111", state: "IL", zip: "60601", persona: "interested", callPermission: false },
  { first: "Sam", last: "Demo-Ford", phone: "(806) 555-0112", state: "", zip: "", persona: "interested", callPermission: true },
];

export const PREVIEW_SCRIPTS: { kind: string; text: string }[] = [
  { kind: "Introduction", text: "Hi Marcus, this is the AI recruiting assistant for Demo Freight, calling on behalf of Molly, one of our recruiters. You'd reached out about a driving position. Is now an okay time for a few quick questions?" },
  { kind: "Pay question", text: "In this demo offer, pay is 62 cents per mile on all dispatched miles, paid weekly by direct deposit." },
  { kind: "Home-time question", text: "In this demo offer, regional drivers are home every weekend, usually Friday night through Sunday." },
  { kind: "CDL request", text: "Great. The next step is a copy of your CDL so Molly can review it. Can I text a secure upload link to this number?" },
  { kind: "Human handoff", text: "Of course. Let me try to connect you with Molly now. You're now being connected to Molly, a member of our recruiting team." },
  { kind: "Pronunciation check", text: "Class A CDL, hazmat and tanker endorsements, OTR versus regional, reefer and dry van, 62 cents per mile, APU, and a 34-hour reset." },
];
