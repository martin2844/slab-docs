const MAX_SLUG_LENGTH = 100;

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  return slug || "document";
}

export function slugWithSuffix(base: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 2) {
    throw new RangeError("Slug sequence must be an integer greater than one.");
  }

  const suffix = `-${sequence}`;
  const prefix = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, "");
  return `${prefix || "document"}${suffix}`;
}
