import { FIELDS } from "./schema.generated.js";

export function validate(record) {
  for (const key of Object.keys(record)) {
    if (!FIELDS.has(key)) {
      throw new Error(`unknown field ${JSON.stringify(key)}`);
    }
  }
  return true;
}
