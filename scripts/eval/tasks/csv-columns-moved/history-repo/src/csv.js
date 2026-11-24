export function splitCsvRow(line) {
  const text = String(line);
  if (text.startsWith('"') && text.endsWith('"') && text.includes('","')) {
    return text.slice(1, -1).split('","');
  }
  return text.split(",");
}
