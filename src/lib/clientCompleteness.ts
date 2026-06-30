// Fields required for a complete BL / delivery document
const REQUIRED_FIELDS: Array<{ key: string; label: string }> = [
  { key: "address",      label: "Adresse" },
  { key: "postal_code",  label: "Code postal" },
  { key: "city",         label: "Ville" },
  { key: "contact_name", label: "Contact" },
  { key: "phone",        label: "Téléphone" },
  { key: "email",        label: "E-mail" },
];

export type ClientCompletenessResult = {
  complete: boolean;
  missingFields: string[];
  score: number; // 0–100
};

export function clientMissingFields(client: Record<string, any> | null | undefined): string[] {
  if (!client) return REQUIRED_FIELDS.map((f) => f.label);
  return REQUIRED_FIELDS.filter((f) => !client[f.key]?.toString().trim()).map((f) => f.label);
}

export function clientCompleteness(client: Record<string, any> | null | undefined): ClientCompletenessResult {
  const missingFields = clientMissingFields(client);
  const score = Math.round(((REQUIRED_FIELDS.length - missingFields.length) / REQUIRED_FIELDS.length) * 100);
  return { complete: missingFields.length === 0, missingFields, score };
}
