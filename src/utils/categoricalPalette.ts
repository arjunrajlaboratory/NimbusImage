// Distinct colors for categories (cell types, clusters) in plots. The first
// eighteen are Tableau 20 reordered so neighbours contrast, without its two
// grays (#7f7f7f, #c7c7c7): the scatter plot draws "no value" in gray
// (#777777), which a gray category would be indistinguishable from. Past
// that, hues step by the golden angle so any count stays distinguishable.
const PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#bcbd22",
  "#17becf",
  "#aec7e8",
  "#ffbb78",
  "#98df8a",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
  "#f7b6d2",
  "#dbdb8d",
  "#9edae5",
];

export function categoricalColor(index: number): string {
  if (index < PALETTE.length) {
    return PALETTE[index];
  }
  const hue = Math.round((index * 137.508) % 360);
  return `hsl(${hue}, 65%, 55%)`;
}
