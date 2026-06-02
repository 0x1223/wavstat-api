export const STEM_COLORS = [
  { wave: "#6d6457", progress: "#d6a354" },
  { wave: "#415869", progress: "#6ea8c8" },
  { wave: "#416348", progress: "#6eb87a" },
  { wave: "#5e4569", progress: "#b06ec8" },
  { wave: "#634535", progress: "#c87a5a" },
  { wave: "#5e5630", progress: "#c8b550" },
  { wave: "#305f5f", progress: "#50a8a8" },
  { wave: "#5a3535", progress: "#a85050" },
];

export function getStemColor(index) {
  return STEM_COLORS[index % STEM_COLORS.length];
}
