import type { IntegrationStatus, DocumentExtractor } from "../types";

export class NoExtraction implements DocumentExtractor {
  key = "none";
  status(): IntegrationStatus {
    return { kind: "extraction", provider: "None", isMock: false, state: "not_implemented", detail: "No OCR provider configured. Recruiters review documents manually." };
  }
  async extract() { return { fields: [], warnings: ["No extraction provider configured."] }; }
}
