export function accessLevelLabel(level: number): string {
  switch (level) {
    case 0:
      return "Read";
    case 1:
      return "Write";
    case 2:
      return "Admin";
    default:
      return "Unknown";
  }
}

export function accessLevelColor(level: number): string {
  switch (level) {
    case 0:
      return "blue";
    case 1:
      return "orange";
    case 2:
      return "red darken-1";
    default:
      return "grey";
  }
}
