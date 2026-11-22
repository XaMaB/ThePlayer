/** Display exact DASH timeline/range integers without mutating engine metadata. */
export function diagnosticJson(value) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === 'bigint' ? item.toString() : item),
    2,
  );
}
