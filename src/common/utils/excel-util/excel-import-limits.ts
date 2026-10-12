export const EXCEL_IMPORT_LIMITS = Object.freeze({
  fileSize: 5 * 1024 * 1024,
  files: 1,
  // Busboy emits partsLimit at this count; files/fields allow only one file part.
  parts: 2,
  fields: 0,
  worksheets: 5,
  rows: 1000,
  columns: 50,
  archiveEntries: 256,
  expandedSize: 20 * 1024 * 1024,
  cells: 50_000,
  xmlNodes: 200_000,
  xmlDepth: 64,
});
