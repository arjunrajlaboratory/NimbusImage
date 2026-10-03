// Build a CSS linear-gradient from a list of color stops. Used by the
// color-by-property dialog's colormap previews and the viewer legend's ramp —
// both horizontal — so the two never drift on gradient syntax.
export function cssLinearGradient(
  stops: string[],
  direction: "to right",
): string {
  return `linear-gradient(${direction}, ${stops.join(", ")})`;
}
