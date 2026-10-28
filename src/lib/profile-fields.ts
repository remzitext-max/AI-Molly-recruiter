// Fields of the driver profile a recruiter can edit. No server imports: the popup (client) uses them too.

/** Driver answers a recruiter can fill in or correct (screening keys). */
export const PROFILE_FIELDS: { key: string; label: string; section: "driver" | "deal" | "employers" }[] = [
  { key: "driving_type", label: "Driver type", section: "driver" },
  { key: "experience_years", label: "Experience", section: "driver" },
  { key: "work_type", label: "OTR / local", section: "driver" },
  { key: "equipment_experience", label: "Equipment", section: "driver" },
  { key: "cdl_class", label: "CDL class", section: "driver" },
  { key: "endorsements", label: "Endorsements", section: "driver" },
  { key: "sap_history", label: "SAP program", section: "driver" },
  { key: "accident_details", label: "Accidents", section: "driver" },
  { key: "med_card_expiry", label: "Medical card expires", section: "driver" },
  { key: "english_level", label: "English", section: "driver" },
  { key: "rate_expectation", label: "Rate expectation", section: "deal" },
  { key: "home_time", label: "Home time", section: "deal" },
  { key: "weekly_miles", label: "Can drive", section: "deal" },
  { key: "start_date", label: "Ready date", section: "deal" },
  { key: "offer_interest", label: "Interest in offer", section: "deal" },
  { key: "concerns", label: "Concerns / notes", section: "deal" },
  { key: "recent_companies", label: "Previous employers (one per line: company, dates)", section: "employers" },
];
/** Lead columns a recruiter can correct. */
export const BASIC_FIELDS: { key: "firstName" | "lastName" | "email" | "state"; label: string }[] = [
  { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" }, { key: "email", label: "Email" }, { key: "state", label: "State" },
];
